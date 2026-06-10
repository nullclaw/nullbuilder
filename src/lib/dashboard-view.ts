import { safeHttpUrlText } from './url-safety';

export const DASHBOARD_SECTIONS = [
  { id: 'repos', label: 'Overview' },
  { id: 'audit', label: 'Audit' },
  { id: 'issues', label: 'Issues' },
  { id: 'prs', label: 'PRs' },
  { id: 'build-pr', label: 'Build PR' },
  { id: 'release-tag', label: 'Release Tag' }
] as const;

const DEFAULT_DASHBOARD_OWNER = 'nullclaw';
const MAX_DASHBOARD_HREF_LENGTH = 2048;
export const MAX_VISIBLE_AUDIT_FINDINGS = 100;
const SAFE_LOCAL_DASHBOARD_HREF_PATTERN = /^#[A-Za-z][A-Za-z0-9_-]*$/;
const AUDIT_SECTION_HREF = '#audit';

type DashboardOwnerLike = {
  owner: string;
};

type RepositoryErrorLike = {
  error?: string;
};

type AuditReadStateLike = {
  hasReadErrors: boolean;
};

type AuditRepositoryLinkLike = {
  repo: string;
  url: unknown;
};

type AuditFindingLinkLike = {
  repo: string;
  url?: unknown;
};

type MutationResultLike = {
  dryRun: boolean;
  forced: boolean;
  tagName: string;
  repo: string;
};

type BuildPrResultLike = MutationResultLike & {
  prNumber: number;
};

type ReleaseResultLike = MutationResultLike & {
  targetSha: string;
};

export type AuthGateCopy = {
  title: string;
  description: string;
};

export function dashboardOwner(dashboard: DashboardOwnerLike | null | undefined): string {
  return dashboard?.owner ?? DEFAULT_DASHBOARD_OWNER;
}

export function authGateCopy(authConfigured: boolean): AuthGateCopy {
  if (authConfigured) {
    return {
      title: 'Authentication Required',
      description: 'Enter the configured web token to unlock the dashboard.'
    };
  }

  return {
    title: 'Web Token Required',
    description: 'Set NULLBUILDER_WEB_TOKEN before exposing token-backed dashboard data.'
  };
}

export function authStateLabel(authenticated: boolean, authRequired: boolean): string {
  if (authenticated) {
    return 'Authenticated';
  }

  return authRequired ? 'Locked token' : 'Anonymous API';
}

export function hasDashboardReadErrors(
  repositories: readonly RepositoryErrorLike[],
  audit: AuditReadStateLike | null | undefined
): boolean {
  for (let index = 0; index < repositories.length; index += 1) {
    const repo = repositories[index];
    if (repo && Boolean(repo.error)) {
      return true;
    }
  }

  return Boolean(audit?.hasReadErrors);
}

export function visibleAuditFindings<T>(findings: readonly T[], limit = 18): readonly T[] {
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    return [];
  }

  const count = Math.min(findings.length, limit, MAX_VISIBLE_AUDIT_FINDINGS);
  const visible: T[] = [];
  for (let index = 0; index < count; index += 1) {
    visible.push(findings[index]);
  }

  return visible;
}

export function buildAuditRepositoryUrls(
  repositories: readonly AuditRepositoryLinkLike[]
): ReadonlyMap<string, string> {
  const urls = new Map<string, string>();

  for (let index = 0; index < repositories.length; index += 1) {
    const repo = repositories[index];
    if (!repo) {
      continue;
    }
    if (urls.has(repo.repo)) {
      continue;
    }

    const href = safeDashboardExternalHref(repo.url);
    if (href) {
      urls.set(repo.repo, href);
    }
  }

  return urls;
}

export function auditFindingHref(
  finding: AuditFindingLinkLike,
  repositoryUrls: ReadonlyMap<string, string>
): string {
  return safeDashboardExternalHref(finding.url) ?? repositoryUrls.get(finding.repo) ?? AUDIT_SECTION_HREF;
}

export function auditRepositoryHref(value: unknown): string {
  return dashboardExternalHref(value, AUDIT_SECTION_HREF);
}

export function dashboardExternalHref(value: unknown, fallback: unknown = '#'): string {
  return (
    safeDashboardExternalHref(value) ??
    safeLocalDashboardHref(fallback) ??
    safeDashboardExternalHref(fallback) ??
    '#'
  );
}

export function buildPrResultMessage(result: BuildPrResultLike): string {
  return `${mutationVerb(result)} ${result.tagName} for ${result.repo} #${result.prNumber}`;
}

export function releaseResultMessage(result: ReleaseResultLike): string {
  return `${mutationVerb(result)} ${result.tagName} for ${result.repo} at ${shortSha(result.targetSha)}`;
}

function mutationVerb(result: MutationResultLike): string {
  if (result.dryRun) {
    return 'Previewed';
  }

  return result.forced ? 'Moved' : 'Created';
}

function shortSha(value: string): string {
  return value.slice(0, 7);
}

function safeDashboardExternalHref(value: unknown): string | null {
  return safeHttpUrlText(value, { maxLength: MAX_DASHBOARD_HREF_LENGTH });
}

function safeLocalDashboardHref(value: unknown): string | null {
  return typeof value === 'string' && SAFE_LOCAL_DASHBOARD_HREF_PATTERN.test(value) ? value : null;
}
