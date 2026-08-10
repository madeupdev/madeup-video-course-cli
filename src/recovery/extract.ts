import { createReadStream } from 'node:fs';
import { chmod, lstat, mkdir, open, rm } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';

import { extract } from 'tar-stream';
import type { Headers } from 'tar-stream';

import { containsAsciiControl, filesystemCollisionKey, findPortableFilenameIssue } from '../path/portable.js';

function isWithinRoot(root: string, target: string): boolean {
  const fromRoot = relative(root, target);
  return fromRoot === '' || (!isAbsolute(fromRoot) && fromRoot !== '..' && !fromRoot.startsWith(`..${sep}`));
}

function safeEntryPath(root: string, header: Headers): { relativePath: string; target: string } {
  const rawPath = header.name;
  const relativePath = header.type === 'directory' ? rawPath.replace(/\/+$/u, '') : rawPath;
  let reason: string | undefined;
  if (relativePath.length === 0 || relativePath === '.') reason = 'empty normalized path';
  else if (relativePath !== relativePath.normalize('NFC')) reason = 'non-NFC path';
  else if (containsAsciiControl(relativePath)) reason = 'control character';
  else if (relativePath.startsWith('/')) reason = 'absolute path';
  else if (/^[A-Za-z]:/u.test(relativePath)) reason = 'Windows drive path';
  else if (relativePath.startsWith('\\')) reason = 'leading backslash path';
  else if (relativePath.includes('\\')) reason = 'backslash separator';
  else {
    const segments = relativePath.split('/');
    if (segments.some((segment) => segment.length === 0)) reason = 'empty path segment';
    else if (segments.some((segment) => segment === '.')) reason = 'current-directory segment';
    else if (segments.some((segment) => segment === '..')) reason = 'parent traversal';
    else reason = segments.map((segment) => findPortableFilenameIssue(segment)?.message).find((issue) => issue !== undefined);
  }
  if (reason !== undefined) {
    throw new Error(`Unsafe recovery archive entry ${JSON.stringify(rawPath)}: ${reason}`);
  }
  const target = resolve(root, ...relativePath.split('/'));
  if (!isWithinRoot(root, target)) {
    throw new Error(`Recovery archive entry resolves outside extraction directory: ${rawPath}`);
  }
  return { relativePath, target };
}

async function writeEntryFile(
  stream: NodeJS.ReadableStream,
  target: string,
  mode: number,
): Promise<void> {
  await mkdir(resolve(target, '..'), { recursive: true });
  const handle = await open(target, 'wx', 0o600);
  try {
    for await (const chunk of stream) {
      await handle.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    await handle.sync();
  } finally {
    await handle.close();
  }
  await chmod(target, mode & 0o777);
}

export async function extractRecoveryArchive(archivePath: string, destination: string): Promise<void> {
  let created = false;
  try {
    await mkdir(destination, { recursive: false, mode: 0o700 });
    created = true;
    const parser = extract();
    const seen = new Set<string>();

    parser.on('entry', (header, stream, next) => {
      void (async () => {
        if (header.type !== 'file' && header.type !== 'directory') {
          throw new Error(`Unsupported recovery archive entry type ${header.type} for ${header.name}`);
        }
        if (header.mode === undefined || !Number.isSafeInteger(header.mode) || header.mode < 0) {
          throw new Error(`Recovery archive entry has an invalid mode: ${header.name}`);
        }
        const mode = header.mode;
        const entry = safeEntryPath(destination, header);
        const key = filesystemCollisionKey(entry.relativePath);
        if (seen.has(key)) {
          throw new Error(`Duplicate recovery archive entry: ${entry.relativePath}`);
        }
        seen.add(key);

        if (header.type === 'directory') {
          stream.resume();
          await mkdir(entry.target, { recursive: true, mode: mode & 0o777 });
          const entryStat = await lstat(entry.target);
          if (!entryStat.isDirectory() || entryStat.isSymbolicLink()) {
            throw new Error(`Recovery archive directory conflicts with another entry: ${entry.relativePath}`);
          }
          await chmod(entry.target, mode & 0o777);
        } else {
          await writeEntryFile(stream, entry.target, mode);
        }
      })().then(() => next(), (error: unknown) => parser.destroy(error instanceof Error ? error : new Error(String(error))));
    });

    await pipeline(createReadStream(archivePath), createGunzip(), parser);
  } catch (error) {
    if (created) {
      await rm(destination, { force: true, recursive: true });
    }
    throw error;
  }
}
