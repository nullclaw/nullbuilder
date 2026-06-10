import { createHash } from 'node:crypto';
import {
  isSafeNonNegativeInteger,
  normalizeBoundedNonNegativeInteger,
  saturatingSafeIntegerAdd
} from '../number-safety';
import { readObjectRecord } from '../record-safety';
import { readSafeTextInput } from '../text-safety';
import { hasEncodedTextControlCharacter } from '../url-safety';
import { contentLengthExceedsByteLimit, readBoundedByteStream } from './byte-stream';
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
export const GITHUB_ERROR_RESPONSE_MAX_BYTES = 64 * 1024;
export const GITHUB_DEFAULT_MAX_PAGES = 20;
export const GITHUB_ABSOLUTE_MAX_PAGES = 100;
export const GITHUB_PAGINATED_ITEMS_MAX = GITHUB_ABSOLUTE_MAX_PAGES * 100;
export const GITHUB_LINK_HEADER_MAX_LENGTH = 16 * 1024;
export const GITHUB_ERROR_MESSAGE_MAX_LENGTH = 512;
export const GITHUB_STATUS_TEXT_MAX_LENGTH = 128;
export const GITHUB_RATE_LIMIT_RESET_MAX_LENGTH = 32;
export const GITHUB_CONTENT_LENGTH_HEADER_MAX_LENGTH = 32;
export const GITHUB_ACCEPT_HEADER_MAX_LENGTH = 256;
export const GITHUB_METHOD_MAX_LENGTH = 16;
export const GITHUB_REQUEST_HEADER_NAME_MAX_LENGTH = 128;
export const GITHUB_REQUEST_HEADER_VALUE_MAX_LENGTH = 4096;
export const GITHUB_REQUEST_HEADER_MAX_ENTRIES = 64;
export const GITHUB_IN_FLIGHT_REQUEST_MAX_ENTRIES = 256;

const DEFAULT_GITHUB_ACCEPT = 'application/vnd.github+json';
const CALLER_SUPPLIED_CREDENTIAL_HEADERS = ['Authorization', 'Cookie', 'Proxy-Authorization'] as const;
const ALLOWED_GITHUB_REQUEST_METHODS = new Set(['GET', 'POST', 'PATCH', 'PUT', 'DELETE']);
const HEADERS_ENTRIES = Headers.prototype.entries;
const PUBLIC_ERROR_MESSAGE_PREFIXES = [
  'Pull request is not trusted:',
  'Build PR tag must start with ',
  'Release tag must start with '
] as const;
const PUBLIC_ERROR_MESSAGES = new Set([
  'Invalid branch commit SHA.',
  'Invalid default branch.',
  'Invalid pull request head SHA.',
  'Invalid pull request number.',
  'Invalid tag name.',
  'Invalid target ref.',
  'Invalid target SHA.',
  'Tag name cannot be empty.'
]);
const cache = new Map<string, CacheEntry<unknown>>();
const inFlightRequests = new Map<string, Promise<GitHubFetchResult<unknown>>>();
const cacheKeyOrder: string[] = [];
const inFlightRequestKeyOrder: string[] = [];

export async function githubGetPages<T>(
  config: NullbuilderConfig,
  path: string,
  init: GitHubRequestOptions = {},
  maxPages: unknown = GITHUB_DEFAULT_MAX_PAGES,
  maxItems: unknown = GITHUB_PAGINATED_ITEMS_MAX
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
  const method = normalizeGitHubRequestMethod(requestInit.method);
  const accept = normalizeGitHubAcceptHeader(requestedAccept);
  const url = resolveGitHubApiUrl(config, path);
  const shouldCache = method === 'GET' && useCache !== false && config.cacheTtlMs > 0;
  const shouldCoalesce = shouldCache && !requestInit.signal;
  const key = shouldCache ? cacheKey(config, url, accept) : '';
  const cached = shouldCache ? readCacheEntry<T>(key) : undefined;
  const now = shouldCache ? safeCacheClockMillis() : null;

  if (cached && now !== null && cached.expiresAt > now) {
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
    return cloneFetchResult(await request);
  } finally {
    if (inFlightRequests.get(key) === request) {
      inFlightRequests.delete(key);
      removeOrderedKey(inFlightRequestKeyOrder, key);
    }
  }
}

function normalizeGitHubRequestMethod(value: string | undefined): string {
  if (value === undefined) {
    return 'GET';
  }

  const safeValue = readSafeTextInput(value, {
    maxLength: GITHUB_METHOD_MAX_LENGTH,
    trim: true
  });
  const method = safeValue?.toUpperCase();
  if (!method || !ALLOWED_GITHUB_REQUEST_METHODS.has(method)) {
    throw new Error('Invalid GitHub request method.');
  }

  return method;
}

function normalizeGitHubAcceptHeader(value: string | undefined): string {
  if (value === undefined) {
    return DEFAULT_GITHUB_ACCEPT;
  }

  const safeValue = readSafeTextInput(value, {
    maxLength: GITHUB_ACCEPT_HEADER_MAX_LENGTH,
    trim: true
  });
  if (!safeValue) {
    throw new Error('Invalid GitHub accept header.');
  }

  return safeValue;
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
  const headers = cloneGitHubRequestHeaders(requestInit.headers);
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
    redirect: 'manual',
    signal: requestInit.signal ?? AbortSignal.timeout(config.requestTimeoutMs)
  });

  if (response.status === 304 && cached) {
    const now = safeCacheClockMillis();
    if (now !== null) {
      cached.expiresAt = cacheExpiresAt(now, config.cacheTtlMs);
      touchCacheEntry(key, cached);
    }
    return resultFromCacheEntry(cached);
  }

  if (!response.ok) {
    throw await toGitHubApiError(response);
  }

  const next = parseNextLink(response.headers.get('Link'));
  const data = await readResponseJson<T>(response);

  if (shouldCache) {
    const now = safeCacheClockMillis();
    if (now !== null) {
      writeCacheEntry(
        key,
        {
          data: cloneSharedJsonData(data),
          next,
          etag: response.headers.get('ETag') ?? undefined,
          expiresAt: cacheExpiresAt(now, config.cacheTtlMs)
        },
        now
      );
    }
  }

  return {
    data,
    next
  };
}

function stripCallerCredentialHeaders(headers: Headers): void {
  for (let index = 0; index < CALLER_SUPPLIED_CREDENTIAL_HEADERS.length; index += 1) {
    const header = CALLER_SUPPLIED_CREDENTIAL_HEADERS[index];
    headers.delete(header);
  }
}

function cloneGitHubRequestHeaders(value: HeadersInit | undefined): Headers {
  const headers = new Headers();
  if (value === undefined) {
    return headers;
  }

  if (value instanceof Headers) {
    appendHeadersEntries(headers, value);
    return headers;
  }

  if (Array.isArray(value)) {
    if (value.length > GITHUB_REQUEST_HEADER_MAX_ENTRIES) {
      throw new Error('Invalid GitHub request header.');
    }

    for (let index = 0; index < value.length; index += 1) {
      const entry = value[index];
      if (!Array.isArray(entry) || entry.length < 2) {
        throw new Error('Invalid GitHub request header.');
      }

      appendGitHubRequestHeader(headers, entry[0], entry[1]);
    }

    return headers;
  }

  const record = readObjectRecord(value);
  if (!record) {
    throw new Error('Invalid GitHub request header.');
  }

  const names = Object.getOwnPropertyNames(record);
  if (names.length > GITHUB_REQUEST_HEADER_MAX_ENTRIES) {
    throw new Error('Invalid GitHub request header.');
  }

  for (let index = 0; index < names.length; index += 1) {
    const name = names[index];
    appendGitHubRequestHeader(headers, name, record[name]);
  }

  return headers;
}

function appendHeadersEntries(headers: Headers, value: Headers): void {
  let count = 0;
  let entries: ReturnType<Headers['entries']>;

  try {
    entries = HEADERS_ENTRIES.call(value);
  } catch {
    throw new Error('Invalid GitHub request header.');
  }

  while (true) {
    const entry = entries.next();
    if (entry.done) {
      break;
    }

    count += 1;
    if (count > GITHUB_REQUEST_HEADER_MAX_ENTRIES) {
      throw new Error('Invalid GitHub request header.');
    }

    appendGitHubRequestHeader(headers, entry.value[0], entry.value[1]);
  }
}

function appendGitHubRequestHeader(headers: Headers, name: unknown, value: unknown): void {
  const safeName = readSafeTextInput(name, { maxLength: GITHUB_REQUEST_HEADER_NAME_MAX_LENGTH });
  const safeValue = readSafeTextInput(value, { maxLength: GITHUB_REQUEST_HEADER_VALUE_MAX_LENGTH });
  if (!safeName || safeValue === null) {
    throw new Error('Invalid GitHub request header.');
  }

  try {
    headers.append(safeName, safeValue);
  } catch {
    throw new Error('Invalid GitHub request header.');
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

  return parseGitHubResponseJson<T>(await readBoundedResponseText(response, GITHUB_JSON_RESPONSE_MAX_BYTES));
}

function parseGitHubResponseJson<T>(body: string): T {
  try {
    return JSON.parse(body) as T;
  } catch {
    throw new Error('GitHub response body is not valid JSON.');
  }
}

async function readErrorDetail(response: Response): Promise<string> {
  try {
    const body: unknown = JSON.parse(await readBoundedResponseText(response, GITHUB_ERROR_RESPONSE_MAX_BYTES));
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

  const body = await readBoundedByteStream(response.body, maxBytes);
  if (!body.ok) {
    throw new Error('GitHub response body is too large.');
  }

  return decodeUtf8Response(body.bytes);
}

function decodeUtf8Response(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error('GitHub response body is not valid UTF-8.');
  }
}

function contentLengthExceedsLimit(value: string, maxBytes: number): boolean {
  return contentLengthExceedsByteLimit(value, maxBytes, GITHUB_CONTENT_LENGTH_HEADER_MAX_LENGTH);
}

function isGitHubErrorPayload(value: unknown): value is { message: string } {
  return typeof readObjectRecord(value)?.message === 'string';
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
  const trimmed = entry.trim();
  if (!trimmed.startsWith('<')) {
    return null;
  }

  const urlEnd = trimmed.indexOf('>');
  if (urlEnd <= 1) {
    return null;
  }

  const parameters = trimmed.slice(urlEnd + 1).trimStart();
  if (!parameters.startsWith(';')) {
    return null;
  }

  return linkParametersIncludeRelation(parameters.slice(1), 'next') ? trimmed.slice(1, urlEnd) : null;
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
  const trimmed = parameter.trim();
  if (trimmed.slice(0, 3).toLowerCase() !== 'rel') {
    return false;
  }

  let valueStart = skipWhitespace(trimmed, 3);
  if (trimmed[valueStart] !== '=') {
    return false;
  }

  valueStart = skipWhitespace(trimmed, valueStart + 1);
  const value = readRelationParameterValue(trimmed, valueStart);
  return value ? relationTokenListIncludes(value, relation) : false;
}

function relationTokenListIncludes(value: string, relation: string): boolean {
  let start = 0;

  for (let index = 0; index <= value.length; index += 1) {
    if (index === value.length || isWhitespace(value[index])) {
      if (index > start && value.slice(start, index) === relation) {
        return true;
      }
      start = index + 1;
    }
  }

  return false;
}

function readRelationParameterValue(parameter: string, valueStart: number): string | null {
  if (valueStart >= parameter.length) {
    return null;
  }

  if (parameter[valueStart] !== '"') {
    return parameter.slice(valueStart).trim();
  }

  return readQuotedRelationParameterValue(parameter, valueStart);
}

function readQuotedRelationParameterValue(parameter: string, quoteStart: number): string | null {
  let value = '';
  let escaped = false;

  for (let index = quoteStart + 1; index < parameter.length; index += 1) {
    const char = parameter[index];

    if (escaped) {
      value += char;
      escaped = false;
      continue;
    }

    if (char === '\\') {
      escaped = true;
      continue;
    }

    if (char === '"') {
      return index === parameter.length - 1 ? value : null;
    }

    value += char;
  }

  return null;
}

function skipWhitespace(value: string, start: number): number {
  let index = start;
  while (index < value.length && isWhitespace(value[index])) {
    index += 1;
  }
  return index;
}

function isWhitespace(value: string): boolean {
  return value.trim() === '';
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
    url.hash !== '' ||
    (basePath && url.pathname !== basePath && !url.pathname.startsWith(`${basePath}/`)) ||
    hasUnsafeApiPathControl(`${url.pathname}${url.search}`)
  ) {
    throw new Error(errorMessage);
  }

  return url.toString();
}

function hasUnsafeApiPathControl(value: string): boolean {
  return /[\u0000-\u001f\u007f-\u009f]/.test(value) || hasEncodedTextControlCharacter(value);
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

  if (error instanceof Error && error.message.startsWith('Invalid GitHub API path')) {
    return 'Invalid GitHub API path.';
  }

  if (error instanceof Error && error.message.startsWith('Invalid GitHub API URL')) {
    return 'Invalid GitHub API URL.';
  }

  if (error instanceof Error && isPublicValidationMessage(error.message)) {
    return error.message;
  }

  return 'Request failed.';
}

function isPublicValidationMessage(message: string): boolean {
  return (
    PUBLIC_ERROR_MESSAGES.has(message) || PUBLIC_ERROR_MESSAGE_PREFIXES.some((prefix) => message.startsWith(prefix))
  );
}

function cacheKey(config: NullbuilderConfig, url: string, accept: string): string {
  const tokenKey = config.token ? createHash('sha256').update(config.token).digest('hex') : 'anonymous';
  const keyMaterial = JSON.stringify([config.apiBaseUrl, tokenKey, accept, url]);
  return createHash('sha256').update(keyMaterial).digest('hex');
}

function touchCacheEntry<T>(key: string, entry: CacheEntry<T>): void {
  if (!key) {
    return;
  }

  cache.delete(key);
  cache.set(key, entry);
  rememberOrderedKey(cacheKeyOrder, key);
}

function writeCacheEntry<T>(key: string, entry: CacheEntry<T>, now: number): void {
  touchCacheEntry(key, entry);
  pruneCache(now);
}

function readCacheEntry<T>(key: string): CacheEntry<T> | undefined {
  return cache.get(key) as CacheEntry<T> | undefined;
}

function resultFromCacheEntry<T>(entry: CacheEntry<T>): GitHubFetchResult<T> {
  return cloneFetchResult(entry);
}

function cloneFetchResult<T>(result: GitHubFetchResult<T>): GitHubFetchResult<T> {
  return {
    data: cloneSharedJsonData(result.data),
    next: result.next
  };
}

function cloneSharedJsonData<T>(data: T): T {
  return structuredClone(data);
}

function safeCacheClockMillis(): number | null {
  const timestamp = Math.floor(Date.now());
  return isSafeNonNegativeInteger(timestamp) ? timestamp : null;
}

function cacheExpiresAt(now: number, ttlMs: number): number {
  return saturatingSafeIntegerAdd(now, ttlMs);
}

function appendPageValues<T>(values: T[], page: unknown, maxItems: number): void {
  if (!Array.isArray(page)) {
    throw new Error('GitHub paginated response must be an array.');
  }

  for (let index = 0; index < page.length; index += 1) {
    if (values.length >= maxItems) {
      return;
    }
    values[values.length] = page[index];
  }
}

function normalizeMaxPages(value: unknown): number {
  return normalizeBoundedNonNegativeInteger(
    value,
    GITHUB_DEFAULT_MAX_PAGES,
    GITHUB_ABSOLUTE_MAX_PAGES
  );
}

function normalizeMaxItems(value: unknown): number {
  return normalizeBoundedNonNegativeInteger(
    value,
    GITHUB_PAGINATED_ITEMS_MAX,
    GITHUB_PAGINATED_ITEMS_MAX
  );
}

function readPendingRequest<T>(key: string): Promise<GitHubFetchResult<T>> | undefined {
  const request = inFlightRequests.get(key) as Promise<GitHubFetchResult<T>> | undefined;
  return request?.then(cloneFetchResult);
}

function rememberPendingRequest<T>(key: string, request: Promise<GitHubFetchResult<T>>): void {
  pruneInFlightRequests();
  inFlightRequests.set(key, request);
  rememberOrderedKey(inFlightRequestKeyOrder, key);
}

function pruneInFlightRequests(): void {
  while (inFlightRequests.size >= GITHUB_IN_FLIGHT_REQUEST_MAX_ENTRIES) {
    const oldestKey = takeOldestExistingKey(inFlightRequests, inFlightRequestKeyOrder);
    if (!oldestKey) {
      return;
    }

    inFlightRequests.delete(oldestKey);
  }
}

function pruneCache(now: number): void {
  pruneExpiredCacheEntries(now);

  while (cache.size > GITHUB_RESPONSE_CACHE_MAX_ENTRIES) {
    const oldestKey = takeOldestExistingKey(cache, cacheKeyOrder);
    if (!oldestKey) {
      return;
    }

    cache.delete(oldestKey);
  }
}

function pruneExpiredCacheEntries(now: number): void {
  let index = 0;
  while (index < cacheKeyOrder.length) {
    const key = cacheKeyOrder[index];
    const entry = cache.get(key);
    if (!entry || entry.expiresAt <= now) {
      cache.delete(key);
      removeOrderedKeyAt(cacheKeyOrder, index);
      continue;
    }

    index += 1;
  }
}

function rememberOrderedKey(order: string[], key: string): void {
  removeOrderedKey(order, key);
  order[order.length] = key;
}

function removeOrderedKey(order: string[], key: string): void {
  for (let index = 0; index < order.length; index += 1) {
    if (order[index] === key) {
      removeOrderedKeyAt(order, index);
      return;
    }
  }
}

function removeOrderedKeyAt(order: string[], index: number): void {
  for (let nextIndex = index + 1; nextIndex < order.length; nextIndex += 1) {
    order[nextIndex - 1] = order[nextIndex];
  }
  order.length -= 1;
}

function takeOldestExistingKey<T>(map: Map<string, T>, order: string[]): string | undefined {
  while (order.length > 0) {
    const key = order[0];
    removeOrderedKeyAt(order, 0);
    if (map.has(key)) {
      return key;
    }
  }

  return undefined;
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
