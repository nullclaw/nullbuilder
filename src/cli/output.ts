import type { AuditFinding, AuditReport, AuditSeverity } from '../lib/server/audit';
import {
  GitHubApiError,
  publicErrorMessage,
  type BuildPrResult,
  type DashboardData,
  type ReleaseTagResult
} from '../lib/server/github';
import { formatDashboardDateOnly, formatGrowth, formatNullableNumber, workflowRunLabel } from '../lib/dashboard-format';
import { sanitizeTerminalCell, sanitizeTerminalLine } from '../lib/text-safety';
import type { Command } from './options';

const MAX_TERMINAL_CELL_LENGTH = 240;
const MAX_TERMINAL_LINE_LENGTH = 2048;
const MAX_TERMINAL_TABLE_ROWS = 1000;
const RUN_KINDS = ['ci', 'nightly', 'release'] as const;

export function selectDashboardJson(command: Command, dashboard: DashboardData) {
  if (command === 'issues') {
    return {
      items: dashboard.issues,
      errors: repositoryErrorRows(dashboard)
    };
  }
  if (command === 'prs') {
    return {
      items: dashboard.pullRequests,
      errors: repositoryErrorRows(dashboard)
    };
  }
  if (command === 'runs' || command === 'stars' || command === 'repos') {
    return {
      items: dashboard.repositories,
      errors: repositoryErrorRows(dashboard)
    };
  }

  return dashboard;
}

export function formatBuildPrResult(result: BuildPrResult): string {
  const lines = [
    terminalLine(`${result.dryRun ? 'Dry run' : result.forced ? 'Moved tag' : 'Created tag'} ${result.tagName}`),
    terminalLine(`repo: ${result.repo}`),
    terminalLine(`pr: #${result.prNumber} ${result.prTitle}`),
    terminalLine(`head: ${result.headSha} (${result.headBranch})`),
    terminalLine(`tag: ${result.tagUrl}`),
    terminalLine(`runs: ${result.workflowUrl}`)
  ];

  if (result.dryRun) {
    lines.push('pass --confirm to create the tag');
  }

  return lines.join('\n');
}

export function formatReleaseTagResult(result: ReleaseTagResult): string {
  const lines = [
    terminalLine(`${result.dryRun ? 'Dry run' : result.forced ? 'Moved tag' : 'Created tag'} ${result.tagName}`),
    terminalLine(`repo: ${result.repo}`),
    terminalLine(`target: ${result.targetSha} (${result.targetRef})`),
    terminalLine(`tag: ${result.tagUrl}`),
    terminalLine(`runs: ${result.workflowUrl}`)
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
  const errorRows = repositoryErrorRows(dashboard, MAX_TERMINAL_TABLE_ROWS);
  const lines = errorRows.map((repo) => terminalLine(`${repo.repo}: ${repo.error}`));

  const omittedRows = Math.max(0, dashboard.totals.erroredRepositories - lines.length);
  if (omittedRows > 0) {
    lines.push(terminalLine(`... ${omittedRows} repository errors omitted; use --json for full output.`));
  }

  return lines.join('\n');
}

function repositoryErrorRows(
  dashboard: DashboardData,
  maxRows = dashboard.repositories.length
): Array<{ repo: string; error: string }> {
  const errors: Array<{ repo: string; error: string }> = [];

  for (let index = 0; index < dashboard.repositories.length && errors.length < maxRows; index += 1) {
    const repo = dashboard.repositories[index];
    if (repo.status === 'error') {
      errors.push({
        repo: repo.slug,
        error: repo.error ?? 'Unknown repository error.'
      });
    }
  }

  return errors;
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
    return terminalLine(publicErrorMessage(error));
  }

  return terminalLine(error instanceof Error ? error.message : String(error));
}

function formatRepos(dashboard: DashboardData): string {
  return formatTableFromItems(
    dashboard.repositories,
    ['repo', 'state', 'issues', 'prs', 'stars', 'nightly', 'ci', 'url'],
    (repo) => ({
      repo: repo.slug,
      state: repo.status,
      issues: formatNullableNumber(repo.openIssues),
      prs: formatNullableNumber(repo.openPulls),
      stars: formatNullableNumber(repo.stars),
      nightly: workflowRunLabel(repo.latestRuns.nightly),
      ci: workflowRunLabel(repo.latestRuns.ci),
      url: repo.url
    })
  );
}

function formatIssues(dashboard: DashboardData): string {
  if (dashboard.issues.length === 0 && dashboard.hasReadErrors) {
    return 'No issue rows from loaded repositories. Some repositories failed to load.';
  }

  return formatTableFromItems(
    dashboard.issues,
    ['repo', 'issue', 'updated', 'title', 'url'],
    (issue) => ({
      repo: issue.repo,
      issue: `#${issue.number}`,
      updated: formatDate(issue.updatedAt),
      title: issue.title,
      url: issue.url
    })
  );
}

function formatPullRequests(dashboard: DashboardData): string {
  if (dashboard.pullRequests.length === 0 && dashboard.hasReadErrors) {
    return 'No PR rows from loaded repositories. Some repositories failed to load.';
  }

  return formatTableFromItems(
    dashboard.pullRequests,
    ['repo', 'pr', 'draft', 'updated', 'title', 'url'],
    (pull) => ({
      repo: pull.repo,
      pr: `#${pull.number}`,
      draft: pull.draft ? 'yes' : 'no',
      updated: formatDate(pull.updatedAt),
      title: pull.title,
      url: pull.url
    })
  );
}

function formatRuns(dashboard: DashboardData): string {
  const columns = ['repo', 'kind', 'status', 'branch', 'updated', 'url'];
  const rowCount = dashboard.repositories.length * RUN_KINDS.length;
  return formatBoundedTable(rowCount, columns, (rowIndex) => {
    const repo = dashboard.repositories[Math.floor(rowIndex / RUN_KINDS.length)];
    const kind = RUN_KINDS[rowIndex % RUN_KINDS.length];
    const run = repo.latestRuns[kind];
    return {
      repo: repo.slug,
      kind,
      status: repo.status === 'error' ? 'unknown' : workflowRunLabel(run),
      branch: run?.branch ?? '',
      updated: run ? formatDate(run.updatedAt) : '',
      url: run?.url ?? ''
    };
  });
}

function formatStars(dashboard: DashboardData): string {
  return formatTableFromItems(
    dashboard.repositories,
    ['repo', 'stars', '7d', '30d', 'url'],
    (repo) => ({
      repo: repo.slug,
      stars: formatNullableNumber(repo.starGrowth.current),
      '7d': formatGrowth(repo.starGrowth.last7Days),
      '30d': formatGrowth(repo.starGrowth.last30Days),
      url: repo.url
    })
  );
}

function formatTable(rows: Array<Record<string, string>>, columns: string[]): string {
  return formatTableFromItems(rows, columns, (row) => row);
}

function formatTableFromItems<T>(
  items: readonly T[],
  columns: string[],
  rowForItem: (item: T) => Record<string, string>
): string {
  return formatBoundedTable(items.length, columns, (index) => rowForItem(items[index]));
}

function formatBoundedTable(
  rowCount: number,
  columns: string[],
  rowAt: (index: number) => Record<string, string>
): string {
  if (rowCount === 0) {
    return 'No rows.';
  }

  const rowLimit = Math.min(rowCount, MAX_TERMINAL_TABLE_ROWS);
  const safeRows: Array<Record<string, string>> = [];
  for (let index = 0; index < rowLimit; index += 1) {
    safeRows.push(sanitizeRow(rowAt(index), columns));
  }

  return formatSanitizedTable(safeRows, columns, rowCount - rowLimit);
}

function formatSanitizedTable(
  safeRows: Array<Record<string, string>>,
  columns: string[],
  omittedRows: number
): string {
  if (safeRows.length === 0) {
    return 'No rows.';
  }

  const widths = columnWidths(safeRows, columns);
  const lines = [
    columns.map((column, index) => column.padEnd(widths[index])).join('  '),
    widths.map((width) => '-'.repeat(width)).join('  ')
  ];

  for (const row of safeRows) {
    lines.push(columns.map((column, index) => (row[column] ?? '').padEnd(widths[index])).join('  '));
  }

  if (omittedRows > 0) {
    lines.push(terminalLine(`... ${omittedRows} rows omitted; use --json for full output.`));
  }

  return lines.join('\n');
}

function formatAuditFinding(item: AuditFinding): string {
  const path = item.path ? ` (${item.path})` : '';
  const lines = [
    terminalLine(`[${item.severity}] ${item.repo}: ${item.title}${path}`),
    terminalLine(`  ${item.detail}`)
  ];

  if (item.url) {
    lines.push(terminalLine(`  ${item.url}`));
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

function columnWidths(rows: Array<Record<string, string>>, columns: string[]): number[] {
  const widths = columns.map((column) => column.length);

  for (const row of rows) {
    for (const [index, column] of columns.entries()) {
      widths[index] = Math.max(widths[index], printableLength(row[column] ?? ''));
    }
  }

  return widths;
}

function formatDate(value: string): string {
  return formatDashboardDateOnly(value);
}

function sanitizeRow(row: Record<string, string>, columns: string[]): Record<string, string> {
  const sanitized: Record<string, string> = {};
  for (const column of columns) {
    sanitized[column] = terminalCell(row[column] ?? '');
  }
  return sanitized;
}

function terminalLine(value: string): string {
  return sanitizeTerminalLine(value, MAX_TERMINAL_LINE_LENGTH);
}

function terminalCell(value: string): string {
  return sanitizeTerminalCell(value, MAX_TERMINAL_LINE_LENGTH, MAX_TERMINAL_CELL_LENGTH);
}
