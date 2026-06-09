import {
  buildPrTag,
  createReleaseTag,
  getDashboard,
  GitHubApiError,
  publicErrorMessage,
  type DashboardData,
  type RepositorySummary
} from '../lib/server/github';
import { getAuditReport, type AuditFinding, type AuditReport, type AuditSeverity } from '../lib/server/audit';
import { readConfig } from '../lib/server/config';
import { normalizeRepoSlug } from '../lib/repositories';

type Command = 'repos' | 'issues' | 'prs' | 'runs' | 'stars' | 'audit' | 'build-pr' | 'release-tag';

type CliOptions = {
  json: boolean;
  repo?: string;
  discover: boolean;
  pr?: number;
  tag?: string;
  targetRef?: string;
  confirm: boolean;
  force: boolean;
  allowDraft: boolean;
  allowFork: boolean;
  allowNonDefaultBase: boolean;
  positionals: string[];
};

const COMMANDS = new Set<Command>(['repos', 'issues', 'prs', 'runs', 'stars', 'audit', 'build-pr', 'release-tag']);

const HELP = `Usage: nullbuilder <command> [options]

Commands:
  repos                 Show configured repositories and latest CI/nightly/release status
  issues                Show open issues across configured repositories
  prs                   Show open pull requests across configured repositories
  runs                  Show latest CI/nightly/release runs across repositories
  stars                 Show current stars and recent growth
  audit                 Check repository policy, workflow, and security posture
  build-pr <repo>       Create a build-pr-* tag on a pull request head SHA
  release-tag <repo>    Create a v* release tag on the default branch, branch, or SHA

Options:
  --repo <repo>         Filter list commands by repository name or owner/name
  --discover           Include discovered public Zig/null repositories for NULLBUILDER_OWNER
  --json                Print JSON
  --pr <number>         Pull request number for build-pr
  --tag <tag>           Tag name. build-pr defaults to build-pr-<pr>-<sha>
  --ref <ref>           Branch name or commit SHA for release-tag. Defaults to default branch
  --confirm            Actually create/update the tag. Without this, tag commands are dry runs
  --force              Move an existing tag when used with --confirm
  --allow-draft        Allow draft PRs for build-pr
  --allow-fork         Allow fork PRs for build-pr
  --allow-non-default-base
                       Allow PRs not targeting the repository default branch
  -h, --help            Show help

Environment:
  NULLBUILDER_REPOS     Comma or whitespace-separated repositories. Defaults to NullClaw Zig repos
  NULLBUILDER_IGNORE_REPOS
                        Repositories skipped by discovery. Defaults to known forks/connectors
  NULLBUILDER_OWNER     Default owner for unqualified repository names. Defaults to nullclaw
  NULLBUILDER_DISCOVER_REPOS=true
  NULLBUILDER_CACHE_TTL_MS=60000
  NULLBUILDER_CONCURRENCY=3
  NULLBUILDER_GITHUB_TOKEN
                        Token for private repos and write operations
`;

async function main() {
  const [rawCommand = 'help', ...rest] = process.argv.slice(2);

  if (rawCommand === 'help' || rawCommand === '--help' || rawCommand === '-h') {
    console.log(HELP);
    return;
  }

  if (!COMMANDS.has(rawCommand as Command)) {
    throw new Error(`Unknown command: ${rawCommand}`);
  }

  const command = rawCommand as Command;
  const options = parseOptions(rest);
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

    console.log(`${result.dryRun ? 'Dry run' : result.forced ? 'Moved tag' : 'Created tag'} ${result.tagName}`);
    console.log(`repo: ${result.repo}`);
    console.log(`pr: #${result.prNumber} ${result.prTitle}`);
    console.log(`head: ${result.headSha} (${result.headBranch})`);
    console.log(`tag: ${result.tagUrl}`);
    console.log(`runs: ${result.workflowUrl}`);
    if (result.dryRun) {
      console.log('pass --confirm to create the tag');
    }
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

    console.log(`${result.dryRun ? 'Dry run' : result.forced ? 'Moved tag' : 'Created tag'} ${result.tagName}`);
    console.log(`repo: ${result.repo}`);
    console.log(`target: ${result.targetSha} (${result.targetRef})`);
    console.log(`tag: ${result.tagUrl}`);
    console.log(`runs: ${result.workflowUrl}`);
    if (result.dryRun) {
      console.log('pass --confirm to create the tag');
    }
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
      exitWithAuditProblems(report);
      return;
    }

    printAuditReport(report);
    exitWithAuditProblems(report);
    return;
  }

  const dashboard = await getDashboard(config);

  if (options.json) {
    printJson(selectJson(command, dashboard));
    exitWithReadErrors(dashboard);
    return;
  }

  switch (command) {
    case 'repos':
      printRepos(dashboard);
      break;
    case 'issues':
      printIssues(dashboard);
      break;
    case 'prs':
      printPullRequests(dashboard);
      break;
    case 'runs':
      printRuns(dashboard);
      break;
    case 'stars':
      printStars(dashboard);
      break;
  }

  printRepositoryErrors(dashboard);
  exitWithReadErrors(dashboard);
}

function parseOptions(args: string[]): CliOptions {
  const options: CliOptions = {
    json: false,
    discover: false,
    confirm: false,
    force: false,
    allowDraft: false,
    allowFork: false,
    allowNonDefaultBase: false,
    positionals: []
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--') {
      options.positionals.push(...args.slice(index + 1));
      break;
    }

    if (!arg.startsWith('-')) {
      options.positionals.push(arg);
    } else if (arg === '--json') {
      options.json = true;
    } else if (arg === '--discover') {
      options.discover = true;
    } else if (arg === '--repo') {
      options.repo = readValue(args, (index += 1), '--repo');
    } else if (arg === '--pr') {
      options.pr = Number.parseInt(readValue(args, (index += 1), '--pr'), 10);
    } else if (arg === '--tag') {
      options.tag = readValue(args, (index += 1), '--tag');
    } else if (arg === '--ref') {
      options.targetRef = readValue(args, (index += 1), '--ref');
    } else if (arg === '--confirm') {
      options.confirm = true;
    } else if (arg === '--force') {
      options.force = true;
    } else if (arg === '--allow-draft') {
      options.allowDraft = true;
    } else if (arg === '--allow-fork') {
      options.allowFork = true;
    } else if (arg === '--allow-non-default-base') {
      options.allowNonDefaultBase = true;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  if (options.pr !== undefined && (!Number.isInteger(options.pr) || options.pr <= 0)) {
    throw new Error('--pr must be a positive number.');
  }

  return options;
}

function readValue(args: string[], index: number, option: string): string {
  const value = args[index];
  if (!value || value.startsWith('-')) {
    throw new Error(`${option} requires a value.`);
  }
  return value;
}

function selectJson(command: Command, dashboard: DashboardData) {
  const errors = dashboard.repositories
    .filter((repo) => repo.status === 'error')
    .map((repo) => ({ repo: repo.slug, error: repo.error }));

  if (command === 'issues') {
    return {
      items: dashboard.issues,
      errors
    };
  }
  if (command === 'prs') {
    return {
      items: dashboard.pullRequests,
      errors
    };
  }
  if (command === 'runs' || command === 'stars' || command === 'repos') {
    return {
      items: dashboard.repositories,
      errors
    };
  }

  return dashboard;
}

function printRepos(dashboard: DashboardData) {
  printTable(
    dashboard.repositories.map((repo) => ({
      repo: repo.slug,
      state: repo.status,
      issues: formatNumber(repo.openIssues),
      prs: formatNumber(repo.openPulls),
      stars: formatNumber(repo.stars),
      nightly: formatRun(repo.latestRuns.nightly),
      ci: formatRun(repo.latestRuns.ci),
      url: repo.url
    })),
    ['repo', 'state', 'issues', 'prs', 'stars', 'nightly', 'ci', 'url']
  );
}

function printIssues(dashboard: DashboardData) {
  if (dashboard.issues.length === 0 && dashboard.hasReadErrors) {
    console.log('No issue rows from loaded repositories. Some repositories failed to load.');
    return;
  }

  printTable(
    dashboard.issues.map((issue) => ({
      repo: issue.repo,
      issue: `#${issue.number}`,
      updated: formatDate(issue.updatedAt),
      title: issue.title,
      url: issue.url
    })),
    ['repo', 'issue', 'updated', 'title', 'url']
  );
}

function printPullRequests(dashboard: DashboardData) {
  if (dashboard.pullRequests.length === 0 && dashboard.hasReadErrors) {
    console.log('No PR rows from loaded repositories. Some repositories failed to load.');
    return;
  }

  printTable(
    dashboard.pullRequests.map((pull) => ({
      repo: pull.repo,
      pr: `#${pull.number}`,
      draft: pull.draft ? 'yes' : 'no',
      updated: formatDate(pull.updatedAt),
      title: pull.title,
      url: pull.url
    })),
    ['repo', 'pr', 'draft', 'updated', 'title', 'url']
  );
}

function printRuns(dashboard: DashboardData) {
  printTable(
    dashboard.repositories.flatMap((repo) =>
      Object.entries(repo.latestRuns).map(([kind, run]) => ({
        repo: repo.slug,
        kind,
        status: repo.status === 'error' ? 'unknown' : formatRun(run),
        branch: run?.branch ?? '',
        updated: run ? formatDate(run.updatedAt) : '',
        url: run?.url ?? ''
      }))
    ),
    ['repo', 'kind', 'status', 'branch', 'updated', 'url']
  );
}

function printStars(dashboard: DashboardData) {
  printTable(
    dashboard.repositories.map((repo) => ({
      repo: repo.slug,
      stars: formatNumber(repo.starGrowth.current),
      '7d': formatGrowth(repo.starGrowth.last7Days),
      '30d': formatGrowth(repo.starGrowth.last30Days),
      url: repo.url
    })),
    ['repo', 'stars', '7d', '30d', 'url']
  );
}

function printAuditReport(report: AuditReport) {
  printTable(
    report.repositories.map((repo) => {
      const counts = countAuditFindings(repo.findings);
      return {
        repo: repo.repo,
        state: repo.status,
        score: String(repo.score),
        critical: String(counts.critical),
        warning: String(counts.warning),
        info: String(counts.info),
        top: repo.error ?? repo.findings[0]?.title ?? 'ok'
      };
    }),
    ['repo', 'state', 'score', 'critical', 'warning', 'info', 'top']
  );

  if (report.findings.length === 0) {
    return;
  }

  console.log('\nFindings:');
  for (const item of report.findings) {
    const path = item.path ? ` (${item.path})` : '';
    console.log(`[${item.severity}] ${item.repo}: ${item.title}${path}`);
    console.log(`  ${item.detail}`);
    if (item.url) {
      console.log(`  ${item.url}`);
    }
  }
}

function printTable(rows: Array<Record<string, string>>, columns: string[]) {
  if (rows.length === 0) {
    console.log('No rows.');
    return;
  }

  const widths = columns.map((column) => {
    return Math.max(column.length, ...rows.map((row) => printableLength(row[column] ?? '')));
  });

  console.log(columns.map((column, index) => column.padEnd(widths[index])).join('  '));
  console.log(widths.map((width) => '-'.repeat(width)).join('  '));

  for (const row of rows) {
    console.log(columns.map((column, index) => (row[column] ?? '').padEnd(widths[index])).join('  '));
  }
}

function printRepositoryErrors(dashboard: DashboardData) {
  for (const repo of dashboard.repositories) {
    if (repo.status === 'error') {
      console.error(`${repo.slug}: ${repo.error}`);
    }
  }
}

function exitWithReadErrors(dashboard: DashboardData) {
  if (dashboard.hasReadErrors) {
    process.exitCode = 2;
  }
}

function exitWithAuditProblems(report: AuditReport) {
  if (report.hasReadErrors) {
    process.exitCode = 2;
  } else if (report.totals.critical > 0) {
    process.exitCode = 3;
  }
}

function countAuditFindings(findings: AuditFinding[]): Record<AuditSeverity, number> {
  return findings.reduce(
    (counts, finding) => {
      counts[finding.severity] += 1;
      return counts;
    },
    { critical: 0, warning: 0, info: 0 }
  );
}

function printableLength(value: string): number {
  return value.length;
}

function formatRun(run: RepositorySummary['latestRuns']['ci']): string {
  if (!run) {
    return 'n/a';
  }

  if (run.status !== 'completed') {
    return run.status;
  }

  return run.conclusion ?? 'completed';
}

function formatNumber(value: number | null): string {
  return value === null ? 'unknown' : String(value);
}

function formatGrowth(value: number | null): string {
  return value === null ? 'unknown' : `+${value}`;
}

function formatDate(value: string): string {
  return value.slice(0, 10);
}

function printJson(value: unknown) {
  console.log(JSON.stringify(value, null, 2));
}

main().catch((error: unknown) => {
  console.error(formatCliError(error));
  process.exit(1);
});

function formatCliError(error: unknown): string {
  if (error instanceof GitHubApiError) {
    return publicErrorMessage(error);
  }

  return error instanceof Error ? error.message : String(error);
}
