import type { AuditFinding, AuditReport, AuditRepositoryResult, AuditSeverity, AuditStatus } from './audit-types';

const SEVERITY_ORDER: Record<AuditSeverity, number> = {
  critical: 0,
  warning: 1,
  info: 2
};

const SEVERITY_PENALTY: Record<AuditSeverity, number> = {
  critical: 35,
  warning: 15,
  info: 5
};

export const MAX_AUDIT_REPORT_FINDINGS = 1000;

export function checkStatus(findings: readonly AuditFinding[]): AuditStatus {
  if (findings.some((finding) => finding.severity === 'critical')) {
    return 'critical';
  }
  if (findings.some((finding) => finding.severity === 'warning')) {
    return 'warning';
  }
  if (findings.some((finding) => finding.severity === 'info')) {
    return 'info';
  }
  return 'ok';
}

export function scoreFindings(findings: readonly AuditFinding[]): number {
  const penalty = findings.reduce((total, finding) => total + SEVERITY_PENALTY[finding.severity], 0);
  return Math.max(0, 100 - penalty);
}

export function countFindings(findings: readonly AuditFinding[]): Record<AuditSeverity, number> {
  return findings.reduce(
    (counts, finding) => {
      counts[finding.severity] += 1;
      return counts;
    },
    { critical: 0, warning: 0, info: 0 }
  );
}

export function sortFindings(left: AuditFinding, right: AuditFinding): number {
  return (
    SEVERITY_ORDER[left.severity] - SEVERITY_ORDER[right.severity] ||
    left.repo.localeCompare(right.repo) ||
    left.title.localeCompare(right.title)
  );
}

export function collectAuditFindings(
  repositories: readonly AuditRepositoryResult[],
  maxFindings = MAX_AUDIT_REPORT_FINDINGS
): AuditFinding[] {
  if (!Number.isSafeInteger(maxFindings) || maxFindings <= 0) {
    return [];
  }

  const findings: AuditFinding[] = [];

  for (const repo of repositories) {
    for (const finding of repo.findings) {
      insertSortedFinding(findings, finding, maxFindings);
    }
  }

  return findings;
}

function insertSortedFinding(findings: AuditFinding[], finding: AuditFinding, maxFindings: number): void {
  if (findings.length >= maxFindings && sortFindings(finding, findings[findings.length - 1]) >= 0) {
    return;
  }

  let lower = 0;
  let upper = findings.length;

  while (lower < upper) {
    const middle = lower + Math.floor((upper - lower) / 2);
    if (sortFindings(finding, findings[middle]) < 0) {
      upper = middle;
    } else {
      lower = middle + 1;
    }
  }

  findings.splice(lower, 0, finding);
  if (findings.length > maxFindings) {
    findings.length = maxFindings;
  }
}

export function buildAuditTotals(repositories: readonly AuditRepositoryResult[]): AuditReport['totals'] {
  const loadedRepositories = repositories.filter((repo) => repo.status === 'ok');
  const counts = countRepositoryFindings(repositories);
  const averageScore =
    loadedRepositories.length === 0
      ? 0
      : Math.round(
          loadedRepositories.reduce((total, repo) => total + normalizeScore(repo.score), 0) /
            loadedRepositories.length
        );

  return {
    repositories: repositories.length,
    loadedRepositories: loadedRepositories.length,
    erroredRepositories: repositories.length - loadedRepositories.length,
    critical: counts.critical,
    warning: counts.warning,
    info: counts.info,
    findings: totalFindingCount(counts),
    averageScore
  };
}

function countRepositoryFindings(repositories: readonly AuditRepositoryResult[]): Record<AuditSeverity, number> {
  return repositories.reduce(
    (counts, repo) => {
      for (const finding of repo.findings) {
        counts[finding.severity] = saturatingSafeIntegerAdd(counts[finding.severity], 1);
      }

      return counts;
    },
    { critical: 0, warning: 0, info: 0 }
  );
}

function totalFindingCount(counts: Record<AuditSeverity, number>): number {
  return saturatingSafeIntegerAdd(
    saturatingSafeIntegerAdd(counts.critical, counts.warning),
    counts.info
  );
}

function normalizeScore(value: number): number {
  return Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : 0;
}

function saturatingSafeIntegerAdd(left: number, right: number): number {
  if (!Number.isSafeInteger(left) || !Number.isSafeInteger(right) || right < 0) {
    return left;
  }

  const sum = left + right;
  return Number.isSafeInteger(sum) ? sum : Number.MAX_SAFE_INTEGER;
}
