import type { AuditFinding, AuditReport, AuditSeverity } from '../lib/server/audit';
import {
  GitHubApiError,
  publicErrorMessage,
  type BuildPrResult,
  type DashboardData,
  type ReleaseTagResult
} from '../lib/server/github';
import { formatGrowth, formatNullableNumber, workflowRunLabel } from '../lib/dashboard-format';
import type { Command } from './options';

export function selectDashboardJson(command: Command, dashboard: DashboardData) {
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

export function formatBuildPrResult(result: BuildPrResult): string {
  const lines = [
    `${result.dryRun ? 'Dry run' : result.forced ? 'Moved tag' : 'Created tag'} ${result.tagName}`,
    `repo: ${result.repo}`,
    `pr: #${result.prNumber} ${result.prTitle}`,
    `head: ${result.headSha} (${result.headBranch})`,
    `tag: ${result.tagUrl}`,
    `runs: ${result.workflowUrl}`
  ];

  if (result.dryRun) {
    lines.push('pass --confirm to create the tag');
  }

  return lines.join('\n');
}

export function formatReleaseTagResult(result: ReleaseTagResult): string {
  const lines = [
    `${result.dryRun ? 'Dry run' : result.forced ? 'Moved tag' : 'Created tag'} ${result.tagName}`,
    `repo: ${result.repo}`,
    `target: ${result.targetSha} (${result.targetRef})`,
    `tag: ${result.tagUrl}`,
    `runs: ${result.workflowUrl}`
  ];

  if (result.dryRun) {
    lines.push('pass --confirm to create the tag');
  }

  return lines.join('\n');
}

export function formatDashboard(command: Command, dashboard: DashboardData): string {
  switch (command) {
    case 'repos':
      return formatRepos(dashboard);
    case 'issues':
      return formatIssues(dashboard);
    case 'prs':
      return formatPullRequests(dashboard);
    case 'runs':
      return formatRuns(dashboard);
    case 'stars':
      return formatStars(dashboard);
    default:
      throw new Error(`${command} does not render dashboard rows.`);
  }
}

export function formatAuditReport(report: AuditReport): string {
  const table = formatTable(
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
    return table;
  }

  return `${table}\n\nFindings:\n${report.findings.map(formatAuditFinding).join('\n')}`;
}

export function formatRepositoryErrors(dashboard: DashboardData): string {
  return dashboard.repositories
    .filter((repo) => repo.status === 'error')
    .map((repo) => `${repo.slug}: ${repo.error}`)
    .join('\n');
}

export function readErrorExitCode(dashboard: DashboardData): number | null {
  return dashboard.hasReadErrors ? 2 : null;
}

export function auditExitCode(report: AuditReport): number | null {
  if (report.hasReadErrors) {
    return 2;
  }

  return report.totals.critical > 0 ? 3 : null;
}

export function formatCliError(error: unknown): string {
  if (error instanceof GitHubApiError) {
    return publicErrorMessage(error);
  }

  return error instanceof Error ? error.message : String(error);
}

function formatRepos(dashboard: DashboardData): string {
  return formatTable(
    dashboard.repositories.map((repo) => ({
      repo: repo.slug,
      state: repo.status,
      issues: formatNullableNumber(repo.openIssues),
      prs: formatNullableNumber(repo.openPulls),
      stars: formatNullableNumber(repo.stars),
      nightly: workflowRunLabel(repo.latestRuns.nightly),
      ci: workflowRunLabel(repo.latestRuns.ci),
      url: repo.url
    })),
    ['repo', 'state', 'issues', 'prs', 'stars', 'nightly', 'ci', 'url']
  );
}

function formatIssues(dashboard: DashboardData): string {
  if (dashboard.issues.length === 0 && dashboard.hasReadErrors) {
    return 'No issue rows from loaded repositories. Some repositories failed to load.';
  }

  return formatTable(
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

function formatPullRequests(dashboard: DashboardData): string {
  if (dashboard.pullRequests.length === 0 && dashboard.hasReadErrors) {
    return 'No PR rows from loaded repositories. Some repositories failed to load.';
  }

  return formatTable(
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

function formatRuns(dashboard: DashboardData): string {
  return formatTable(
    dashboard.repositories.flatMap((repo) =>
      Object.entries(repo.latestRuns).map(([kind, run]) => ({
        repo: repo.slug,
        kind,
        status: repo.status === 'error' ? 'unknown' : workflowRunLabel(run),
        branch: run?.branch ?? '',
        updated: run ? formatDate(run.updatedAt) : '',
        url: run?.url ?? ''
      }))
    ),
    ['repo', 'kind', 'status', 'branch', 'updated', 'url']
  );
}

function formatStars(dashboard: DashboardData): string {
  return formatTable(
    dashboard.repositories.map((repo) => ({
      repo: repo.slug,
      stars: formatNullableNumber(repo.starGrowth.current),
      '7d': formatGrowth(repo.starGrowth.last7Days),
      '30d': formatGrowth(repo.starGrowth.last30Days),
      url: repo.url
    })),
    ['repo', 'stars', '7d', '30d', 'url']
  );
}

function formatTable(rows: Array<Record<string, string>>, columns: string[]): string {
  if (rows.length === 0) {
    return 'No rows.';
  }

  const widths = columns.map((column) => {
    return Math.max(column.length, ...rows.map((row) => printableLength(row[column] ?? '')));
  });
  const lines = [
    columns.map((column, index) => column.padEnd(widths[index])).join('  '),
    widths.map((width) => '-'.repeat(width)).join('  ')
  ];

  for (const row of rows) {
    lines.push(columns.map((column, index) => (row[column] ?? '').padEnd(widths[index])).join('  '));
  }

  return lines.join('\n');
}

function formatAuditFinding(item: AuditFinding): string {
  const path = item.path ? ` (${item.path})` : '';
  const lines = [`[${item.severity}] ${item.repo}: ${item.title}${path}`, `  ${item.detail}`];

  if (item.url) {
    lines.push(`  ${item.url}`);
  }

  return lines.join('\n');
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

function formatDate(value: string): string {
  return value.slice(0, 10);
}
