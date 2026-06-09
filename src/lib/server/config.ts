import { DEFAULT_IGNORED_REPOSITORIES, DEFAULT_OWNER, parseRepositoryList, type RepoSlug } from '../repositories';

export type NullbuilderConfig = {
  owner: string;
  repos: RepoSlug[];
  ignoredRepos: RepoSlug[];
  token?: string;
  apiBaseUrl: string;
  webBaseUrl: string;
  discoverRepos: boolean;
  cacheTtlMs: number;
  concurrency: number;
  requestTimeoutMs: number;
  enableWebMutations: boolean;
  webToken?: string;
};

export function readConfig(env: Record<string, string | undefined> = process.env): NullbuilderConfig {
  const owner = env.NULLBUILDER_OWNER ?? DEFAULT_OWNER;

  return {
    owner,
    repos: parseRepositoryList(env.NULLBUILDER_REPOS, owner),
    ignoredRepos: parseRepositoryList(env.NULLBUILDER_IGNORE_REPOS, owner, DEFAULT_IGNORED_REPOSITORIES),
    token: env.NULLBUILDER_GITHUB_TOKEN,
    apiBaseUrl: env.NULLBUILDER_GITHUB_API_URL ?? 'https://api.github.com',
    webBaseUrl: env.NULLBUILDER_GITHUB_WEB_URL ?? 'https://github.com',
    discoverRepos: parseBoolean(env.NULLBUILDER_DISCOVER_REPOS),
    cacheTtlMs: parsePositiveInteger(env.NULLBUILDER_CACHE_TTL_MS, 60_000),
    concurrency: parsePositiveInteger(env.NULLBUILDER_CONCURRENCY, 3),
    requestTimeoutMs: parsePositiveInteger(env.NULLBUILDER_REQUEST_TIMEOUT_MS, 15_000),
    enableWebMutations: parseBoolean(env.NULLBUILDER_ENABLE_MUTATIONS),
    webToken: env.NULLBUILDER_WEB_TOKEN
  };
}

function parseBoolean(value: string | undefined): boolean {
  if (!value) {
    return false;
  }

  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
