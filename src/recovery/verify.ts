import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

import type { CourseTreeFile } from '../manifest/types.js';
import { inspectCourseTree } from '../state/classify.js';

function expectedDirectoryPaths(files: readonly CourseTreeFile[]): Set<string> {
  const directories = new Set<string>();
  for (const file of files) {
    const segments = file.path.split('/');
    segments.pop();
    for (let length = 1; length <= segments.length; length += 1) {
      directories.add(segments.slice(0, length).join('/'));
    }
  }
  return directories;
}

async function actualDirectoryPaths(root: string): Promise<string[]> {
  const directories: string[] = [];
  async function visit(directory: string, relativeDirectory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      directories.push(relativePath);
      await visit(join(directory, entry.name), relativePath);
    }
  }
  await visit(root, '');
  return directories.sort();
}

export async function verifyRecoveryTree(
  directory: string,
  expectedFiles: readonly CourseTreeFile[],
  platform: NodeJS.Platform,
): Promise<void> {
  const inspected = await inspectCourseTree(directory, [], { platform });
  if (!inspected.ok) {
    const findingPath = 'path' in inspected.finding
      ? inspected.finding.path
      : inspected.finding.paths.join(', ');
    throw new Error(`Unable to verify recovery tree at ${findingPath}: ${inspected.finding.kind}`);
  }
  const actualByPath = new Map(inspected.files.map((file) => [file.path, file]));
  const expectedByPath = new Map(expectedFiles.map((file) => [file.path, file]));
  const mismatches: string[] = [];

  for (const expected of expectedFiles) {
    const actual = actualByPath.get(expected.path);
    if (actual === undefined) mismatches.push(`missing ${expected.path}`);
    else if (actual.sha256 !== expected.sha256) mismatches.push(`modified ${expected.path}`);
    else if (platform !== 'win32' && actual.mode !== expected.mode) {
      mismatches.push(`mode mismatch ${expected.path}: expected ${expected.mode.toString(8)}, received ${actual.mode.toString(8)}`);
    }
  }
  for (const actual of inspected.files) {
    if (!expectedByPath.has(actual.path)) mismatches.push(`unexpected ${actual.path}`);
  }
  const expectedDirectories = expectedDirectoryPaths(expectedFiles);
  for (const actualDirectory of await actualDirectoryPaths(directory)) {
    if (!expectedDirectories.has(actualDirectory)) mismatches.push(`unexpected directory ${actualDirectory}`);
  }
  if (mismatches.length > 0) {
    throw new Error(`Recovery tree verification failed: ${mismatches.join('; ')}`);
  }
}
