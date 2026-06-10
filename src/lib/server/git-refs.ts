const FULL_GIT_SHA_PATTERN = /^[a-f0-9]{40}$/i;
const MAX_GIT_REF_NAME_LENGTH = 255;
const MAX_GIT_REF_INPUT_LENGTH = 1024;
const UNSAFE_GIT_REF_NAME_PATTERN = /[\u0000-\u001f\u007f ~^:?*[\]\\]/;

export function assertFullGitSha(value: unknown, label: string): string {
  if (!isFullGitSha(value)) {
    throw new Error(`Invalid ${label}.`);
  }

  return value;
}

export function isFullGitSha(value: unknown): value is string {
  if (typeof value !== 'string') {
    return false;
  }

  return FULL_GIT_SHA_PATTERN.test(value);
}

export function sanitizeGitBranchName(value: unknown, label = 'branch'): string {
  if (typeof value !== 'string' || value.length > MAX_GIT_REF_INPUT_LENGTH) {
    throw new Error(`Invalid ${label}.`);
  }

  const branchName = value.trim();

  if (!isSafeGitBranchName(branchName)) {
    throw new Error(`Invalid ${label}.`);
  }

  return branchName;
}

export function safeGitBranchName(value: unknown, fallback: string): string {
  try {
    return sanitizeGitBranchName(value);
  } catch {
    return fallback;
  }
}

export function sanitizeGitTargetRef(value: unknown, label = 'target ref'): string {
  if (typeof value !== 'string' || value.length > MAX_GIT_REF_INPUT_LENGTH) {
    throw new Error(`Invalid ${label}.`);
  }

  const targetRef = value.trim();

  if (isFullGitSha(targetRef) || isSafeGitBranchName(targetRef)) {
    return targetRef;
  }

  throw new Error(`Invalid ${label}.`);
}

function isSafeGitBranchName(branchName: string): boolean {
  if (!branchName || branchName.length > MAX_GIT_REF_NAME_LENGTH) {
    return false;
  }

  if (
    branchName.startsWith('refs/') ||
    branchName.startsWith('/') ||
    branchName.endsWith('/') ||
    branchName.endsWith('.') ||
    branchName.endsWith('.lock') ||
    branchName.includes('//') ||
    branchName.includes('..') ||
    branchName.includes('@{') ||
    UNSAFE_GIT_REF_NAME_PATTERN.test(branchName)
  ) {
    return false;
  }

  return branchName.split('/').every((part) => part && !part.startsWith('.') && !part.endsWith('.lock'));
}
