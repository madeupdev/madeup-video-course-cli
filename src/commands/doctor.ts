import type { CourseManifest } from '../manifest/types.js';
import { findProjectRoot } from '../project/find-root.js';
import { inspectGitRepository } from '../project/git.js';
import {
  classifyCourseState,
  inspectCourseTree,
} from '../state/classify.js';
import type {
  CourseStateClassification,
  CourseTreeInspectionFinding,
} from '../state/classify.js';

export type DoctorIo = {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
};

export type DoctorOptions = {
  startDirectory: string;
  workingBoundary: string;
  manifest: CourseManifest;
  cliVersion: string;
  nodeVersion: string;
  expectedNodeVersion: string;
  platform: NodeJS.Platform;
};

type DoctorProjectFailure =
  | {
      kind: 'wrong-project';
      expectedPackageName: '@madeup-video/storefront';
      actualPackageName?: string;
    }
  | {
      kind: 'project-unavailable';
      finding: unknown;
    };

type DoctorDiagnosis =
  | CourseStateClassification
  | DoctorProjectFailure
  | {
      kind: 'inspection-failed';
      finding: CourseTreeInspectionFinding;
    };

export type DoctorResult = {
  exitCode: 0 | 1;
  diagnosis: DoctorDiagnosis;
  environment: {
    compatible: boolean;
    actualNodeVersion: string;
    expectedNodeVersion: string;
  };
  worktree?:
    | { kind: 'clean' }
    | { kind: 'dirty'; changes: number }
    | { kind: 'unavailable'; finding: unknown };
};

function projectFailure(
  finding: Awaited<ReturnType<typeof findProjectRoot>> extends infer Result
    ? Result extends { ok: false; finding: infer Finding }
      ? Finding
      : never
    : never,
): DoctorProjectFailure {
  if (finding.kind === 'wrong-package-name') {
    return {
      kind: 'wrong-project',
      expectedPackageName: finding.expectedPackageName,
      actualPackageName: finding.actualPackageName,
    };
  }
  return {
    kind: 'project-unavailable',
    finding,
  };
}

function printMismatches(
  diagnosis: Extract<CourseStateClassification, { kind: 'unknown' }>,
  io: DoctorIo,
): void {
  io.stderr(`Nearest recovery state: ${diagnosis.nearestState}`);
  for (const mismatch of diagnosis.mismatches) {
    if (mismatch.kind === 'mode-mismatched') {
      io.stderr(
        `MODE ${mismatch.path} (expected ${mismatch.expectedMode.toString(8)}, found ${mismatch.actualMode.toString(8)})`,
      );
    } else {
      io.stderr(`${mismatch.kind.toUpperCase()} ${mismatch.path}`);
    }
  }
}

export async function runDoctor(
  options: DoctorOptions,
  io: DoctorIo,
): Promise<DoctorResult> {
  const environment = {
    compatible: options.nodeVersion === options.expectedNodeVersion,
    actualNodeVersion: options.nodeVersion,
    expectedNodeVersion: options.expectedNodeVersion,
  };
  const project = await findProjectRoot(
    options.startDirectory,
    options.workingBoundary,
  );
  if (!project.ok) {
    const diagnosis = projectFailure(project.finding);
    if (diagnosis.kind === 'wrong-project') {
      io.stderr(
        `Expected ${diagnosis.expectedPackageName}, found ${diagnosis.actualPackageName ?? 'an unknown package'}.`,
      );
    } else {
      io.stderr(`Unable to locate the course project: ${project.finding.kind}`);
    }
    return { exitCode: 1, diagnosis, environment };
  }

  const git = await inspectGitRepository(project.root);
  const worktree: NonNullable<DoctorResult['worktree']> = git.ok
    ? git.clean
      ? { kind: 'clean' }
      : { kind: 'dirty', changes: git.changes.length }
    : { kind: 'unavailable', finding: git.finding };

  const inspectedTree = await inspectCourseTree(
    project.root,
    options.manifest.project.localArtifacts,
    { platform: options.platform },
  );
  if (!inspectedTree.ok) {
    const diagnosis: DoctorDiagnosis = {
      kind: 'inspection-failed',
      finding: inspectedTree.finding,
    };
    io.stderr(
      `Unable to inspect the course-managed tree: ${inspectedTree.finding.kind}`,
    );
    return { exitCode: 1, diagnosis, environment, worktree };
  }

  const diagnosis = classifyCourseState(
    options.manifest,
    inspectedTree.files,
    { platform: options.platform },
  );

  io.stdout(`Project: ${project.packageName}`);
  io.stdout(`Course CLI: ${options.cliVersion}`);
  io.stdout(
    `Node: ${options.nodeVersion}${environment.compatible ? '' : ` (expected ${options.expectedNodeVersion})`}`,
  );
  if (diagnosis.kind === 'exact' || diagnosis.kind === 'applicable') {
    io.stdout(`Detected state: ${diagnosis.state}`);
    if (diagnosis.kind === 'applicable') {
      io.stdout(`Next prepared step: ${diagnosis.recipe}`);
    } else if (diagnosis.availableRecipes !== undefined) {
      io.stdout(`Prepared steps: ${diagnosis.availableRecipes.join(', ')}`);
    }
  } else if (diagnosis.kind === 'unknown') {
    io.stdout('Detected state: unknown');
    printMismatches(diagnosis, io);
  } else {
    io.stdout('Detected state: ambiguous');
    io.stderr(`Equally near recovery states: ${diagnosis.states.join(', ')}`);
  }
  io.stdout(
    worktree.kind === 'clean'
      ? 'Worktree: clean'
      : worktree.kind === 'dirty'
        ? `Worktree: dirty (${worktree.changes} change${worktree.changes === 1 ? '' : 's'})`
        : 'Worktree: unavailable',
  );

  const recognised = diagnosis.kind === 'exact' || diagnosis.kind === 'applicable';
  return {
    exitCode:
      recognised && environment.compatible && worktree.kind !== 'dirty' ? 0 : 1,
    diagnosis,
    environment,
    worktree,
  };
}
