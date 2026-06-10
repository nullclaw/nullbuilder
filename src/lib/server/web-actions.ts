import type { Cookies } from '@sveltejs/kit';
import {
  createSessionToken,
  isTokenMatch,
  resolveAuthContext,
  type LoginRateLimiter
} from './auth';
import type { NullbuilderConfig } from './config';
import { sanitizeGitTargetRef } from './git-refs';
import { sanitizeBuildPrTagName, sanitizeReleaseTagName } from './tags';
import { normalizeRepoSlug, type RepoSlug } from '../repositories';
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
const WEB_ACTION_METHOD_INVALID_MESSAGE = 'Invalid request method.';
const WEB_ACTION_FORM_INVALID_MESSAGE = 'Invalid form body.';
const WEB_ACTION_FORM_TOO_LARGE_MESSAGE = 'Request body is too large.';
const TOO_MANY_FORM_FIELDS_MESSAGE = 'Too many form fields.';
const MAX_WEB_ACTION_CONTENT_LENGTH_HEADER = 32;
const MAX_WEB_ACTION_CONTENT_TYPE_HEADER = 128;
export const MAX_WEB_ACTION_FORM_BYTES = 16 * 1024;
const LOGIN_FORM_FIELDS = ['webToken'] as const;
const LOGOUT_FORM_FIELDS = ['csrfToken'] as const;
const BUILD_PR_FORM_FIELDS = ['repo', 'prNumber', 'tagName', 'confirm', 'force'] as const;
const RELEASE_TAG_FORM_FIELDS = ['repo', 'tagName', 'targetRef', 'confirm', 'force'] as const;
const BUILD_PR_ALLOWED_FORM_FIELDS = ['csrfToken', ...BUILD_PR_FORM_FIELDS] as const;
const RELEASE_TAG_ALLOWED_FORM_FIELDS = ['csrfToken', ...RELEASE_TAG_FORM_FIELDS] as const;
export const MAX_WEB_ACTION_FORM_FIELDS = Math.max(
  LOGIN_FORM_FIELDS.length,
  LOGOUT_FORM_FIELDS.length,
  BUILD_PR_ALLOWED_FORM_FIELDS.length,
  RELEASE_TAG_ALLOWED_FORM_FIELDS.length
);
const LOGIN_FORM_FIELD_SET = new Set<string>(LOGIN_FORM_FIELDS);
const LOGOUT_FORM_FIELD_SET = new Set<string>(LOGOUT_FORM_FIELDS);
const BUILD_PR_ALLOWED_FORM_FIELD_SET = new Set<string>(BUILD_PR_ALLOWED_FORM_FIELDS);
const RELEASE_TAG_ALLOWED_FORM_FIELD_SET = new Set<string>(RELEASE_TAG_ALLOWED_FORM_FIELDS);

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

  const form = parseAuthForm(formData, LOGIN_FORM_FIELD_SET, 'Invalid web token.');
  if (!form.ok) {
    rateLimiter.recordFailure(rateLimitKey);
    return form;
  }

  const token = formString(singleFormValue(formData, 'webToken'));
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

  const contentTypeFailure = webActionContentTypeFailure(request.headers);
  if (contentTypeFailure) {
    return contentTypeFailure;
  }

  const body = await readBoundedWebActionBody(request);
  if (!body.ok) {
    return body;
  }

  const headers = new Headers(request.headers);
  headers.delete('content-length');
  const boundedRequest = new Request(request.url, {
    method: request.method,
    headers,
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
  const form = parseAuthForm(formData, LOGOUT_FORM_FIELD_SET, 'Invalid request token.');
  if (!form.ok) {
    return form;
  }

  const csrfToken = singleFormValue(formData, 'csrfToken');
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

function parseAuthForm(formData: FormData, allowedFields: ReadonlySet<string>, message: string): WebAuthFailure | { ok: true } {
  try {
    assertFormShape(formData, allowedFields);
    return { ok: true };
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
  assertFormShape(formData, BUILD_PR_ALLOWED_FORM_FIELD_SET);
  const tagName = trimmedFormString(singleFormValue(formData, 'tagName'));

  return {
    repo: trimmedFormString(singleFormValue(formData, 'repo')),
    prNumber: parsePositiveFormInteger(singleFormValue(formData, 'prNumber')),
    tagName: tagName || undefined,
    confirm: isChecked(singleFormValue(formData, 'confirm')),
    force: isChecked(singleFormValue(formData, 'force'))
  };
}

export function parseReleaseTagMutationForm(formData: FormData): ReleaseTagMutationForm {
  assertFormShape(formData, RELEASE_TAG_ALLOWED_FORM_FIELD_SET);
  const targetRef = trimmedFormString(singleFormValue(formData, 'targetRef'));

  return {
    repo: trimmedFormString(singleFormValue(formData, 'repo')),
    tagName: trimmedFormString(singleFormValue(formData, 'tagName')),
    targetRef: targetRef || undefined,
    confirm: isChecked(singleFormValue(formData, 'confirm')),
    force: isChecked(singleFormValue(formData, 'force'))
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
  let repo: RepoSlug;
  try {
    repo = normalizeRepoSlug(value, config.owner);
  } catch {
    return null;
  }

  const key = repo.toLowerCase();
  return config.repos.find((entry) => entry.toLowerCase() === key) ?? null;
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

function assertFormShape(formData: FormData, allowedFields: ReadonlySet<string>): void {
  const seen = new Set<string>();
  let fieldCount = 0;

  for (const field of formData.keys()) {
    fieldCount += 1;
    if (fieldCount > MAX_WEB_ACTION_FORM_FIELDS) {
      throw new Error(TOO_MANY_FORM_FIELDS_MESSAGE);
    }

    if (!allowedFields.has(field)) {
      throw new Error(UNKNOWN_FORM_FIELD_MESSAGE);
    }

    if (seen.has(field)) {
      throw new Error(DUPLICATE_FORM_FIELD_MESSAGE);
    }
    seen.add(field);
  }
}

function singleFormValue(formData: FormData, field: string): FormDataEntryValue | null {
  let value: FormDataEntryValue | null = null;

  for (const [entryField, entryValue] of formData.entries()) {
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

function isInvalidFormShapeError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.message === DUPLICATE_FORM_FIELD_MESSAGE ||
      error.message === UNKNOWN_FORM_FIELD_MESSAGE ||
      error.message === TOO_MANY_FORM_FIELDS_MESSAGE)
  );
}

function isCsrfTokenValueMatch(value: FormDataEntryValue | null, expected: string | null): boolean {
  return typeof value === 'string' && Boolean(expected && isTokenMatch(value, expected));
}

function contentLengthExceedsWebActionLimit(value: string): boolean {
  const safeValue = readSafeTextInput(value, {
    maxLength: MAX_WEB_ACTION_CONTENT_LENGTH_HEADER,
    trim: true
  });
  if (!safeValue || !/^[0-9]+$/.test(safeValue)) {
    return true;
  }

  const parsed = Number(safeValue);
  return !Number.isSafeInteger(parsed) || parsed > MAX_WEB_ACTION_FORM_BYTES;
}

function webActionContentTypeFailure(headers: Headers): WebActionBodyParseFailure | null {
  return isWebActionFormContentType(headers.get('content-type')) ? null : webActionBodyParseFailure();
}

function webActionMethodFailure(request: Request): WebActionMethodFailure | null {
  return request.method === 'POST' ? null : webActionInvalidMethodFailure();
}

function isWebActionFormContentType(value: string | null): boolean {
  if (!value) {
    return false;
  }

  const safeValue = readSafeTextInput(value, {
    maxLength: MAX_WEB_ACTION_CONTENT_TYPE_HEADER,
    trim: true
  });
  if (!safeValue) {
    return false;
  }

  const separatorIndex = safeValue.indexOf(';');
  const mediaType = (separatorIndex === -1 ? safeValue : safeValue.slice(0, separatorIndex)).trim().toLowerCase();

  return mediaType === 'application/x-www-form-urlencoded' || mediaType === 'multipart/form-data';
}

async function readBoundedWebActionBody(request: Request): Promise<WebActionRequestBodySuccess | WebActionBodyLimitFailure> {
  if (!request.body) {
    return {
      ok: true,
      bytes: new Uint8Array()
    };
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      if (value.byteLength > MAX_WEB_ACTION_FORM_BYTES - totalBytes) {
        await reader.cancel().catch(() => undefined);
        return webActionBodyTooLargeFailure();
      }

      totalBytes += value.byteLength;
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  return {
    ok: true,
    bytes: joinBodyChunks(chunks, totalBytes)
  };
}

function joinBodyChunks(chunks: Uint8Array[], totalBytes: number): Uint8Array {
  if (chunks.length === 1 && chunks[0].byteLength === totalBytes) {
    return chunks[0];
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return bytes;
}

function arrayBufferFromBytes(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
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
