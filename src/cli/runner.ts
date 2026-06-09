import { getAuditReport } from '../lib/server/audit';
import { readConfig } from '../lib/server/config';
import { buildPrTag, createReleaseTag, getDashboard } from '../lib/server/github';
import { normalizeRepoSlug } from '../lib/repositories';
import { HELP, parseCommandLine } from './options';
import {
  auditExitCode,
  formatAuditReport,
  formatBuildPrResult,
  formatDashboard,
  formatReleaseTagResult,
  formatRepositoryErrors,
  readErrorExitCode,
  selectDashboardJson
} from './output';

export type CliDependencies = {
  readConfig: typeof readConfig;
  getDashboard: typeof getDashboard;
  getAuditReport: typeof getAuditReport;
  buildPrTag: typeof buildPrTag;
  createReleaseTag: typeof createReleaseTag;
};

export type CliRunResult = {
  stdout: string[];
  stderr: string[];
  exitCode: number | null;
};

export const cliDependencies: CliDependencies = {
  readConfig,
  getDashboard,
  getAuditReport,
  buildPrTag,
  createReleaseTag
};

export async function runCli(
  argv: readonly string[],
  dependencies: CliDependencies = cliDependencies
): Promise<CliRunResult> {
  const commandLine = parseCommandLine(argv);
  const result: CliRunResult = {
    stdout: [],
    stderr: [],
    exitCode: null
  };

  if (commandLine.kind === 'help') {
    result.stdout.push(HELP);
    return result;
  }

  const { command, options } = commandLine;
  const baseConfig = dependencies.readConfig();

  if (command === 'build-pr') {
    if (options.positionals.length !== 1 || !options.pr) {
      throw new Error('build-pr requires exactly one <repo> and --pr <number>.');
    }

    const tag = await dependencies.buildPrTag(baseConfig, {
      repo: options.positionals[0],
      prNumber: options.pr,
      tagName: options.tag,
      confirm: options.confirm,
      force: options.force,
      allowDraft: options.allowDraft,
      allowFork: options.allowFork,
      allowNonDefaultBase: options.allowNonDefaultBase
    });

    result.stdout.push(options.json ? formatJson(tag) : formatBuildPrResult(tag));
    return result;
  }

  if (command === 'release-tag') {
    if (options.positionals.length !== 1 || !options.tag) {
      throw new Error('release-tag requires exactly one <repo> and --tag <v*>.');
    }

    const tag = await dependencies.createReleaseTag(baseConfig, {
      repo: options.positionals[0],
      tagName: options.tag,
      targetRef: options.targetRef,
      confirm: options.confirm,
      force: options.force
    });

    result.stdout.push(options.json ? formatJson(tag) : formatReleaseTagResult(tag));
    return result;
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
    const report = await dependencies.getAuditReport(config);
    result.exitCode = auditExitCode(report);
    result.stdout.push(options.json ? formatJson(report) : formatAuditReport(report));
    return result;
  }

  const dashboard = await dependencies.getDashboard(config);
  result.exitCode = readErrorExitCode(dashboard);

  if (options.json) {
    result.stdout.push(formatJson(selectDashboardJson(command, dashboard)));
    return result;
  }

  result.stdout.push(formatDashboard(command, dashboard));
  const repositoryErrors = formatRepositoryErrors(dashboard);
  if (repositoryErrors) {
    result.stderr.push(repositoryErrors);
  }

  return result;
}

function formatJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}
