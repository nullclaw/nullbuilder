import type { Cookies } from '@sveltejs/kit';
import { isAuthenticated, isCsrfTokenMatch } from './auth';
import type { NullbuilderConfig } from './config';

export type WebMutationOperation = 'build-pr' | 'release-tag';

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

  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function trimmedFormString(value: FormDataEntryValue | null): string {
  return typeof value === 'string' ? value.trim() : '';
}

function isChecked(value: FormDataEntryValue | null): boolean {
  return value === 'on';
}
