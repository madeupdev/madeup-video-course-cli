export type RecoveryState = {
  id: string;
  sourceCommit: string;
  asset: string;
  sha256: string;
  verification: string[];
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
  };
  release: {
    repository: string;
    tag: string;
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
