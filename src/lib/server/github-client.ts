import { createHash } from 'node:crypto';
import type { NullbuilderConfig } from './config';

export type GitHubRequestOptions = RequestInit & {
  accept?: string;
  useCache?: boolean;
};

type GitHubFetchResult<T> = {
  data: T;
  next: string | null;
};

type CacheEntry<T> = {
  data: T;
  next: string | null;
  etag?: string;
  expiresAt: number;
};

export const GITHUB_RESPONSE_CACHE_MAX_ENTRIES = 256;

const cache = new Map<string, CacheEntry<unknown>>();
const inFlightRequests = new Map<string, Promise<GitHubFetchResult<unknown>>>();

export async function githubGetPages<T>(
  config: NullbuilderConfig,
  path: string,
  init: GitHubRequestOptions = {},
  maxPages = 20
): Promise<T[]> {
  const values: T[] = [];
  let next: string | null = path;

  for (let page = 0; next && page < maxPages; page += 1) {
    const result: GitHubFetchResult<T[]> = await githubFetchJson<T[]>(config, next, init);
    values.push(...result.data);
    next = result.next;
  }

  return values;
}

export async function githubRequest<T>(
  config: NullbuilderConfig,
  path: string,
  init: GitHubRequestOptions = {}
): Promise<T> {
  return (await githubFetchJson<T>(config, path, init)).data;
}

export async function githubGet<T>(
  config: NullbuilderConfig,
  path: string,
  init: GitHubRequestOptions = {}
): Promise<T> {
  return githubRequest<T>(config, path, init);
}

async function githubFetchJson<T>(
  config: NullbuilderConfig,
  path: string,
  init: GitHubRequestOptions = {}
): Promise<GitHubFetchResult<T>> {
  const { accept: requestedAccept, useCache, ...requestInit } = init;
  const method = requestInit.method?.toUpperCase() ?? 'GET';
  const accept = requestedAccept ?? 'application/vnd.github+json';
  const url = resolveGitHubApiUrl(config, path);
  const shouldCache = method === 'GET' && useCache !== false && config.cacheTtlMs > 0;
  const shouldCoalesce = shouldCache && !requestInit.signal;
  const key = shouldCache ? cacheKey(config, url, accept) : '';
  const cached = shouldCache ? readCacheEntry<T>(key) : undefined;
  const now = Date.now();

  if (cached && cached.expiresAt > now) {
    touchCacheEntry(key, cached);
    return resultFromCacheEntry(cached);
  }

  const pending = shouldCoalesce ? readPendingRequest<T>(key) : undefined;
  if (pending) {
    return pending;
  }

  const request = requestGitHubJson<T>(config, url, method, accept, requestInit, shouldCache, key, cached);
  if (!shouldCoalesce) {
    return request;
  }

  rememberPendingRequest(key, request);
  try {
    return await request;
  } finally {
    if (inFlightRequests.get(key) === request) {
      inFlightRequests.delete(key);
    }
  }
}

async function requestGitHubJson<T>(
  config: NullbuilderConfig,
  url: string,
  method: string,
  accept: string,
  requestInit: RequestInit,
  shouldCache: boolean,
  key: string,
  cached: CacheEntry<T> | undefined
): Promise<GitHubFetchResult<T>> {
  const headers = new Headers(requestInit.headers);
  headers.set('Accept', accept);
  headers.set('X-GitHub-Api-Version', '2022-11-28');

  if (requestInit.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  if (cached?.etag) {
    headers.set('If-None-Match', cached.etag);
  }

  if (config.token) {
    headers.set('Authorization', `Bearer ${config.token}`);
  }

  const response = await fetch(url, {
    ...requestInit,
    method,
    headers,
    signal: requestInit.signal ?? AbortSignal.timeout(config.requestTimeoutMs)
  });

  if (response.status === 304 && cached) {
    cached.expiresAt = Date.now() + config.cacheTtlMs;
    touchCacheEntry(key, cached);
    return resultFromCacheEntry(cached);
  }

  if (!response.ok) {
    throw await toGitHubApiError(response);
  }

  const next = parseNextLink(response.headers.get('Link'));
  const data = response.status === 204 ? (undefined as T) : ((await response.json()) as T);

  if (shouldCache) {
    writeCacheEntry(key, {
      data,
      next,
      etag: response.headers.get('ETag') ?? undefined,
      expiresAt: Date.now() + config.cacheTtlMs
    });
  }

  return {
    data,
    next
  };
}

async function toGitHubApiError(response: Response): Promise<GitHubApiError> {
  let detail = '';
  try {
    const body = (await response.json()) as { message?: string };
    detail = body.message ? `: ${body.message}` : '';
  } catch {
    detail = '';
  }

  const remaining = response.headers.get('X-RateLimit-Remaining');
  const reset = response.headers.get('X-RateLimit-Reset');
  const rateLimit = rateLimitResetMessage(remaining, reset);

  return new GitHubApiError(`GitHub ${response.status} ${response.statusText}${detail}${rateLimit}`, response.status);
}

function rateLimitResetMessage(remaining: string | null, reset: string | null): string {
  if (remaining !== '0' || !reset) {
    return '';
  }

  const resetDate = parseRateLimitResetDate(reset);
  if (!resetDate) {
    return '';
  }

  return `; rate limit resets at ${resetDate.toISOString()}`;
}

function parseRateLimitResetDate(reset: string): Date | null {
  if (!/^[1-9]\d*$/.test(reset)) {
    return null;
  }

  const resetSeconds = Number.parseInt(reset, 10);
  if (!Number.isSafeInteger(resetSeconds)) {
    return null;
  }

  const resetDate = new Date(resetSeconds * 1000);
  return Number.isFinite(resetDate.getTime()) ? resetDate : null;
}

function parseNextLink(link: string | null): string | null {
  if (!link) {
    return null;
  }

  const next = link.split(',').find((part) => part.includes('rel="next"'));
  const match = next?.match(/<([^>]+)>/);
  return match?.[1] ?? null;
}

export function resolveGitHubApiUrl(config: NullbuilderConfig, path: string): string {
  if (path.startsWith('/')) {
    return `${config.apiBaseUrl}${path}`;
  }

  if (!/^https?:\/\//i.test(path)) {
    throw new Error(`Invalid GitHub API path: ${path}`);
  }

  const base = new URL(config.apiBaseUrl);
  const url = new URL(path);
  const basePath = base.pathname.replace(/\/+$/, '');

  if (url.origin !== base.origin || (basePath && url.pathname !== basePath && !url.pathname.startsWith(`${basePath}/`))) {
    throw new Error(`Invalid GitHub API URL: ${path}`);
  }

  url.hash = '';
  return url.toString();
}

export function publicErrorMessage(error: unknown): string {
  if (error instanceof GitHubApiError) {
    if (error.status === 401 || error.status === 403) {
      return `GitHub API authorization or rate-limit error (${error.status}).`;
    }
    if (error.status === 404) {
      return 'GitHub repository or resource was not found.';
    }
    if (error.status >= 500) {
      return `GitHub API server error (${error.status}).`;
    }
    return `GitHub API error (${error.status}).`;
  }

  if (error instanceof Error && error.message.startsWith('Pull request is not trusted:')) {
    return error.message;
  }

  if (error instanceof Error && error.message.startsWith('Build PR tag')) {
    return error.message;
  }

  if (error instanceof Error && error.message.startsWith('Release tag')) {
    return error.message;
  }

  if (error instanceof Error && error.message.startsWith('Invalid')) {
    return error.message;
  }

  return 'Request failed.';
}

function cacheKey(config: NullbuilderConfig, url: string, accept: string): string {
  const tokenKey = config.token ? createHash('sha256').update(config.token).digest('hex').slice(0, 12) : 'anonymous';
  return `${config.apiBaseUrl}|${tokenKey}|${accept}|${url}`;
}

function touchCacheEntry<T>(key: string, entry: CacheEntry<T>): void {
  if (!key) {
    return;
  }

  cache.delete(key);
  cache.set(key, entry);
}

function writeCacheEntry<T>(key: string, entry: CacheEntry<T>): void {
  touchCacheEntry(key, entry);
  pruneCache(Date.now());
}

function readCacheEntry<T>(key: string): CacheEntry<T> | undefined {
  return cache.get(key) as CacheEntry<T> | undefined;
}

function resultFromCacheEntry<T>(entry: CacheEntry<T>): GitHubFetchResult<T> {
  return {
    data: entry.data,
    next: entry.next
  };
}

function readPendingRequest<T>(key: string): Promise<GitHubFetchResult<T>> | undefined {
  return inFlightRequests.get(key) as Promise<GitHubFetchResult<T>> | undefined;
}

function rememberPendingRequest<T>(key: string, request: Promise<GitHubFetchResult<T>>): void {
  inFlightRequests.set(key, request);
}

function pruneCache(now: number): void {
  for (const [key, entry] of cache) {
    if (entry.expiresAt <= now) {
      cache.delete(key);
    }
  }

  while (cache.size > GITHUB_RESPONSE_CACHE_MAX_ENTRIES) {
    const oldestKey = cache.keys().next().value;
    if (!oldestKey) {
      return;
    }

    cache.delete(oldestKey);
  }
}

export class GitHubApiError extends Error {
  constructor(
    message: string,
    public readonly status: number
  ) {
    super(message);
    this.name = 'GitHubApiError';
  }
}
