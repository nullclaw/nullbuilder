import type { Cookies } from '@sveltejs/kit';
import {
  createSessionToken,
  isAuthenticated,
  isCsrfTokenMatch,
  isTokenMatch,
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

export function runLoginWebAction(
  config: NullbuilderConfig,
  rateLimiter: LoginRateLimiter,
  rateLimitKey: string,
  formData: FormData
): WebLoginResult {
  const token = formString(formData.get('webToken'));

  if (!config.webToken) {
    return authFailure(403, 'Set NULLBUILDER_WEB_TOKEN before exposing token-backed dashboard data.');
  }

  if (!rateLimiter.isAllowed(rateLimitKey)) {
    return authFailure(429, 'Too many failed login attempts. Try again later.');
  }

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

export function runLogoutWebAction(config: NullbuilderConfig, cookies: Cookies, formData: FormData): WebLogoutResult {
  if (config.webToken && isAuthenticated(cookies, config) && !isCsrfTokenMatch(formData.get('csrfToken'), cookies, config)) {
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

  if (!config.webToken || !isAuthenticated(cookies, config)) {
    return 'Web mutations require NULLBUILDER_WEB_TOKEN authentication.';
  }

  if (!isCsrfTokenMatch(csrfToken, cookies, config)) {
    return 'Invalid request token.';
  }

  return null;
}

export async function runBuildPrWebMutation<T>(
  config: NullbuilderConfig,
  cookies: Cookies,
  formData: FormData,
  execute: (input: BuildPrMutationInput) => Promise<T>,
  formatError: (error: unknown) => string
): Promise<WebMutationResult<T, 'buildError'>> {
  const accessError = mutationAccessError(config, cookies, formData.get('csrfToken'), 'build-pr');
  if (accessError) {
    return mutationFailure(403, 'buildError', accessError);
  }

  const buildForm = parseBuildPrMutationForm(formData);
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
  const accessError = mutationAccessError(config, cookies, formData.get('csrfToken'), 'release-tag');
  if (accessError) {
    return mutationFailure(403, 'releaseError', accessError);
  }

  const releaseForm = parseReleaseTagMutationForm(formData);
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
  const tagName = trimmedFormString(formData.get('tagName'));

  return {
    repo: trimmedFormString(formData.get('repo')),
    prNumber: parsePositiveFormInteger(formData.get('prNumber')),
    tagName: tagName || undefined,
    confirm: isChecked(formData.get('confirm')),
    force: isChecked(formData.get('force'))
  };
}

export function parseReleaseTagMutationForm(formData: FormData): ReleaseTagMutationForm {
  const targetRef = trimmedFormString(formData.get('targetRef'));

  return {
    repo: trimmedFormString(formData.get('repo')),
    tagName: trimmedFormString(formData.get('tagName')),
    targetRef: targetRef || undefined,
    confirm: isChecked(formData.get('confirm')),
    force: isChecked(formData.get('force'))
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
