import type { Cookies } from '@sveltejs/kit';
import {
  createSessionToken,
  isAuthenticated,
  isCsrfTokenMatch,
  isTokenMatch,
  type LoginRateLimiter
} from './auth';
import type { NullbuilderConfig } from './config';

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
  if (!buildForm.repo || !buildForm.prNumber) {
    return mutationFailure(400, 'buildError', 'Repository and a positive PR number are required.');
  }

  try {
    return {
      ok: true,
      result: await execute({
        repo: buildForm.repo,
        prNumber: buildForm.prNumber,
        tagName: buildForm.tagName,
        confirm: buildForm.confirm,
        force: buildForm.force
      })
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
  if (!releaseForm.repo || !releaseForm.tagName) {
    return mutationFailure(400, 'releaseError', 'Repository and release tag are required.');
  }

  try {
    return {
      ok: true,
      result: await execute({
        repo: releaseForm.repo,
        tagName: releaseForm.tagName,
        targetRef: releaseForm.targetRef,
        confirm: releaseForm.confirm,
        force: releaseForm.force
      })
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

  if (!/^[1-9]\d*$/.test(value)) {
    return null;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function trimmedFormString(value: FormDataEntryValue | null): string {
  return formString(value).trim();
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
