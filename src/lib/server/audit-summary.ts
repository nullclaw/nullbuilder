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

export function buildAuditTotals(
  repositories: readonly AuditRepositoryResult[],
  findings: readonly AuditFinding[]
): AuditReport['totals'] {
  const loadedRepositories = repositories.filter((repo) => repo.status === 'ok');
  const counts = countFindings(findings);
  const averageScore =
    loadedRepositories.length === 0
      ? 0
      : Math.round(loadedRepositories.reduce((total, repo) => total + repo.score, 0) / loadedRepositories.length);

  return {
    repositories: repositories.length,
    loadedRepositories: loadedRepositories.length,
    erroredRepositories: repositories.length - loadedRepositories.length,
    critical: counts.critical,
    warning: counts.warning,
    info: counts.info,
    findings: findings.length,
    averageScore
  };
}
