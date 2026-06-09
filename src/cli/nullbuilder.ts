import { formatCliError } from './output';
import { runCli } from './runner';

async function main() {
  const result = await runCli(process.argv.slice(2));
  result.stdout.forEach((line) => console.log(line));
  result.stderr.forEach((line) => console.error(line));
  setExitCode(result.exitCode);
}

function setExitCode(exitCode: number | null): void {
  if (exitCode !== null) {
    process.exitCode = exitCode;
  }
}

main().catch((error: unknown) => {
  console.error(formatCliError(error));
  process.exit(1);
});
