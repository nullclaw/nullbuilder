import {
  DEFAULT_IGNORED_REPOSITORIES,
  DEFAULT_OWNER,
  normalizeOwner,
  parseRepositoryList,
  type RepoSlug
} from '../repositories';

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

const DEFAULT_API_BASE_URL = 'https://api.github.com';
const DEFAULT_WEB_BASE_URL = 'https://github.com';
const DEFAULT_CACHE_TTL_MS = 60_000;
const MAX_CACHE_TTL_MS = 5 * 60_000;
const DEFAULT_CONCURRENCY = 3;
const MAX_CONCURRENCY = 10;
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const MIN_REQUEST_TIMEOUT_MS = 5_000;
const MAX_REQUEST_TIMEOUT_MS = 60_000;

export function readConfig(env: Record<string, string | undefined> = process.env): NullbuilderConfig {
  const owner = normalizeOwner(env.NULLBUILDER_OWNER ?? DEFAULT_OWNER);

  return {
    owner,
    repos: parseRepositoryList(env.NULLBUILDER_REPOS, owner),
    ignoredRepos: parseRepositoryList(env.NULLBUILDER_IGNORE_REPOS, owner, DEFAULT_IGNORED_REPOSITORIES),
    token: optionalTrimmed(env.NULLBUILDER_GITHUB_TOKEN),
    apiBaseUrl: parseBaseUrl(env.NULLBUILDER_GITHUB_API_URL, DEFAULT_API_BASE_URL),
    webBaseUrl: parseBaseUrl(env.NULLBUILDER_GITHUB_WEB_URL, DEFAULT_WEB_BASE_URL),
    discoverRepos: parseBoolean(env.NULLBUILDER_DISCOVER_REPOS),
    cacheTtlMs: parseBoundedInteger(env.NULLBUILDER_CACHE_TTL_MS, DEFAULT_CACHE_TTL_MS, 0, MAX_CACHE_TTL_MS),
    concurrency: parseBoundedInteger(env.NULLBUILDER_CONCURRENCY, DEFAULT_CONCURRENCY, 1, MAX_CONCURRENCY),
    requestTimeoutMs: parseBoundedInteger(
      env.NULLBUILDER_REQUEST_TIMEOUT_MS,
      DEFAULT_REQUEST_TIMEOUT_MS,
      MIN_REQUEST_TIMEOUT_MS,
      MAX_REQUEST_TIMEOUT_MS
    ),
    enableWebMutations: parseBoolean(env.NULLBUILDER_ENABLE_MUTATIONS),
    webToken: optionalTrimmed(env.NULLBUILDER_WEB_TOKEN)
  };
}

function parseBoolean(value: string | undefined): boolean {
  if (!value) {
    return false;
  }

  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

function optionalTrimmed(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function parseBaseUrl(value: string | undefined, fallback: string): string {
  const raw = value?.trim() || fallback;
  const url = new URL(raw);

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error(`Invalid URL protocol for ${raw}.`);
  }

  url.hash = '';
  url.search = '';
  return url.toString().replace(/\/$/, '');
}

function parseBoundedInteger(value: string | undefined, fallback: number, min: number, max: number): number {
  if (!value?.trim()) {
    return fallback;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed)) {
    return fallback;
  }

  return Math.min(max, Math.max(min, parsed));
}
