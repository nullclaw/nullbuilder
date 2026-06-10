import type { RepoSlug } from '../repositories';
import { checkStatus } from './audit-summary';
import type { AuditArea, AuditCheckResult, AuditFinding, AuditSeverity } from './audit-types';
import { safeGitHubWebUrl } from './github-web-urls';

export type GitHubRepositoryResponse = {
  full_name: string;
  html_url: string;
  default_branch: string;
  private: boolean;
  archived: boolean;
};

export type GitHubContentItem = {
  name: string;
  path: string;
  type: string;
  html_url: string;
};

export type GitHubContentFile = GitHubContentItem & {
  content?: string;
  encoding?: string;
};

export type GitHubBranchProtection = {
  required_status_checks?: unknown | null;
  required_pull_request_reviews?: unknown | null;
  enforce_admins?: {
    enabled?: boolean;
  } | null;
};

export type Probe<T> =
  | { status: 'present'; data: T }
  | { status: 'missing' }
  | { status: 'denied' }
  | { status: 'error'; error: string };

export type WorkflowFile = {
  name: string;
  path: string;
  url: string;
  content: string;
};

export type AuditContext = {
  repo: RepoSlug;
  repository: GitHubRepositoryResponse;
  workflowDirectory: Probe<GitHubContentItem[]>;
  workflowFiles: WorkflowFile[];
  branchProtection: Probe<GitHubBranchProtection>;
  dependabot: Probe<GitHubContentFile>;
  securityPolicy: Probe<GitHubContentFile>;
  githubSecurityPolicy: Probe<GitHubContentFile>;
  codeowners: Probe<GitHubContentFile>;
  githubCodeowners: Probe<GitHubContentFile>;
};

export type AuditFindingBuilder = (
  severity: AuditSeverity,
  title: string,
  detail: string,
  url?: string,
  path?: string
) => AuditFinding;

export type AuditRule = {
  id: string;
  title: string;
  area: AuditArea;
  evaluate: (context: AuditContext, finding: AuditFindingBuilder) => AuditFinding[];
};

export function evaluateAuditRule(rule: AuditRule, context: AuditContext): AuditCheckResult {
  const findings = rule.evaluate(context, (severity, title, detail, url, path) =>
    buildFinding(context, rule, severity, title, detail, url, path)
  );

  return {
    id: rule.id,
    title: rule.title,
    area: rule.area,
    status: checkStatus(findings),
    findings
  };
}

export function isPresent<T>(probe: Probe<T>): probe is { status: 'present'; data: T } {
  return probe.status === 'present';
}

function buildFinding(
  context: AuditContext,
  rule: AuditRule,
  severity: AuditSeverity,
  title: string,
  detail: string,
  url?: string,
  path?: string
): AuditFinding {
  const pathPart = path ? `:${path}` : '';
  return {
    id: `${context.repo}:${rule.id}:${severity}:${title}${pathPart}`,
    ruleId: rule.id,
    repo: context.repo,
    severity,
    area: rule.area,
    title,
    detail,
    url: findingUrl(context, url),
    path
  };
}

function findingUrl(context: AuditContext, url: string | undefined): string {
  if (!url) {
    return context.repository.html_url;
  }

  const repositoryUrl = repositoryUrlParts(context.repository.html_url);
  if (!repositoryUrl) {
    return context.repository.html_url;
  }

  return safeGitHubWebUrl(url, context.repository.html_url, repositoryUrl.origin, repositoryUrl.pathPrefix);
}

function repositoryUrlParts(value: string): { origin: string; pathPrefix: string } | null {
  try {
    const url = new URL(value);
    return {
      origin: url.origin,
      pathPrefix: url.pathname
    };
  } catch {
    return null;
  }
}
