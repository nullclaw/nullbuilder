import {
  DEFAULT_IGNORED_REPOSITORIES,
  DEFAULT_OWNER,
  normalizeOwner,
  parseRepositoryList,
  type RepoSlug
} from '../repositories';
import { readSafeTextInput } from '../text-safety';
import { MAX_MAP_CONCURRENCY } from './concurrency';

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
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const MIN_REQUEST_TIMEOUT_MS = 5_000;
const MAX_REQUEST_TIMEOUT_MS = 60_000;
const MAX_CONFIG_SECRET_LENGTH = 512;
const MAX_CONFIG_URL_LENGTH = 2048;
const MAX_CONFIG_BOOLEAN_LENGTH = 16;
const MAX_CONFIG_INTEGER_LENGTH = 32;

export function readConfig(env: Record<string, string | undefined> = process.env): NullbuilderConfig {
  const owner = normalizeOwner(env.NULLBUILDER_OWNER ?? DEFAULT_OWNER);

  return {
    owner,
    repos: parseRepositoryList(env.NULLBUILDER_REPOS, owner),
    ignoredRepos: parseRepositoryList(env.NULLBUILDER_IGNORE_REPOS, owner, DEFAULT_IGNORED_REPOSITORIES),
    token: parseOptionalSecret(env.NULLBUILDER_GITHUB_TOKEN, 'NULLBUILDER_GITHUB_TOKEN'),
    apiBaseUrl: parseBaseUrl(env.NULLBUILDER_GITHUB_API_URL, DEFAULT_API_BASE_URL, 'NULLBUILDER_GITHUB_API_URL'),
    webBaseUrl: parseBaseUrl(env.NULLBUILDER_GITHUB_WEB_URL, DEFAULT_WEB_BASE_URL, 'NULLBUILDER_GITHUB_WEB_URL'),
    discoverRepos: parseBoolean(env.NULLBUILDER_DISCOVER_REPOS),
    cacheTtlMs: parseBoundedInteger(env.NULLBUILDER_CACHE_TTL_MS, DEFAULT_CACHE_TTL_MS, 0, MAX_CACHE_TTL_MS),
    concurrency: parseBoundedInteger(env.NULLBUILDER_CONCURRENCY, DEFAULT_CONCURRENCY, 1, MAX_MAP_CONCURRENCY),
    requestTimeoutMs: parseBoundedInteger(
      env.NULLBUILDER_REQUEST_TIMEOUT_MS,
      DEFAULT_REQUEST_TIMEOUT_MS,
      MIN_REQUEST_TIMEOUT_MS,
      MAX_REQUEST_TIMEOUT_MS
    ),
    enableWebMutations: parseBoolean(env.NULLBUILDER_ENABLE_MUTATIONS),
    webToken: parseOptionalSecret(env.NULLBUILDER_WEB_TOKEN, 'NULLBUILDER_WEB_TOKEN')
  };
}

function parseBoolean(value: string | undefined): boolean {
  const normalized = parseConfigScalar(value, MAX_CONFIG_BOOLEAN_LENGTH)?.toLowerCase();
  if (!normalized) {
    return false;
  }

  return ['1', 'true', 'yes', 'on'].includes(normalized);
}

function parseOptionalSecret(value: string | undefined, name: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  const safe = readSafeTextInput(value, {
    maxLength: MAX_CONFIG_SECRET_LENGTH,
    trim: true
  });
  if (safe === null) {
    throw new Error(`Invalid secret for ${name}.`);
  }

  return safe || undefined;
}

function parseBaseUrl(value: string | undefined, fallback: string, name: string): string {
  const safe = value === undefined ? fallback : readSafeTextInput(value, { maxLength: MAX_CONFIG_URL_LENGTH, trim: true });
  if (safe === null) {
    throw new Error(`Invalid URL for ${name}.`);
  }

  const raw = safe || fallback;
  let url: URL;

  try {
    url = new URL(raw);
  } catch {
    throw new Error(`Invalid URL for ${name}.`);
  }

  if (url.protocol !== 'https:' && (url.protocol !== 'http:' || !isLoopbackHost(url.hostname))) {
    throw new Error(`Invalid URL protocol for ${name}.`);
  }

  if (url.username || url.password) {
    throw new Error(`Invalid URL credentials for ${name}.`);
  }

  url.hash = '';
  url.search = '';
  return url.toString().replace(/\/$/, '');
}

function isLoopbackHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return normalized === 'localhost' || normalized === '[::1]' || normalized === '::1' || isLoopbackIpv4(normalized);
}

function isLoopbackIpv4(hostname: string): boolean {
  const octets = hostname.split('.');
  if (octets.length !== 4 || octets[0] !== '127') {
    return false;
  }

  return octets.every((octet) => {
    if (!/^(?:0|[1-9]\d{0,2})$/.test(octet)) {
      return false;
    }
    const parsed = Number.parseInt(octet, 10);
    return parsed >= 0 && parsed <= 255;
  });
}

function parseBoundedInteger(value: string | undefined, fallback: number, min: number, max: number): number {
  const trimmed = parseConfigScalar(value, MAX_CONFIG_INTEGER_LENGTH);
  if (!trimmed) {
    return fallback;
  }

  if (!/^[+-]?\d+$/.test(trimmed)) {
    return fallback;
  }

  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isSafeInteger(parsed)) {
    return fallback;
  }

  return Math.min(max, Math.max(min, parsed));
}

function parseConfigScalar(value: string | undefined, maxLength: number): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  return readSafeTextInput(value, { maxLength, trim: true }) ?? undefined;
}
