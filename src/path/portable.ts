const windowsInvalidFilenamePattern = /[<>:"|?*]/;
const windowsReservedBasenamePattern =
  /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i;

export type PortableFilenameIssueKind =
  | 'control-character'
  | 'windows-invalid-filename-character'
  | 'trailing-space-or-period'
  | 'windows-reserved-device-basename';

export type PortableFilenameIssue = {
  kind: PortableFilenameIssueKind;
  message: string;
};

export function filesystemCollisionKey(value: string): string {
  return value.normalize('NFC').toLowerCase();
}

export function containsAsciiControl(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit <= 0x1f || codeUnit === 0x7f) {
      return true;
    }
  }

  return false;
}

export function findPortableFilenameIssue(
  value: string,
): PortableFilenameIssue | undefined {
  if (containsAsciiControl(value)) {
    return {
      kind: 'control-character',
      message: 'Must not contain ASCII control characters',
    };
  }
  if (windowsInvalidFilenamePattern.test(value)) {
    return {
      kind: 'windows-invalid-filename-character',
      message: 'Must not contain characters that are invalid in Windows filenames',
    };
  }
  if (value.endsWith(' ') || value.endsWith('.')) {
    return {
      kind: 'trailing-space-or-period',
      message: 'Must not end in a space or period',
    };
  }
  if (windowsReservedBasenamePattern.test(value)) {
    return {
      kind: 'windows-reserved-device-basename',
      message: 'Must not use a Windows reserved device basename',
    };
  }

  return undefined;
}
