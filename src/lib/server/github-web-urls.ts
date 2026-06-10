import { DEFAULT_OWNER, normalizeOwner, type RepoSlug } from '../repositories';
import { encodeGitHubPathSegment } from './github-url-encoding';

const DEFAULT_GITHUB_WEB_BASE_URL = 'https://github.com';
const UNSAFE_GITHUB_WEB_URL_CHARACTER_PATTERN = /[\u0000-\u0020\u007f-\u009f"'<>`\\{}|]/;
const ENCODED_CONTROL_CHARACTER_PATTERN = /%(?:0[0-9a-f]|1[0-9a-f]|7f)|%c2%(?:8[0-9a-f]|9[0-9a-f])/i;

export const MAX_GITHUB_WEB_URL_LENGTH = 2048;

export type GitHubWebUrlContext = {
  repositoryUrl: string;
  repositoryOrigin: string;
  repositoryPathPrefix: string;
};

export const EMPTY_GITHUB_WEB_URL_CONTEXT: GitHubWebUrlContext = {
  repositoryUrl: '',
  repositoryOrigin: '',
  repositoryPathPrefix: ''
};

export function githubRepositoryWebUrl(webBaseUrl: string, repo: RepoSlug): string {
  const normalizedWebBaseUrl = webBaseUrl.replace(/\/+$/, '');
  const fallback = `${DEFAULT_GITHUB_WEB_BASE_URL}/${repo}`;
  return safeGitHubWebUrl(`${normalizedWebBaseUrl}/${repo}`, fallback);
}

export function githubOwnerWebUrl(webBaseUrl: string, owner: string): string {
  const normalizedOwner = safeOwner(owner);
  const normalizedWebBaseUrl = webBaseUrl.replace(/\/+$/, '');
  const fallback = `${DEFAULT_GITHUB_WEB_BASE_URL}/${normalizedOwner}`;
  return safeGitHubWebUrl(`${normalizedWebBaseUrl}/${normalizedOwner}`, fallback);
}

export function githubRepositoryUrlContext(
  webBaseUrl: string,
  repo: RepoSlug,
  repositoryHtmlUrl = ''
): GitHubWebUrlContext {
  const repositoryUrlFallback = githubRepositoryWebUrl(webBaseUrl, repo);
  const fallbackUrl = new URL(repositoryUrlFallback);
  const repositoryOrigin = fallbackUrl.origin;
  const repositoryPathPrefix = fallbackUrl.pathname;
  const repositoryUrl = safeGitHubRepositoryRootUrl(
    repositoryHtmlUrl,
    repositoryUrlFallback,
    repositoryOrigin,
    repositoryPathPrefix
  );
  return { repositoryUrl, repositoryOrigin, repositoryPathPrefix };
}

export function githubActionsUrl(context: GitHubWebUrlContext): string {
  return context.repositoryUrl ? `${context.repositoryUrl}/actions` : '';
}

export function githubReleaseTagUrl(context: GitHubWebUrlContext, tagName: string): string {
  return context.repositoryUrl ? `${context.repositoryUrl}/releases/tag/${encodeGitHubPathSegment(tagName)}` : '';
}

export function githubActionsBranchQueryUrl(context: GitHubWebUrlContext, branch: string): string {
  return context.repositoryUrl
    ? `${githubActionsUrl(context)}?query=${encodeURIComponent(`branch:${branch}`)}`
    : '';
}

export function safeGitHubWebUrl(value: unknown, fallback: string, allowedOrigin = '', allowedPathPrefix = ''): string {
  return isSafeGitHubWebUrl(value, allowedOrigin, allowedPathPrefix) ? value : fallback;
}

function safeGitHubRepositoryRootUrl(
  value: unknown,
  fallback: string,
  allowedOrigin: string,
  allowedPathPrefix: string
): string {
  if (!isSafeGitHubWebUrl(value, allowedOrigin, allowedPathPrefix)) {
    return fallback;
  }

  const url = new URL(value);
  const pathMatchesRepositoryRoot = url.pathname === allowedPathPrefix || url.pathname === `${allowedPathPrefix}/`;
  if (!pathMatchesRepositoryRoot || url.search !== '' || url.hash !== '') {
    return fallback;
  }

  return url.toString().replace(/\/$/, '');
}

function isSafeGitHubWebUrl(value: unknown, allowedOrigin: string, allowedPathPrefix: string): value is string {
  if (typeof value !== 'string') {
    return false;
  }

  if (
    value.length === 0 ||
    value.length > MAX_GITHUB_WEB_URL_LENGTH ||
    UNSAFE_GITHUB_WEB_URL_CHARACTER_PATTERN.test(value) ||
    ENCODED_CONTROL_CHARACTER_PATTERN.test(value)
  ) {
    return false;
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return false;
  }

  if (url.username !== '' || url.password !== '') {
    return false;
  }

  if (allowedOrigin !== '' && url.origin !== allowedOrigin) {
    return false;
  }

  return allowedPathPrefix === '' || isPathWithinPrefix(url.pathname, allowedPathPrefix);
}

function safeOwner(owner: string): string {
  try {
    return normalizeOwner(owner);
  } catch {
    return DEFAULT_OWNER;
  }
}

function isPathWithinPrefix(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}
