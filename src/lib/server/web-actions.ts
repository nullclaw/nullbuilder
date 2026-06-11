import type { Cookies } from '@sveltejs/kit';
import {
  createSessionToken,
  isTokenMatch,
  resolveAuthContext,
  type LoginRateLimiter
} from './auth';
import { arrayBufferFromBytes, contentLengthExceedsByteLimit, readBoundedByteStream } from './byte-stream';
import type { NullbuilderConfig } from './config';
import { sanitizeGitTargetRef } from './git-refs';
import { sanitizeBuildPrTagName, sanitizeReleaseTagName } from './tags';
import { findConfiguredRepoSlug, type RepoSlug } from '../repositories';
import { parsePositiveIntegerText, readSafeTextInput } from '../text-safety';

export type WebMutationOperation = 'build-pr' | 'release-tag';

export type WebAuthFailure = {
  ok: false;
  status: 403 | 429;
  message: string;
};

export type WebLoginSuccess = {
  ok: true;
  sessionToken: string;
};

export type WebLogoutSuccess = {
  ok: true;
};

export type WebLoginResult = WebLoginSuccess | WebAuthFailure;
export type WebLogoutResult = WebLogoutSuccess | WebAuthFailure;

export type BuildPrMutationForm = {
  repo: string;
  prNumber: number | null;
  tagName?: string;
  confirm: boolean;
  force: boolean;
};

export type ReleaseTagMutationForm = {
  repo: string;
  tagName: string;
  targetRef?: string;
  confirm: boolean;
  force: boolean;
};

export type BuildPrMutationInput = Omit<BuildPrMutationForm, 'prNumber'> & {
  prNumber: number;
};

export type ReleaseTagMutationInput = ReleaseTagMutationForm;

export type WebMutationFailure<Field extends string> = {
  ok: false;
  status: 400 | 403 | 500;
  field: Field;
  message: string;
};

export type WebMutationSuccess<T> = {
  ok: true;
  result: T;
};

export type WebMutationResult<T, Field extends string> = WebMutationSuccess<T> | WebMutationFailure<Field>;

const DUPLICATE_FORM_FIELD_MESSAGE = 'Duplicate form field.';
const UNKNOWN_FORM_FIELD_MESSAGE = 'Unknown form field.';
const INVALID_FORM_FIELD_MESSAGE = 'Invalid form field.';
const WEB_ACTION_METHOD_INVALID_MESSAGE = 'Invalid request method.';
const WEB_ACTION_FORM_INVALID_MESSAGE = 'Invalid form body.';
const WEB_ACTION_FORM_TOO_LARGE_MESSAGE = 'Request body is too large.';
const TOO_MANY_FORM_FIELDS_MESSAGE = 'Too many form fields.';
const MAX_WEB_ACTION_CONTENT_LENGTH_HEADER = 32;
const MAX_WEB_ACTION_CONTENT_TYPE_HEADER = 128;
const MAX_WEB_ACTION_FIELD_NAME_LENGTH = 64;
const WEB_ACTION_FORM_URLENCODED_MEDIA_TYPE = 'application/x-www-form-urlencoded';
const WEB_ACTION_MULTIPART_MEDIA_TYPE = 'multipart/form-data';
export const MAX_WEB_ACTION_FORM_BYTES = 16 * 1024;

export type WebActionFormFieldPolicy = Readonly<{
  id: 'login' | 'logout' | WebMutationOperation;
  fields: ReadonlyArray<string>;
}>;

function webActionFormFieldPolicy(
  id: WebActionFormFieldPolicy['id'],
  fields: ReadonlyArray<string>
): WebActionFormFieldPolicy {
  return Object.freeze({
    id,
    fields: Object.freeze(copyFormFieldNames(fields))
  });
}

const LOGIN_FORM_FIELD_POLICY = webActionFormFieldPolicy('login', ['webToken']);
const LOGOUT_FORM_FIELD_POLICY = webActionFormFieldPolicy('logout', ['csrfToken']);
const BUILD_PR_FORM_FIELD_POLICY = webActionFormFieldPolicy('build-pr', [
  'csrfToken',
  'repo',
  'prNumber',
  'tagName',
  'confirm',
  'force'
]);
const RELEASE_TAG_FORM_FIELD_POLICY = webActionFormFieldPolicy('release-tag', [
  'csrfToken',
  'repo',
  'tagName',
  'targetRef',
  'confirm',
  'force'
]);

const WEB_ACTION_FORM_FIELD_POLICIES: ReadonlyArray<WebActionFormFieldPolicy> = Object.freeze([
  LOGIN_FORM_FIELD_POLICY,
  LOGOUT_FORM_FIELD_POLICY,
  BUILD_PR_FORM_FIELD_POLICY,
  RELEASE_TAG_FORM_FIELD_POLICY
]);
export const MAX_WEB_ACTION_FORM_FIELDS = maxWebActionFormFields(WEB_ACTION_FORM_FIELD_POLICIES);
const FORM_DATA_ENTRIES = FormData.prototype.entries;
const FORM_DATA_ENTRIES_NEXT = Object.getPrototypeOf(FORM_DATA_ENTRIES.call(new FormData())).next as ReturnType<
  FormData['entries']
>['next'];

export function webActionFormFieldPolicyEntries(): ReadonlyArray<WebActionFormFieldPolicy> {
  return WEB_ACTION_FORM_FIELD_POLICIES;
}

function copyFormFieldNames(fields: ReadonlyArray<string>): string[] {
  const copy: string[] = [];
  for (let index = 0; index < fields.length; index += 1) {
    copy[index] = fields[index];
  }

  return copy;
}

function maxWebActionFormFields(policies: ReadonlyArray<WebActionFormFieldPolicy>): number {
  let maxFields = 0;
  for (let index = 0; index < policies.length; index += 1) {
    if (policies[index].fields.length > maxFields) {
      maxFields = policies[index].fields.length;
    }
  }

  return maxFields;
}

export function runLoginWebAction(
  config: NullbuilderConfig,
  rateLimiter: LoginRateLimiter,
  rateLimitKey: string,
  formData: FormData
): WebLoginResult {
  if (!config.webToken) {
    return authFailure(403, 'Set NULLBUILDER_WEB_TOKEN before exposing token-backed dashboard data.');
  }

  if (!rateLimiter.isAllowed(rateLimitKey)) {
    return authFailure(429, 'Too many failed login attempts. Try again later.');
  }

  const form = parseAuthForm(formData, LOGIN_FORM_FIELD_POLICY, 'Invalid web token.');
  if (!form.ok) {
    rateLimiter.recordFailure(rateLimitKey);
    return form;
  }

  const token = formString(form.fields.get('webToken') ?? null);
  if (!isTokenMatch(token, config.webToken)) {
    rateLimiter.recordFailure(rateLimitKey);
    return authFailure(403, 'Invalid web token.');
  }

  rateLimiter.clear(rateLimitKey);
  return {
    ok: true,
    sessionToken: createSessionToken(config.webToken)
  };
}

export type WebActionBodyLimitFailure = {
  ok: false;
  status: 413;
  message: string;
};

export type WebActionBodyParseFailure = {
  ok: false;
  status: 400;
  message: string;
};

export type WebActionMethodFailure = {
  ok: false;
  status: 405;
  message: string;
};

type WebActionFormDataSuccess = {
  ok: true;
  formData: FormData;
};

type WebActionRequestBodySuccess = {
  ok: true;
  bytes: Uint8Array;
};

export type WebActionFormDataResult =
  | WebActionFormDataSuccess
  | WebActionBodyLimitFailure
  | WebActionBodyParseFailure
  | WebActionMethodFailure;

export function webActionContentLengthFailure(headers: Headers): WebActionBodyLimitFailure | null {
  const contentLength = headers.get('content-length');
  if (!contentLength || !contentLengthExceedsWebActionLimit(contentLength)) {
    return null;
  }

  return webActionBodyTooLargeFailure();
}

export async function readWebActionFormData(request: Request): Promise<WebActionFormDataResult> {
  const methodFailure = webActionMethodFailure(request);
  if (methodFailure) {
    return methodFailure;
  }

  const contentLengthFailure = webActionContentLengthFailure(request.headers);
  if (contentLengthFailure) {
    return contentLengthFailure;
  }

  const contentType = webActionFormContentType(request.headers);
  if (contentType === null) {
    return webActionBodyParseFailure();
  }

  const body = await readBoundedWebActionBody(request);
  if (!body.ok) {
    return body;
  }

  const boundedRequest = new Request(request.url, {
    method: request.method,
    headers: webActionFormDataHeaders(contentType),
    body: new Blob([arrayBufferFromBytes(body.bytes)])
  });

  try {
    return {
      ok: true,
      formData: await boundedRequest.formData()
    };
  } catch {
    return webActionBodyParseFailure();
  }
}

export function runLogoutWebAction(config: NullbuilderConfig, cookies: Cookies, formData: FormData): WebLogoutResult {
  const form = parseAuthForm(formData, LOGOUT_FORM_FIELD_POLICY, 'Invalid request token.');
  if (!form.ok) {
    return form;
  }

  const csrfToken = form.fields.get('csrfToken') ?? null;
  const authContext = resolveAuthContext(cookies, config);

  if (config.webToken && authContext.authenticated && !isCsrfTokenValueMatch(csrfToken, authContext.csrfToken)) {
    return authFailure(403, 'Invalid request token.');
  }

  return {
    ok: true
  };
}

export function mutationAccessError(
  config: NullbuilderConfig,
  cookies: Cookies,
  csrfToken: FormDataEntryValue | null,
  operation: WebMutationOperation
): string | null {
  if (!config.enableWebMutations) {
    return `Web mutations are disabled. Set NULLBUILDER_ENABLE_MUTATIONS=true to enable ${operation} from the UI.`;
  }

  const authContext = resolveAuthContext(cookies, config);

  if (!config.webToken || !authContext.authenticated) {
    return 'Web mutations require NULLBUILDER_WEB_TOKEN authentication.';
  }

  if (!isCsrfTokenValueMatch(csrfToken, authContext.csrfToken)) {
    return 'Invalid request token.';
  }

  return null;
}

function parseAuthForm(
  formData: FormData,
  policy: WebActionFormFieldPolicy,
  message: string
): WebAuthFailure | { ok: true; fields: ReadonlyMap<string, FormDataEntryValue> } {
  try {
    return { ok: true, fields: readFormFields(formData, policy.fields) };
  } catch (error) {
    if (isInvalidFormShapeError(error)) {
      return authFailure(403, message);
    }

    throw error;
  }
}

export async function runBuildPrWebMutation<T>(
  config: NullbuilderConfig,
  cookies: Cookies,
  formData: FormData,
  execute: (input: BuildPrMutationInput) => Promise<T>,
  formatError: (error: unknown) => string
): Promise<WebMutationResult<T, 'buildError'>> {
  const accessError = mutationAccessError(config, cookies, singleFormValue(formData, 'csrfToken'), 'build-pr');
  if (accessError) {
    return mutationFailure(403, 'buildError', accessError);
  }

  const buildForm = parseBuildPrMutationFormResult(formData);
  if (!buildForm.ok) {
    return buildForm;
  }

  const input = prepareBuildPrMutationInput(config, buildForm);
  if (!input.ok) {
    return input;
  }

  try {
    return {
      ok: true,
      result: await execute(input.value)
    };
  } catch (error) {
    return mutationFailure(500, 'buildError', formatError(error));
  }
}

export async function runReleaseTagWebMutation<T>(
  config: NullbuilderConfig,
  cookies: Cookies,
  formData: FormData,
  execute: (input: ReleaseTagMutationInput) => Promise<T>,
  formatError: (error: unknown) => string
): Promise<WebMutationResult<T, 'releaseError'>> {
  const accessError = mutationAccessError(config, cookies, singleFormValue(formData, 'csrfToken'), 'release-tag');
  if (accessError) {
    return mutationFailure(403, 'releaseError', accessError);
  }

  const releaseForm = parseReleaseTagMutationFormResult(formData);
  if (!releaseForm.ok) {
    return releaseForm;
  }

  const input = prepareReleaseTagMutationInput(config, releaseForm);
  if (!input.ok) {
    return input;
  }

  try {
    return {
      ok: true,
      result: await execute(input.value)
    };
  } catch (error) {
    return mutationFailure(500, 'releaseError', formatError(error));
  }
}

export function parseBuildPrMutationForm(formData: FormData): BuildPrMutationForm {
  const fields = readFormFields(formData, BUILD_PR_FORM_FIELD_POLICY.fields);
  const tagName = trimmedFormString(fields.get('tagName') ?? null);

  return {
    repo: trimmedFormString(fields.get('repo') ?? null),
    prNumber: parsePositiveFormInteger(fields.get('prNumber') ?? null),
    tagName: tagName || undefined,
    confirm: isChecked(fields.get('confirm') ?? null),
    force: isChecked(fields.get('force') ?? null)
  };
}

export function parseReleaseTagMutationForm(formData: FormData): ReleaseTagMutationForm {
  const fields = readFormFields(formData, RELEASE_TAG_FORM_FIELD_POLICY.fields);
  const targetRef = trimmedFormString(fields.get('targetRef') ?? null);

  return {
    repo: trimmedFormString(fields.get('repo') ?? null),
    tagName: trimmedFormString(fields.get('tagName') ?? null),
    targetRef: targetRef || undefined,
    confirm: isChecked(fields.get('confirm') ?? null),
    force: isChecked(fields.get('force') ?? null)
  };
}

export function parsePositiveFormInteger(value: FormDataEntryValue | null): number | null {
  if (typeof value !== 'string') {
    return null;
  }

  return parsePositiveIntegerText(value);
}

type PreparedMutationInput<T, Field extends 'buildError' | 'releaseError'> =
  | {
      ok: true;
      value: T;
    }
  | WebMutationFailure<Field>;

function parseBuildPrMutationFormResult(
  formData: FormData
): ({ ok: true } & BuildPrMutationForm) | WebMutationFailure<'buildError'> {
  try {
    return {
      ok: true,
      ...parseBuildPrMutationForm(formData)
    };
  } catch (error) {
    if (isInvalidFormShapeError(error)) {
      return mutationFailure(400, 'buildError', 'Invalid form data.');
    }

    throw error;
  }
}

function parseReleaseTagMutationFormResult(
  formData: FormData
): ({ ok: true } & ReleaseTagMutationForm) | WebMutationFailure<'releaseError'> {
  try {
    return {
      ok: true,
      ...parseReleaseTagMutationForm(formData)
    };
  } catch (error) {
    if (isInvalidFormShapeError(error)) {
      return mutationFailure(400, 'releaseError', 'Invalid form data.');
    }

    throw error;
  }
}

function prepareBuildPrMutationInput(
  config: NullbuilderConfig,
  form: BuildPrMutationForm
): PreparedMutationInput<BuildPrMutationInput, 'buildError'> {
  if (!form.repo || !form.prNumber) {
    return mutationFailure(400, 'buildError', 'Repository and a positive PR number are required.');
  }

  const repo = configuredRepository(config, form.repo);
  if (!repo) {
    return mutationFailure(400, 'buildError', 'Repository must be one of the configured repositories.');
  }

  const tagName = optionalBuildPrTagName(form.tagName);
  if (tagName === null) {
    return mutationFailure(400, 'buildError', 'Invalid build PR tag.');
  }

  return {
    ok: true,
    value: {
      repo,
      prNumber: form.prNumber,
      tagName,
      confirm: form.confirm,
      force: form.force
    }
  };
}

function prepareReleaseTagMutationInput(
  config: NullbuilderConfig,
  form: ReleaseTagMutationForm
): PreparedMutationInput<ReleaseTagMutationInput, 'releaseError'> {
  if (!form.repo || !form.tagName) {
    return mutationFailure(400, 'releaseError', 'Repository and release tag are required.');
  }

  const repo = configuredRepository(config, form.repo);
  if (!repo) {
    return mutationFailure(400, 'releaseError', 'Repository must be one of the configured repositories.');
  }

  const tagName = releaseTagName(form.tagName);
  if (!tagName) {
    return mutationFailure(400, 'releaseError', 'Invalid release tag.');
  }

  const targetRef = optionalTargetRef(form.targetRef);
  if (targetRef === null) {
    return mutationFailure(400, 'releaseError', 'Invalid target ref.');
  }

  return {
    ok: true,
    value: {
      repo,
      tagName,
      targetRef,
      confirm: form.confirm,
      force: form.force
    }
  };
}

function configuredRepository(config: NullbuilderConfig, value: string): RepoSlug | null {
  return findConfiguredRepoSlug(config.repos, value, config.owner);
}

function optionalBuildPrTagName(value: string | undefined): string | undefined | null {
  if (!value) {
    return undefined;
  }

  try {
    return sanitizeBuildPrTagName(value);
  } catch {
    return null;
  }
}

function releaseTagName(value: string): string | null {
  try {
    return sanitizeReleaseTagName(value);
  } catch {
    return null;
  }
}

function optionalTargetRef(value: string | undefined): string | undefined | null {
  if (!value) {
    return undefined;
  }

  try {
    return sanitizeGitTargetRef(value);
  } catch {
    return null;
  }
}

function readFormFields(
  formData: FormData,
  allowedFields: ReadonlyArray<string>
): Map<string, FormDataEntryValue> {
  const fields = new Map<string, FormDataEntryValue>();
  const entries = formDataEntries(formData);
  let fieldCount = 0;

  while (true) {
    const entry = nextFormDataEntry(entries);
    if (entry.done) {
      break;
    }

    const field = entry.value[0];
    const value = entry.value[1];
    fieldCount += 1;
    if (fieldCount > MAX_WEB_ACTION_FORM_FIELDS) {
      throw new Error(TOO_MANY_FORM_FIELDS_MESSAGE);
    }

    if (!isSafeFormFieldName(field)) {
      throw new Error(INVALID_FORM_FIELD_MESSAGE);
    }

    if (!isAllowedFormField(allowedFields, field)) {
      throw new Error(UNKNOWN_FORM_FIELD_MESSAGE);
    }

    if (fields.has(field)) {
      throw new Error(DUPLICATE_FORM_FIELD_MESSAGE);
    }
    fields.set(field, value);
  }

  return fields;
}

function isAllowedFormField(allowedFields: ReadonlyArray<string>, field: string): boolean {
  for (let index = 0; index < allowedFields.length; index += 1) {
    if (allowedFields[index] === field) {
      return true;
    }
  }

  return false;
}

function singleFormValue(formData: FormData, field: string): FormDataEntryValue | null {
  const entries = formDataEntries(formData);
  let value: FormDataEntryValue | null = null;
  let fieldCount = 0;

  while (true) {
    const entry = nextFormDataEntry(entries);
    if (entry.done) {
      break;
    }

    const entryField = entry.value[0];
    const entryValue = entry.value[1];
    fieldCount += 1;
    if (fieldCount > MAX_WEB_ACTION_FORM_FIELDS) {
      return value;
    }

    if (entryField !== field) {
      continue;
    }

    if (value !== null) {
      return null;
    }

    value = entryValue;
  }

  return value;
}

function formDataEntries(formData: FormData): ReturnType<FormData['entries']> {
  return FORM_DATA_ENTRIES.call(formData);
}

function nextFormDataEntry(
  entries: ReturnType<FormData['entries']>
): IteratorResult<[string, FormDataEntryValue]> {
  try {
    return FORM_DATA_ENTRIES_NEXT.call(entries);
  } catch {
    throw new Error(INVALID_FORM_FIELD_MESSAGE);
  }
}

function isInvalidFormShapeError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.message === DUPLICATE_FORM_FIELD_MESSAGE ||
      error.message === UNKNOWN_FORM_FIELD_MESSAGE ||
      error.message === INVALID_FORM_FIELD_MESSAGE ||
      error.message === TOO_MANY_FORM_FIELDS_MESSAGE)
  );
}

function isSafeFormFieldName(field: string): boolean {
  return Boolean(field && readSafeTextInput(field, { maxLength: MAX_WEB_ACTION_FIELD_NAME_LENGTH }) === field);
}

function isCsrfTokenValueMatch(value: FormDataEntryValue | null, expected: string | null): boolean {
  return typeof value === 'string' && Boolean(expected && isTokenMatch(value, expected));
}

function contentLengthExceedsWebActionLimit(value: string): boolean {
  return contentLengthExceedsByteLimit(value, MAX_WEB_ACTION_FORM_BYTES, MAX_WEB_ACTION_CONTENT_LENGTH_HEADER);
}

function webActionMethodFailure(request: Request): WebActionMethodFailure | null {
  return request.method === 'POST' ? null : webActionInvalidMethodFailure();
}

function webActionFormContentType(headers: Headers): string | null {
  const value = headers.get('content-type');
  if (!value) {
    return null;
  }

  const safeValue = readSafeTextInput(value, {
    maxLength: MAX_WEB_ACTION_CONTENT_TYPE_HEADER
  });
  if (!safeValue) {
    return null;
  }
  if (safeValue.includes(',')) {
    return null;
  }

  const mediaType = webActionContentMediaTypeRange(safeValue);
  if (!mediaType) {
    return null;
  }

  const supportedMediaType = supportedWebActionMediaType(safeValue, mediaType.start, mediaType.end);
  return supportedMediaType ? `${supportedMediaType}${safeValue.slice(mediaType.parametersStart)}` : null;
}

function webActionFormDataHeaders(contentType: string): Headers {
  const headers = new Headers();
  headers.set('content-type', contentType);
  return headers;
}

function webActionContentMediaTypeRange(value: string): { start: number; end: number; parametersStart: number } | null {
  const separatorIndex = value.indexOf(';');
  const rawEnd = separatorIndex === -1 ? value.length : separatorIndex;
  const start = skipHttpHeaderSpaces(value, 0);
  const end = trimHttpHeaderSpacesEnd(value, start, rawEnd);

  return end > start ? { start, end, parametersStart: rawEnd } : null;
}

function skipHttpHeaderSpaces(value: string, start: number): number {
  let index = start;
  while (value[index] === ' ') {
    index += 1;
  }
  return index;
}

function trimHttpHeaderSpacesEnd(value: string, start: number, end: number): number {
  let index = end;
  while (index > start && value[index - 1] === ' ') {
    index -= 1;
  }
  return index;
}

function supportedWebActionMediaType(value: string, start: number, end: number): string | null {
  if (asciiRangeEqualsIgnoreCase(value, start, end, WEB_ACTION_FORM_URLENCODED_MEDIA_TYPE)) {
    return WEB_ACTION_FORM_URLENCODED_MEDIA_TYPE;
  }

  if (asciiRangeEqualsIgnoreCase(value, start, end, WEB_ACTION_MULTIPART_MEDIA_TYPE)) {
    return WEB_ACTION_MULTIPART_MEDIA_TYPE;
  }

  return null;
}

function asciiRangeEqualsIgnoreCase(value: string, start: number, end: number, expected: string): boolean {
  if (end - start !== expected.length) {
    return false;
  }

  for (let index = 0; index < expected.length; index += 1) {
    if (asciiLowerCodeUnit(value.charCodeAt(start + index)) !== expected.charCodeAt(index)) {
      return false;
    }
  }

  return true;
}

function asciiLowerCodeUnit(value: number): number {
  return value >= 65 && value <= 90 ? value + 32 : value;
}

async function readBoundedWebActionBody(
  request: Request
): Promise<WebActionRequestBodySuccess | WebActionBodyLimitFailure | WebActionBodyParseFailure> {
  try {
    const body = await readBoundedByteStream(request.body, MAX_WEB_ACTION_FORM_BYTES);
    return body.ok ? body : webActionBodyTooLargeFailure();
  } catch {
    return webActionBodyParseFailure();
  }
}

function webActionBodyTooLargeFailure(): WebActionBodyLimitFailure {
  return {
    ok: false,
    status: 413,
    message: WEB_ACTION_FORM_TOO_LARGE_MESSAGE
  };
}

function webActionBodyParseFailure(): WebActionBodyParseFailure {
  return {
    ok: false,
    status: 400,
    message: WEB_ACTION_FORM_INVALID_MESSAGE
  };
}

function webActionInvalidMethodFailure(): WebActionMethodFailure {
  return {
    ok: false,
    status: 405,
    message: WEB_ACTION_METHOD_INVALID_MESSAGE
  };
}

function trimmedFormString(value: FormDataEntryValue | null): string {
  const raw = formString(value);
  return readSafeTextInput(raw, { trim: true }) ?? '';
}

function isChecked(value: FormDataEntryValue | null): boolean {
  return value === 'on';
}

function formString(value: FormDataEntryValue | null): string {
  return typeof value === 'string' ? value : '';
}

function authFailure(status: WebAuthFailure['status'], message: string): WebAuthFailure {
  return {
    ok: false,
    status,
    message
  };
}

function mutationFailure<Field extends string>(
  status: WebMutationFailure<Field>['status'],
  field: Field,
  message: string
): WebMutationFailure<Field> {
  return {
    ok: false,
    status,
    field,
    message
  };
}
