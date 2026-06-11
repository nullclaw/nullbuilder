import { DEFAULT_OWNER, normalizeOwner, type RepoSlug } from '../repositories';
import { hasUnsafeHttpUrlPathSyntax, safeHttpUrlText } from '../url-safety';
import { encodeGitHubPathSegment } from './github-url-encoding';

const DEFAULT_GITHUB_WEB_BASE_URL = 'https://github.com';

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
  const normalizedWebBaseUrl = normalizedGitHubWebBaseUrl(webBaseUrl);
  const fallback = `${DEFAULT_GITHUB_WEB_BASE_URL}/${repo}`;
  return safeGitHubWebUrl(`${normalizedWebBaseUrl}/${repo}`, fallback);
}

export function githubOwnerWebUrl(webBaseUrl: string, owner: string): string {
  const normalizedOwner = safeOwner(owner);
  const normalizedWebBaseUrl = normalizedGitHubWebBaseUrl(webBaseUrl);
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
  return safeGitHubWebUrlText(value, allowedOrigin, allowedPathPrefix) ?? fallback;
}

function safeGitHubRepositoryRootUrl(
  value: unknown,
  fallback: string,
  allowedOrigin: string,
  allowedPathPrefix: string
): string {
  const safeValue = safeGitHubWebUrlText(value, allowedOrigin, allowedPathPrefix);
  if (!safeValue) {
    return fallback;
  }

  const url = new URL(safeValue);
  const pathMatchesRepositoryRoot = url.pathname === allowedPathPrefix || url.pathname === `${allowedPathPrefix}/`;
  if (!pathMatchesRepositoryRoot || url.search !== '' || url.hash !== '') {
    return fallback;
  }

  return url.toString().replace(/\/$/, '');
}

function safeGitHubWebUrlText(value: unknown, allowedOrigin: string, allowedPathPrefix: string): string | null {
  const safeValue = safeHttpUrlText(value, { maxLength: MAX_GITHUB_WEB_URL_LENGTH });
  if (!safeValue) return null;

  let url: URL;
  try {
    url = new URL(safeValue);
  } catch {
    return null;
  }

  if (allowedOrigin !== '' && url.origin !== allowedOrigin) {
    return null;
  }

  return allowedPathPrefix === '' || isPathWithinPrefix(url.pathname, allowedPathPrefix) ? safeValue : null;
}

function normalizedGitHubWebBaseUrl(webBaseUrl: string): string {
  const safeBaseUrl = safeHttpUrlText(webBaseUrl, { maxLength: MAX_GITHUB_WEB_URL_LENGTH, trim: true });
  if (!safeBaseUrl || hasUnsafeHttpUrlPathSyntax(safeBaseUrl)) {
    return DEFAULT_GITHUB_WEB_BASE_URL;
  }

  let url: URL;
  try {
    url = new URL(safeBaseUrl);
  } catch {
    return DEFAULT_GITHUB_WEB_BASE_URL;
  }

  if (url.search || url.hash) {
    return DEFAULT_GITHUB_WEB_BASE_URL;
  }

  return url.toString().replace(/\/$/, '');
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
