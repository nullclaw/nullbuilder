import { createHash } from 'node:crypto';
import {
  isSafeNonNegativeInteger,
  normalizeBoundedNonNegativeInteger,
  saturatingSafeIntegerAdd
} from '../number-safety';
import { readObjectRecord } from '../record-safety';
import { readSafeTextInput } from '../text-safety';
import {
  hasEncodedTextControlCharacter,
  hasUnsafeHttpUrlPathSyntax
} from '../url-safety';
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
const CALLER_SUPPLIED_CREDENTIAL_HEADERS: ReadonlyArray<string> = Object.freeze([
  'Authorization',
  'Cookie',
  'Proxy-Authorization'
]);
const ALLOWED_GITHUB_REQUEST_METHODS: ReadonlyArray<string> = Object.freeze([
  'GET',
  'POST',
  'PATCH',
  'PUT',
  'DELETE'
]);
const HEADERS_ENTRIES = Headers.prototype.entries;
const HEADERS_ENTRIES_NEXT = Object.getPrototypeOf(HEADERS_ENTRIES.call(new Headers())).next as ReturnType<
  Headers['entries']
>['next'];
const OBJECT_GET_OWN_PROPERTY_NAMES = Object.getOwnPropertyNames.bind(Object) as typeof Object.getOwnPropertyNames;
const STRUCTURED_CLONE = globalThis.structuredClone;
const UTF8_RESPONSE_DECODER = new TextDecoder('utf-8', { fatal: true });
const UTF8_RESPONSE_DECODE = UTF8_RESPONSE_DECODER.decode.bind(UTF8_RESPONSE_DECODER) as TextDecoder['decode'];
const MAX_SAFE_INTEGER = Number.MAX_SAFE_INTEGER;

export type GitHubPublicValidationMessagePolicy = Readonly<{
  match: 'exact' | 'prefix';
  text: string;
}>;

function publicValidationMessagePolicy(
  match: GitHubPublicValidationMessagePolicy['match'],
  text: string
): GitHubPublicValidationMessagePolicy {
  return Object.freeze({ match, text });
}

const PUBLIC_VALIDATION_MESSAGE_POLICIES: ReadonlyArray<GitHubPublicValidationMessagePolicy> = Object.freeze([
  publicValidationMessagePolicy('exact', 'Invalid branch commit SHA.'),
  publicValidationMessagePolicy('exact', 'Invalid default branch.'),
  publicValidationMessagePolicy('exact', 'Invalid pull request head SHA.'),
  publicValidationMessagePolicy('exact', 'Invalid pull request number.'),
  publicValidationMessagePolicy('exact', 'Invalid tag name.'),
  publicValidationMessagePolicy('exact', 'Invalid target ref.'),
  publicValidationMessagePolicy('exact', 'Invalid target SHA.'),
  publicValidationMessagePolicy('exact', 'Tag name cannot be empty.'),
  publicValidationMessagePolicy('prefix', 'Pull request is not trusted:'),
  publicValidationMessagePolicy('prefix', 'Build PR tag must start with '),
  publicValidationMessagePolicy('prefix', 'Release tag must start with ')
]);
const cache = new Map<string, CacheEntry<unknown>>();
const inFlightRequests = new Map<string, Promise<GitHubFetchResult<unknown>>>();
const cacheKeyOrder: string[] = [];
const inFlightRequestKeyOrder: string[] = [];

export function githubCallerCredentialHeaderEntries(): ReadonlyArray<string> {
  return CALLER_SUPPLIED_CREDENTIAL_HEADERS;
}

export function githubRequestMethodEntries(): ReadonlyArray<string> {
  return ALLOWED_GITHUB_REQUEST_METHODS;
}

export function githubPublicValidationMessagePolicyEntries(): ReadonlyArray<GitHubPublicValidationMessagePolicy> {
  return PUBLIC_VALIDATION_MESSAGE_POLICIES;
}

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
  if (!method || !isAllowedGitHubRequestMethod(method)) {
    throw new Error('Invalid GitHub request method.');
  }

  return method;
}

function isAllowedGitHubRequestMethod(method: string): boolean {
  for (let index = 0; index < ALLOWED_GITHUB_REQUEST_METHODS.length; index += 1) {
    if (ALLOWED_GITHUB_REQUEST_METHODS[index] === method) {
      return true;
    }
  }

  return false;
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

  if (isGitHubRequestHeadersInstance(value)) {
    appendHeadersEntries(headers, value);
    return headers;
  }

  if (isGitHubRequestHeaderEntryArray(value)) {
    const count = boundedGitHubRequestHeaderEntryCount(value);
    if (count > GITHUB_REQUEST_HEADER_MAX_ENTRIES) {
      invalidGitHubRequestHeader();
    }

    for (let index = 0; index < count; index += 1) {
      const entry = readGitHubRequestHeaderEntry(readGitHubRequestHeaderArrayItem(value, index));
      appendGitHubRequestHeader(headers, entry.name, entry.value);
    }

    return headers;
  }

  const record = readObjectRecord(value);
  if (!record) {
    invalidGitHubRequestHeader();
  }

  const names = readGitHubRequestHeaderNames(record);
  if (names.length > GITHUB_REQUEST_HEADER_MAX_ENTRIES) {
    invalidGitHubRequestHeader();
  }

  for (let index = 0; index < names.length; index += 1) {
    const name = names[index];
    appendGitHubRequestHeader(headers, name, readGitHubRequestHeaderValue(record, name));
  }

  return headers;
}

function isGitHubRequestHeadersInstance(value: unknown): value is Headers {
  try {
    return value instanceof Headers;
  } catch {
    invalidGitHubRequestHeader();
  }
}

function isGitHubRequestHeaderEntryArray(value: unknown): value is unknown[] {
  try {
    return Array.isArray(value);
  } catch {
    invalidGitHubRequestHeader();
  }
}

function boundedGitHubRequestHeaderEntryCount(value: unknown[]): number {
  try {
    return Math.min(value.length, GITHUB_REQUEST_HEADER_MAX_ENTRIES + 1);
  } catch {
    invalidGitHubRequestHeader();
  }
}

function readGitHubRequestHeaderEntry(entry: unknown): { name: unknown; value: unknown } {
  if (!isGitHubRequestHeaderEntryArray(entry)) {
    invalidGitHubRequestHeader();
  }

  const tuple = entry as unknown[];
  if (boundedGitHubRequestHeaderTupleLength(tuple) < 2) {
    invalidGitHubRequestHeader();
  }

  return {
    name: readGitHubRequestHeaderArrayItem(tuple, 0),
    value: readGitHubRequestHeaderArrayItem(tuple, 1)
  };
}

function boundedGitHubRequestHeaderTupleLength(value: unknown[]): number {
  try {
    return Math.min(value.length, 2);
  } catch {
    invalidGitHubRequestHeader();
  }
}

function readGitHubRequestHeaderArrayItem(value: unknown[], index: number): unknown {
  try {
    return value[index];
  } catch {
    invalidGitHubRequestHeader();
  }
}

function readGitHubRequestHeaderNames(record: Record<string, unknown>): string[] {
  try {
    return OBJECT_GET_OWN_PROPERTY_NAMES(record);
  } catch {
    invalidGitHubRequestHeader();
  }
}

function readGitHubRequestHeaderValue(record: Record<string, unknown>, name: string): unknown {
  try {
    return record[name];
  } catch {
    invalidGitHubRequestHeader();
  }
}

function invalidGitHubRequestHeader(): never {
  throw new Error('Invalid GitHub request header.');
}

function appendHeadersEntries(headers: Headers, value: Headers): void {
  let count = 0;
  let entries: ReturnType<Headers['entries']>;

  try {
    entries = HEADERS_ENTRIES.call(value);
  } catch {
    invalidGitHubRequestHeader();
  }

  while (true) {
    const entry = nextHeadersEntry(entries);
    if (entry.done) {
      break;
    }

    count += 1;
    if (count > GITHUB_REQUEST_HEADER_MAX_ENTRIES) {
      invalidGitHubRequestHeader();
    }

    appendGitHubRequestHeader(headers, entry.value[0], entry.value[1]);
  }
}

function nextHeadersEntry(entries: ReturnType<Headers['entries']>): IteratorResult<[string, string]> {
  try {
    return HEADERS_ENTRIES_NEXT.call(entries);
  } catch {
    invalidGitHubRequestHeader();
  }
}

function appendGitHubRequestHeader(headers: Headers, name: unknown, value: unknown): void {
  const safeName = readSafeTextInput(name, { maxLength: GITHUB_REQUEST_HEADER_NAME_MAX_LENGTH });
  const safeValue = readSafeTextInput(value, { maxLength: GITHUB_REQUEST_HEADER_VALUE_MAX_LENGTH });
  if (!safeName || safeValue === null) {
    invalidGitHubRequestHeader();
  }

  try {
    headers.append(safeName, safeValue);
  } catch {
    invalidGitHubRequestHeader();
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
  return readLimitedResponseJson<T>(response, GITHUB_JSON_RESPONSE_MAX_BYTES);
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
    const body = await readLimitedResponseJson<unknown>(response, GITHUB_ERROR_RESPONSE_MAX_BYTES);
    if (!isGitHubErrorPayload(body)) {
      return '';
    }

    const message = safeGitHubErrorText(body.message, GITHUB_ERROR_MESSAGE_MAX_LENGTH);
    return message ? `: ${message}` : '';
  } catch {
    return '';
  }
}

async function readLimitedResponseJson<T>(response: Response, maxBytes: number): Promise<T> {
  if (response.status === 204) {
    return undefined as T;
  }

  return parseGitHubResponseJson<T>(await readBoundedResponseText(response, maxBytes));
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
    return UTF8_RESPONSE_DECODE(bytes);
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
  const resetSeconds = safeReset ? parsePositiveDecimalText(safeReset) : null;
  if (resetSeconds === null) {
    return null;
  }

  const resetDate = new Date(resetSeconds * 1000);
  return Number.isFinite(resetDate.getTime()) ? resetDate : null;
}

function parsePositiveDecimalText(value: string): number | null {
  if (value.length === 0 || value.charCodeAt(0) < 49 || value.charCodeAt(0) > 57) {
    return null;
  }

  let parsed = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 48 || code > 57) {
      return null;
    }

    const digit = code - 48;
    if (parsed > Math.floor((MAX_SAFE_INTEGER - digit) / 10)) {
      return null;
    }
    parsed = parsed * 10 + digit;
  }

  return parsed;
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
    if (index === value.length || isLinkHeaderWhitespace(value[index])) {
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
  while (index < value.length && isLinkHeaderWhitespace(value[index])) {
    index += 1;
  }
  return index;
}

function isLinkHeaderWhitespace(value: string): boolean {
  return value === ' ' || value === '\t';
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
  const rawUrl = `${config.apiBaseUrl}${path}`;

  if (path.startsWith('//') || hasUnsafeApiPathControl(path) || hasUnsafeHttpUrlPathSyntax(rawUrl)) {
    throw new Error('Invalid GitHub API path.');
  }

  return normalizeGitHubApiUrl(config, new URL(rawUrl), 'Invalid GitHub API path.');
}

function resolveAbsoluteGitHubApiUrl(config: NullbuilderConfig, path: string): string {
  if (hasUnsafeHttpUrlPathSyntax(path)) {
    throw new Error('Invalid GitHub API URL.');
  }

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
  for (let index = 0; index < PUBLIC_VALIDATION_MESSAGE_POLICIES.length; index += 1) {
    const policy = PUBLIC_VALIDATION_MESSAGE_POLICIES[index];
    if (policy.match === 'exact') {
      if (message === policy.text) {
        return true;
      }
      continue;
    }

    if (message.startsWith(policy.text)) {
      return true;
    }
  }

  return false;
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
  return STRUCTURED_CLONE(data);
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
