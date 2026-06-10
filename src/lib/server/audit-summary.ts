import type {
  AuditCheckResult,
  AuditFinding,
  AuditReport,
  AuditRepositoryResult,
  AuditSeverity,
  AuditStatus
} from './audit-types';
import { isSafePositiveInteger, saturatingSafeIntegerAdd } from '../number-safety';

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
export const MAX_AUDIT_REPOSITORY_FINDINGS = 1000;

export function checkStatus(findings: readonly AuditFinding[]): AuditStatus {
  let status: AuditStatus = 'ok';

  for (const finding of findings) {
    if (finding.severity === 'critical') {
      return 'critical';
    }
    if (finding.severity === 'warning') {
      status = 'warning';
    } else if (status === 'ok') {
      status = 'info';
    }
  }

  return status;
}

export function scoreFindings(findings: readonly AuditFinding[]): number {
  let penalty = 0;

  for (const finding of findings) {
    penalty += SEVERITY_PENALTY[finding.severity];
    if (penalty >= 100) {
      return 0;
    }
  }

  return 100 - penalty;
}

export function countFindings(findings: readonly AuditFinding[]): Record<AuditSeverity, number> {
  const counts = emptySeverityCounts();
  countSeverityFindings(counts, findings);
  return counts;
}

export function sortFindings(left: AuditFinding, right: AuditFinding): number {
  return (
    SEVERITY_ORDER[left.severity] - SEVERITY_ORDER[right.severity] ||
    left.repo.localeCompare(right.repo) ||
    left.title.localeCompare(right.title)
  );
}

export function collectCheckFindings(
  checks: readonly AuditCheckResult[],
  maxFindings = MAX_AUDIT_REPOSITORY_FINDINGS
): AuditFinding[] {
  const findingLimit = normalizeFindingLimit(maxFindings, MAX_AUDIT_REPOSITORY_FINDINGS);
  if (findingLimit === 0) {
    return [];
  }

  const findings: AuditFinding[] = [];

  for (const check of checks) {
    for (const finding of check.findings) {
      insertSortedFinding(findings, finding, findingLimit);
    }
  }

  return findings;
}

export function collectAuditFindings(
  repositories: readonly AuditRepositoryResult[],
  maxFindings = MAX_AUDIT_REPORT_FINDINGS
): AuditFinding[] {
  const findingLimit = normalizeFindingLimit(maxFindings, MAX_AUDIT_REPORT_FINDINGS);
  if (findingLimit === 0) {
    return [];
  }

  const findings: AuditFinding[] = [];

  for (const repo of repositories) {
    for (const finding of repo.findings) {
      insertSortedFinding(findings, finding, findingLimit);
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
  const counts = emptySeverityCounts();
  let loadedRepositories = 0;
  let scoreTotal = 0;

  for (const repo of repositories) {
    if (repo.status === 'ok') {
      loadedRepositories += 1;
      scoreTotal = saturatingSafeIntegerAdd(scoreTotal, normalizeScore(repo.score));
    }

    countSeverityFindings(counts, repo.findings);
  }

  return {
    repositories: repositories.length,
    loadedRepositories,
    erroredRepositories: repositories.length - loadedRepositories,
    critical: counts.critical,
    warning: counts.warning,
    info: counts.info,
    findings: totalFindingCount(counts),
    averageScore: loadedRepositories === 0 ? 0 : Math.round(scoreTotal / loadedRepositories)
  };
}

function emptySeverityCounts(): Record<AuditSeverity, number> {
  return { critical: 0, warning: 0, info: 0 };
}

function countSeverityFindings(counts: Record<AuditSeverity, number>, findings: readonly AuditFinding[]): void {
  for (const finding of findings) {
    counts[finding.severity] = saturatingSafeIntegerAdd(counts[finding.severity], 1);
  }
}

function normalizeFindingLimit(value: number, maxFindings: number): number {
  if (!isSafePositiveInteger(value) || !isSafePositiveInteger(maxFindings)) {
    return 0;
  }

  return Math.min(value, maxFindings);
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
