import {
  buildPrTag,
  createReleaseTag,
  getDashboard
} from '../lib/server/github';
import { getAuditReport } from '../lib/server/audit';
import { readConfig } from '../lib/server/config';
import { normalizeRepoSlug } from '../lib/repositories';
import { HELP, parseCommandLine } from './options';
import {
  auditExitCode,
  formatAuditReport,
  formatBuildPrResult,
  formatCliError,
  formatDashboard,
  formatReleaseTagResult,
  formatRepositoryErrors,
  readErrorExitCode,
  selectDashboardJson
} from './output';

async function main() {
  const commandLine = parseCommandLine(process.argv.slice(2));

  if (commandLine.kind === 'help') {
    console.log(HELP);
    return;
  }

  const { command, options } = commandLine;
  const baseConfig = readConfig();

  if (command === 'build-pr') {
    if (options.positionals.length !== 1 || !options.pr) {
      throw new Error('build-pr requires exactly one <repo> and --pr <number>.');
    }

    const result = await buildPrTag(baseConfig, {
      repo: options.positionals[0],
      prNumber: options.pr,
      tagName: options.tag,
      confirm: options.confirm,
      force: options.force,
      allowDraft: options.allowDraft,
      allowFork: options.allowFork,
      allowNonDefaultBase: options.allowNonDefaultBase
    });

    if (options.json) {
      printJson(result);
      return;
    }

    console.log(formatBuildPrResult(result));
    return;
  }

  if (command === 'release-tag') {
    if (options.positionals.length !== 1 || !options.tag) {
      throw new Error('release-tag requires exactly one <repo> and --tag <v*>.');
    }

    const result = await createReleaseTag(baseConfig, {
      repo: options.positionals[0],
      tagName: options.tag,
      targetRef: options.targetRef,
      confirm: options.confirm,
      force: options.force
    });

    if (options.json) {
      printJson(result);
      return;
    }

    console.log(formatReleaseTagResult(result));
    return;
  }

  if (options.positionals.length > 0) {
    throw new Error(`${command} does not accept positional arguments.`);
  }

  const config = {
    ...baseConfig,
    repos: options.repo ? [normalizeRepoSlug(options.repo, baseConfig.owner)] : baseConfig.repos,
    discoverRepos: options.discover || baseConfig.discoverRepos
  };

  if (command === 'audit') {
    const report = await getAuditReport(config);

    if (options.json) {
      printJson(report);
      setExitCode(auditExitCode(report));
      return;
    }

    console.log(formatAuditReport(report));
    setExitCode(auditExitCode(report));
    return;
  }

  const dashboard = await getDashboard(config);

  if (options.json) {
    printJson(selectDashboardJson(command, dashboard));
    setExitCode(readErrorExitCode(dashboard));
    return;
  }

  console.log(formatDashboard(command, dashboard));
  const repositoryErrors = formatRepositoryErrors(dashboard);
  if (repositoryErrors) {
    console.error(repositoryErrors);
  }
  setExitCode(readErrorExitCode(dashboard));
}

function printJson(value: unknown) {
  console.log(JSON.stringify(value, null, 2));
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
