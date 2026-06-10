import { createHash } from 'node:crypto';
import { readSafeTextInput } from '../text-safety';
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
export const GITHUB_JSON_RESPONSE_MAX_BYTES = 8 * 1024 * 1024;
export const GITHUB_DEFAULT_MAX_PAGES = 20;
export const GITHUB_ABSOLUTE_MAX_PAGES = 100;
export const GITHUB_PAGINATED_ITEMS_MAX = GITHUB_ABSOLUTE_MAX_PAGES * 100;
export const GITHUB_LINK_HEADER_MAX_LENGTH = 16 * 1024;
export const GITHUB_ERROR_MESSAGE_MAX_LENGTH = 512;
export const GITHUB_STATUS_TEXT_MAX_LENGTH = 128;
export const GITHUB_RATE_LIMIT_RESET_MAX_LENGTH = 32;
export const GITHUB_CONTENT_LENGTH_HEADER_MAX_LENGTH = 32;

const CALLER_SUPPLIED_CREDENTIAL_HEADERS = ['Authorization', 'Cookie'] as const;
const cache = new Map<string, CacheEntry<unknown>>();
const inFlightRequests = new Map<string, Promise<GitHubFetchResult<unknown>>>();

export async function githubGetPages<T>(
  config: NullbuilderConfig,
  path: string,
  init: GitHubRequestOptions = {},
  maxPages = GITHUB_DEFAULT_MAX_PAGES,
  maxItems = GITHUB_PAGINATED_ITEMS_MAX
): Promise<T[]> {
  const values: T[] = [];
  let next: string | null = path;
  const pageLimit = normalizeMaxPages(maxPages);
  const itemLimit = normalizeMaxItems(maxItems);

  for (let page = 0; next && page < pageLimit && values.length < itemLimit; page += 1) {
    const result: GitHubFetchResult<unknown> = await githubFetchJson<unknown>(config, next, init);
    appendPageValues(values, result.data, itemLimit);
    next = values.length >= itemLimit ? null : result.next;
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
  stripCallerCredentialHeaders(headers);
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
  const data = await readResponseJson<T>(response);

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

function stripCallerCredentialHeaders(headers: Headers): void {
  for (const header of CALLER_SUPPLIED_CREDENTIAL_HEADERS) {
    headers.delete(header);
  }
}

async function toGitHubApiError(response: Response): Promise<GitHubApiError> {
  const statusText = safeGitHubErrorText(response.statusText, GITHUB_STATUS_TEXT_MAX_LENGTH) || 'Error';
  const detail = await readErrorDetail(response);
  const remaining = response.headers.get('X-RateLimit-Remaining');
  const reset = response.headers.get('X-RateLimit-Reset');
  const rateLimit = rateLimitResetMessage(remaining, reset);

  return new GitHubApiError(`GitHub ${response.status} ${statusText}${detail}${rateLimit}`, response.status);
}

async function readResponseJson<T>(response: Response): Promise<T> {
  if (response.status === 204) {
    return undefined as T;
  }

  return JSON.parse(await readBoundedResponseText(response, GITHUB_JSON_RESPONSE_MAX_BYTES)) as T;
}

async function readErrorDetail(response: Response): Promise<string> {
  try {
    const body: unknown = JSON.parse(await readBoundedResponseText(response, GITHUB_JSON_RESPONSE_MAX_BYTES));
    if (!isGitHubErrorPayload(body)) {
      return '';
    }

    const message = safeGitHubErrorText(body.message, GITHUB_ERROR_MESSAGE_MAX_LENGTH);
    return message ? `: ${message}` : '';
  } catch {
    return '';
  }
}

async function readBoundedResponseText(response: Response, maxBytes: number): Promise<string> {
  const contentLength = response.headers.get('Content-Length');
  if (contentLength && contentLengthExceedsLimit(contentLength, maxBytes)) {
    throw new Error('GitHub response body is too large.');
  }

  if (!response.body) {
    return '';
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    totalBytes += value.byteLength;
    if (totalBytes > maxBytes) {
      await reader.cancel();
      throw new Error('GitHub response body is too large.');
    }

    chunks.push(value);
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return new TextDecoder().decode(bytes);
}

function contentLengthExceedsLimit(value: string, maxBytes: number): boolean {
  const safeValue = readSafeTextInput(value, {
    maxLength: GITHUB_CONTENT_LENGTH_HEADER_MAX_LENGTH,
    trim: true
  });
  if (!safeValue || !/^[0-9]+$/.test(safeValue)) {
    return true;
  }

  const parsed = Number(safeValue);
  return !Number.isSafeInteger(parsed) || parsed > maxBytes;
}

function isGitHubErrorPayload(value: unknown): value is { message: string } {
  if (!value || typeof value !== 'object') {
    return false;
  }

  return typeof (value as Record<string, unknown>).message === 'string';
}

function safeGitHubErrorText(value: string, maxLength: number): string {
  return readSafeTextInput(value, {
    maxLength,
    trim: true
  }) ?? '';
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
  const safeReset = readSafeTextInput(reset, {
    maxLength: GITHUB_RATE_LIMIT_RESET_MAX_LENGTH
  });
  if (!safeReset || !/^[1-9]\d*$/.test(safeReset)) {
    return null;
  }

  const resetSeconds = Number.parseInt(safeReset, 10);
  if (!Number.isSafeInteger(resetSeconds)) {
    return null;
  }

  const resetDate = new Date(resetSeconds * 1000);
  return Number.isFinite(resetDate.getTime()) ? resetDate : null;
}

function parseNextLink(link: string | null): string | null {
  if (!link || link.length > GITHUB_LINK_HEADER_MAX_LENGTH) {
    return null;
  }

  let start = 0;
  let inUrl = false;
  let inQuotedString = false;
  let escaped = false;

  for (let index = 0; index <= link.length; index += 1) {
    const char = link[index];
    const atEnd = index === link.length;

    if (!atEnd && inQuotedString) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inQuotedString = false;
      }
      continue;
    }

    if (!atEnd && inUrl) {
      if (char === '>') {
        inUrl = false;
      }
      continue;
    }

    if (!atEnd && char === '<') {
      inUrl = true;
      continue;
    }

    if (!atEnd && char === '"') {
      inQuotedString = true;
      continue;
    }

    if (atEnd || char === ',') {
      const next = parseNextLinkEntry(link.slice(start, index));
      if (next) {
        return next;
      }
      start = index + 1;
    }
  }

  return null;
}

function parseNextLinkEntry(entry: string): string | null {
  const match = entry.trim().match(/^<([^>]+)>\s*(?:;(.*))?$/);
  return match && linkParametersIncludeRelation(match[2] ?? '', 'next') ? match[1] : null;
}

function linkParametersIncludeRelation(parameters: string, relation: string): boolean {
  let start = 0;
  let inQuotedString = false;
  let escaped = false;

  for (let index = 0; index <= parameters.length; index += 1) {
    const char = parameters[index];
    const atEnd = index === parameters.length;

    if (!atEnd && inQuotedString) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inQuotedString = false;
      }
      continue;
    }

    if (!atEnd && char === '"') {
      inQuotedString = true;
      continue;
    }

    if (atEnd || char === ';') {
      if (parameterIncludesRelation(parameters.slice(start, index), relation)) {
        return true;
      }
      start = index + 1;
    }
  }

  return false;
}

function parameterIncludesRelation(parameter: string, relation: string): boolean {
  const match = parameter.trim().match(/^rel\s*=\s*(?:"([^"]*)"|([^;]*))$/i);
  const value = match?.[1] ?? match?.[2]?.trim();
  return value ? relationTokenListIncludes(value, relation) : false;
}

function relationTokenListIncludes(value: string, relation: string): boolean {
  let start = 0;

  for (let index = 0; index <= value.length; index += 1) {
    if (index === value.length || /\s/.test(value[index])) {
      if (index > start && value.slice(start, index) === relation) {
        return true;
      }
      start = index + 1;
    }
  }

  return false;
}

export function resolveGitHubApiUrl(config: NullbuilderConfig, path: string): string {
  if (path.startsWith('/')) {
    return resolveRelativeGitHubApiUrl(config, path);
  }

  if (!/^https?:\/\//i.test(path)) {
    throw new Error('Invalid GitHub API path.');
  }

  return resolveAbsoluteGitHubApiUrl(config, path);
}

function resolveRelativeGitHubApiUrl(config: NullbuilderConfig, path: string): string {
  if (path.startsWith('//') || hasUnsafeApiPathControl(path)) {
    throw new Error('Invalid GitHub API path.');
  }

  return normalizeGitHubApiUrl(config, new URL(`${config.apiBaseUrl}${path}`), 'Invalid GitHub API path.');
}

function resolveAbsoluteGitHubApiUrl(config: NullbuilderConfig, path: string): string {
  return normalizeGitHubApiUrl(config, new URL(path), 'Invalid GitHub API URL.');
}

function normalizeGitHubApiUrl(config: NullbuilderConfig, url: URL, errorMessage: string): string {
  const base = new URL(config.apiBaseUrl);
  const basePath = base.pathname.replace(/\/+$/, '');

  if (
    url.origin !== base.origin ||
    url.username !== '' ||
    url.password !== '' ||
    (basePath && url.pathname !== basePath && !url.pathname.startsWith(`${basePath}/`)) ||
    hasUnsafeApiPathControl(`${url.pathname}${url.search}`)
  ) {
    throw new Error(errorMessage);
  }

  url.hash = '';
  return url.toString();
}

function hasUnsafeApiPathControl(value: string): boolean {
  return (
    /[\u0000-\u001f\u007f-\u009f]/.test(value) ||
    /%(?:0[0-9a-f]|1[0-9a-f]|7f)/i.test(value) ||
    /%c2%(?:8[0-9a-f]|9[0-9a-f])/i.test(value)
  );
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

  if (error instanceof Error && error.message.startsWith('Invalid GitHub API path')) {
    return 'Invalid GitHub API path.';
  }

  if (error instanceof Error && error.message.startsWith('Invalid GitHub API URL')) {
    return 'Invalid GitHub API URL.';
  }

  if (error instanceof Error && error.message.startsWith('Invalid')) {
    return error.message;
  }

  return 'Request failed.';
}

function cacheKey(config: NullbuilderConfig, url: string, accept: string): string {
  const tokenKey = config.token ? createHash('sha256').update(config.token).digest('hex') : 'anonymous';
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

function appendPageValues<T>(values: T[], page: unknown, maxItems: number): void {
  if (!Array.isArray(page)) {
    throw new Error('GitHub paginated response must be an array.');
  }

  for (const value of page) {
    if (values.length >= maxItems) {
      return;
    }
    values.push(value);
  }
}

function normalizeMaxPages(value: number): number {
  if (!Number.isFinite(value)) {
    return GITHUB_DEFAULT_MAX_PAGES;
  }

  if (value <= 0) {
    return 0;
  }

  return Math.min(GITHUB_ABSOLUTE_MAX_PAGES, Math.floor(value));
}

function normalizeMaxItems(value: number): number {
  if (!Number.isFinite(value)) {
    return GITHUB_PAGINATED_ITEMS_MAX;
  }

  if (value <= 0) {
    return 0;
  }

  return Math.min(GITHUB_PAGINATED_ITEMS_MAX, Math.floor(value));
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
