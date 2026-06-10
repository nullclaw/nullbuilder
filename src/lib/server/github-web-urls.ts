import { DEFAULT_OWNER, normalizeOwner, type RepoSlug } from '../repositories';

const DEFAULT_GITHUB_WEB_BASE_URL = 'https://github.com';
const UNSAFE_GITHUB_WEB_URL_CHARACTER_PATTERN = /[\u0000-\u0020\u007f-\u009f"'<>`\\{}|]/;

export const MAX_GITHUB_WEB_URL_LENGTH = 2048;

export type GitHubWebUrlContext = {
  repositoryUrl: string;
  repositoryOrigin: string;
};

export const EMPTY_GITHUB_WEB_URL_CONTEXT: GitHubWebUrlContext = {
  repositoryUrl: '',
  repositoryOrigin: ''
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
  const repositoryOrigin = new URL(repositoryUrlFallback).origin;
  const repositoryUrl = safeGitHubWebUrl(repositoryHtmlUrl, repositoryUrlFallback, repositoryOrigin);
  return { repositoryUrl, repositoryOrigin };
}

export function githubActionsUrl(context: GitHubWebUrlContext): string {
  return context.repositoryUrl ? `${context.repositoryUrl}/actions` : '';
}

export function githubReleaseTagUrl(context: GitHubWebUrlContext, tagName: string): string {
  return context.repositoryUrl ? `${context.repositoryUrl}/releases/tag/${tagName}` : '';
}

export function githubActionsBranchQueryUrl(context: GitHubWebUrlContext, branch: string): string {
  return context.repositoryUrl
    ? `${githubActionsUrl(context)}?query=${encodeURIComponent(`branch:${branch}`)}`
    : '';
}

export function safeGitHubWebUrl(value: string, fallback: string, allowedOrigin = ''): string {
  return isSafeGitHubWebUrl(value, allowedOrigin) ? value : fallback;
}

function isSafeGitHubWebUrl(value: string, allowedOrigin: string): boolean {
  if (
    value.length === 0 ||
    value.length > MAX_GITHUB_WEB_URL_LENGTH ||
    UNSAFE_GITHUB_WEB_URL_CHARACTER_PATTERN.test(value)
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

  return allowedOrigin === '' || url.origin === allowedOrigin;
}

function safeOwner(owner: string): string {
  try {
    return normalizeOwner(owner);
  } catch {
    return DEFAULT_OWNER;
  }
}
