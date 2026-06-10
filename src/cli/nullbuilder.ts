import { pathToFileURL } from 'node:url';
import { formatCliError } from './output';
import { runCli, type CliRunResult } from './runner';

export type CliOutputWriters = {
  stdout: (line: string) => void;
  stderr: (line: string) => void;
};

async function main() {
  const result = await runCli(readCliArgTail(process.argv));
  writeCliRunResult(result);
  setExitCode(result.exitCode);
}

export function readCliArgTail(argv: readonly string[]): string[] {
  const args: string[] = [];
  for (let index = 2; index < argv.length; index += 1) {
    args[args.length] = argv[index];
  }

  return args;
}

export function writeCliRunResult(
  result: CliRunResult,
  writers: CliOutputWriters = {
    stdout: (line) => console.log(line),
    stderr: (line) => console.error(line)
  }
): void {
  writeLines(result.stdout, writers.stdout);
  writeLines(result.stderr, writers.stderr);
}

function writeLines(lines: readonly string[], write: (line: string) => void): void {
  for (let index = 0; index < lines.length; index += 1) {
    write(lines[index]);
  }
}

export function isCliEntrypoint(moduleUrl: string, argvPath: string | undefined = process.argv[1]): boolean {
  return argvPath !== undefined && pathToFileURL(argvPath).href === moduleUrl;
}

function setExitCode(exitCode: number | null): void {
  if (exitCode !== null) {
    process.exitCode = exitCode;
  }
}

if (isCliEntrypoint(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(formatCliError(error));
    process.exit(1);
  });
}
