import { pathToFileURL } from 'node:url';
import { formatCliError } from './output';
import { runCli, type CliRunResult } from './runner';

export type CliOutputWriters = {
  stdout: (line: string) => void;
  stderr: (line: string) => void;
};

async function main() {
  const result = await runCli(process.argv.slice(2));
  writeCliRunResult(result);
  setExitCode(result.exitCode);
}

export function writeCliRunResult(
  result: CliRunResult,
  writers: CliOutputWriters = {
    stdout: (line) => console.log(line),
    stderr: (line) => console.error(line)
  }
): void {
  for (const line of result.stdout) {
    writers.stdout(line);
  }

  for (const line of result.stderr) {
    writers.stderr(line);
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
