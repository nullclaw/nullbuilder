import type { RepoSlug } from '../repositories';

export type AuditSeverity = 'critical' | 'warning' | 'info';
export type AuditArea = 'repository' | 'security' | 'workflow' | 'release';
export type AuditStatus = 'ok' | AuditSeverity;

export type AuditFinding = {
  id: string;
  ruleId: string;
  repo: RepoSlug;
  severity: AuditSeverity;
  area: AuditArea;
  title: string;
  detail: string;
  url?: string;
  path?: string;
};

export type AuditCheckResult = {
  id: string;
  title: string;
  area: AuditArea;
  status: AuditStatus;
  findings: AuditFinding[];
};

export type AuditRepositoryResult = {
  repo: RepoSlug;
  url: string;
  defaultBranch: string;
  status: 'ok' | 'error';
  score: number;
  checks: AuditCheckResult[];
  findings: AuditFinding[];
  error?: string;
};

export type AuditReport = {
  generatedAt: string;
  hasToken: boolean;
  owner: string;
  repos: RepoSlug[];
  repositories: AuditRepositoryResult[];
  findings: AuditFinding[];
  hasReadErrors: boolean;
  totals: {
    repositories: number;
    loadedRepositories: number;
    erroredRepositories: number;
    critical: number;
    warning: number;
    info: number;
    findings: number;
    averageScore: number;
  };
};
