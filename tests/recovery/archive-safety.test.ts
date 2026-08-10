import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { extractRecoveryArchive } from '../../src/recovery/extract.js';
import { tarGzip, type TarFixtureEntry } from './tar-fixture.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })));
});

async function fixture(entry: TarFixtureEntry): Promise<{ archive: string; destination: string; root: string }> {
  const root = await mkdtemp(join(tmpdir(), 'course-recovery-archive-'));
  temporaryDirectories.push(root);
  const archive = join(root, 'fixture.tar.gz');
  const destination = join(root, 'extracting');
  await writeFile(archive, tarGzip([entry]));
  return { archive, destination, root };
}

describe('recovery archive safety', () => {
  it.each([
    ['absolute POSIX path', { name: '/etc/passwd' }],
    ['Windows drive path', { name: 'C:/outside.txt' }],
    ['leading backslash path', { name: String.raw`\\server\share\outside.txt` }],
    ['backslash separator', { name: String.raw`dir\outside.txt` }],
    ['parent traversal', { name: '../outside.txt' }],
    ['nested traversal resolving outside', { name: 'inside/../../outside.txt' }],
    ['empty normalized path', { name: './', type: '5' }],
    ['hard link', { name: 'hard-link', type: '1', linkname: 'target' }],
    ['symbolic link', { name: 'symbolic-link', type: '2', linkname: 'target' }],
    ['character device', { name: 'character-device', type: '3' }],
    ['block device', { name: 'block-device', type: '4' }],
    ['FIFO', { name: 'fifo', type: '6' }],
    ['other special file', { name: 'contiguous', type: '7' }],
  ] as const)('rejects an entry containing an unsafe %s', async (_label, entry) => {
    const { archive, destination, root } = await fixture(entry);

    await expect(extractRecoveryArchive(archive, destination)).rejects.toThrow();
    expect(await readdir(root)).toEqual(['fixture.tar.gz']);
  });
});
