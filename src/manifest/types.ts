export type CourseTreeFile = {
  path: string;
  mode: 0o644 | 0o755;
  sha256: string;
};

export type CourseTree = {
  algorithm: 'course-tree-v1';
  files: CourseTreeFile[];
};

export type RecoveryState = {
  id: string;
  sourceCommit: string;
  asset: string;
  sha256: string;
  tree: CourseTree;
  verification: string[];
};

export type LocalArtifactRule =
  | {
      type: 'file';
      path: string;
    }
  | {
      type: 'directory';
      path: string;
    }
  | {
      type: 'directory-name';
      name: string;
    }
  | {
      type: 'file-suffix';
      suffix: string;
    };

export type AddOperation = {
  type: 'add';
  destination: string;
  template: string;
  afterSha256: string;
  mode: number;
};

export type ReplaceOperation = {
  type: 'replace';
  destination: string;
  template: string;
  beforeSha256: string;
  afterSha256: string;
  mode: number;
};

export type DeleteOperation = {
  type: 'delete';
  destination: string;
  beforeSha256: string;
};

export type Recipe = {
  id: string;
  description: string;
  expectedPackageName: '@madeup-video/storefront';
  startingState: string;
  resultState: string;
  operations: Array<AddOperation | ReplaceOperation | DeleteOperation>;
  verification: string[];
};

export type CourseManifest = {
  schemaVersion: 1;
  courseVersion: string;
  project: {
    packageName: '@madeup-video/storefront';
    repository: string;
    localArtifacts: LocalArtifactRule[];
  };
  release: {
    repository: string;
    tag: string;
    maxAssetBytes: number;
  };
  recoveryStates: RecoveryState[];
  recipes: Recipe[];
};

export type ManifestIssue = {
  path: string;
  message: string;
};

export type ManifestValidationResult =
  | {
      ok: true;
      manifest: CourseManifest;
    }
  | {
      ok: false;
      issues: ManifestIssue[];
    };
