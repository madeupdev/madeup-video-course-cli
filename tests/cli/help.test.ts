import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, vi } from 'vitest';

import { runCli } from '../../src/cli.js';

describe('course CLI help', () => {
  it('lists only the approved learner-facing commands', async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation(() => undefined as never);

    const exitCode = await runCli(['--help'], {
      stdout: (text) => stdout.push(text),
      stderr: (text) => stderr.push(text),
    });
    const help = stdout.join('\n');

    expect(exitCode).toBe(0);
    expect(stderr).toEqual([]);
    expect(help).toContain('Made Up Video advanced monorepos course');
    expect(help).toContain('apply <recipe>');
    expect(help).toContain('apply <recipe> --dry-run');
    expect(help).toContain('doctor');
    expect(help).toContain(
      'recover <state> --directory <new-directory>',
    );
    expect(help).not.toContain('publish');
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('returns concise guidance for an unknown command', async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];

    const exitCode = await runCli(['something-else'], {
      stdout: (text) => stdout.push(text),
      stderr: (text) => stderr.push(text),
    });

    expect(exitCode).not.toBe(0);
    expect(stdout).toEqual([]);
    expect(stderr.join('\n')).toContain('Unknown command: something-else');
    expect(stderr.join('\n')).toContain('madeup-video-course --help');
  });

  it('recognises execution through an installed bin symlink', async () => {
    const temporaryDirectory = await mkdtemp(
      join(tmpdir(), 'madeup-video-course-cli-'),
    );
    const targetPath = fileURLToPath(
      new URL('../../src/cli.ts', import.meta.url),
    );
    const binPath = join(temporaryDirectory, 'madeup-video-course');

    try {
      await symlink(targetPath, binPath);
      const result = spawnSync(process.execPath, [binPath, '--help'], {
        encoding: 'utf8',
      });

      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      expect(result.stderr).toBe('');
      expect(result.stdout).toContain('apply <recipe>');
    } finally {
      await rm(temporaryDirectory, { force: true, recursive: true });
    }
  });
});
