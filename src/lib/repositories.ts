export const DEFAULT_OWNER = 'nullclaw';

export const DEFAULT_REPOSITORIES = [
  'nullbuilder',
  'nullclaw',
  'nullboiler',
  'nullhub',
  'nullPantry',
  'nllclw',
  'nulldesk',
  'nullwatch',
  'nulltickets',
  'nullcap'
] as const;

export const DEFAULT_IGNORED_REPOSITORIES = [
  'sentry-zig',
  'nullclaw-channel-whatsmeow-bridge',
  'nullclaw-channel-baileys',
  'nullclaw-channel-imap-connector',
  'wasm3',
  'websocket'
] as const;

export type RepoSlug = `${string}/${string}`;

const OWNER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const REPO_PATTERN = /^[A-Za-z0-9._-]{1,100}$/;

export function normalizeRepoSlug(value: string, defaultOwner = DEFAULT_OWNER): RepoSlug {
  const trimmed = value.trim();
  const owner = normalizeOwner(defaultOwner);

  if (!trimmed) {
    throw new Error('Repository name cannot be empty.');
  }

  if (trimmed.includes('/')) {
    const parts = trimmed.split('/');
    if (parts.length !== 2) {
      throw new Error('Invalid repository slug.');
    }
    const [owner, repo] = parts;
    validateOwner(owner);
    validateRepo(repo);
    return `${owner}/${repo}`;
  }

  validateRepo(trimmed);
  return `${owner}/${trimmed}`;
}

export function normalizeOwner(value: string): string {
  const owner = value.trim();
  validateOwner(owner);
  return owner;
}

export function parseRepositoryList(
  value: string | undefined,
  defaultOwner = DEFAULT_OWNER,
  fallback: readonly string[] = DEFAULT_REPOSITORIES
): RepoSlug[] {
  const source = value?.trim()
    ? value
    : fallback.join(',');

  const seen = new Set<string>();
  const repos: RepoSlug[] = [];

  for (const entry of source.split(/[\s,]+/)) {
    if (!entry.trim()) {
      continue;
    }

    const slug = normalizeRepoSlug(entry, defaultOwner);
    const key = slug.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      repos.push(slug);
    }
  }

  return repos;
}

function validateOwner(owner: string): void {
  if (!OWNER_PATTERN.test(owner)) {
    throw new Error('Invalid repository owner.');
  }
}

function validateRepo(repo: string): void {
  if (
    !REPO_PATTERN.test(repo) ||
    repo === '.' ||
    repo === '..' ||
    repo.includes('..') ||
    repo.toLowerCase().endsWith('.git')
  ) {
    throw new Error('Invalid repository name.');
  }
}
