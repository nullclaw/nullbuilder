export const BUILD_PR_TAG_PREFIX = 'build-pr-';

const MAX_TAG_NAME_LENGTH = 120;
const SAFE_TAG_PATTERN = /^[A-Za-z0-9._-]+$/;

export function defaultBuildPrTagName(prNumber: number, sha: string): string {
  return `${BUILD_PR_TAG_PREFIX}${prNumber}-${sha.slice(0, 7)}`;
}

export function sanitizeBuildPrTagName(value: string): string {
  const tagName = value.trim();

  if (!tagName) {
    throw new Error('Tag name cannot be empty.');
  }

  if (!tagName.startsWith(BUILD_PR_TAG_PREFIX)) {
    throw new Error(`Build PR tag must start with ${BUILD_PR_TAG_PREFIX}.`);
  }

  if (!isSafeTagName(tagName)) {
    throw new Error(`Invalid tag name: ${value}`);
  }

  return tagName;
}

export function sanitizeReleaseTagName(value: string): string {
  const tagName = value.trim();

  if (!tagName) {
    throw new Error('Tag name cannot be empty.');
  }

  if (!tagName.startsWith('v')) {
    throw new Error('Release tag must start with v.');
  }

  if (!isSafeTagName(tagName)) {
    throw new Error(`Invalid tag name: ${value}`);
  }

  return tagName;
}

function isSafeTagName(tagName: string): boolean {
  return (
    tagName.length <= MAX_TAG_NAME_LENGTH &&
    SAFE_TAG_PATTERN.test(tagName) &&
    !tagName.startsWith('refs/') &&
    !tagName.includes('..') &&
    !tagName.endsWith('.')
  );
}
