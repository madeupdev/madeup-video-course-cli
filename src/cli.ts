#!/usr/bin/env node

export type CliIo = {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
};

const HELP_TEXT = `Prepared-code and project-recovery infrastructure for the Made Up Video advanced monorepos course.

Usage:
  madeup-video-course <command>

Planned learner-facing commands:
  apply <recipe>
  apply <recipe> --dry-run
  doctor
  recover <state> --directory <new-directory>`;

export async function runCli(
  args: readonly string[],
  io: CliIo,
): Promise<number> {
  if (args.length === 1 && args[0] === '--help') {
    io.stdout(HELP_TEXT);
    return 0;
  }

  const command = args[0] ?? '(none)';
  io.stderr(
    `Unknown command: ${command}\nRun madeup-video-course --help for the planned learner-facing commands.`,
  );
  return 1;
}

if (import.meta.main) {
  process.exitCode = await runCli(process.argv.slice(2), {
    stdout: (text) => process.stdout.write(`${text}\n`),
    stderr: (text) => process.stderr.write(`${text}\n`),
  });
}
