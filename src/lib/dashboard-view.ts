export const DASHBOARD_SECTIONS = [
  { id: 'repos', label: 'Overview' },
  { id: 'audit', label: 'Audit' },
  { id: 'issues', label: 'Issues' },
  { id: 'prs', label: 'PRs' },
  { id: 'build-pr', label: 'Build PR' },
  { id: 'release-tag', label: 'Release Tag' }
] as const;

const DEFAULT_DASHBOARD_OWNER = 'nullclaw';

type DashboardOwnerLike = {
  owner: string;
};

type RepositoryErrorLike = {
  error?: string;
};

type AuditReadStateLike = {
  hasReadErrors: boolean;
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
  return repositories.some((repo) => Boolean(repo.error)) || Boolean(audit?.hasReadErrors);
}

export function visibleAuditFindings<T>(findings: readonly T[], limit = 18): readonly T[] {
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    return [];
  }

  return findings.slice(0, limit);
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
