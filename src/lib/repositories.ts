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
const REPO_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,98}[A-Za-z0-9])?$/;
const REPOSITORY_LIST_SEPARATOR_PATTERN = /[\s,]/u;
const MAX_REPOSITORY_LIST_CHARS = 256 * 1024;
const MAX_REPOSITORY_LIST_ENTRIES = 1000;

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
  if (source.length > MAX_REPOSITORY_LIST_CHARS) {
    throw new Error('Repository list is too large.');
  }

  const seen = new Set<string>();
  const repos: RepoSlug[] = [];

  for (const entry of repositoryListEntries(source)) {
    const slug = normalizeRepoSlug(entry, defaultOwner);
    const key = slug.toLowerCase();
    if (!seen.has(key)) {
      if (repos.length >= MAX_REPOSITORY_LIST_ENTRIES) {
        throw new Error('Too many repositories configured.');
      }
      seen.add(key);
      repos.push(slug);
    }
  }

  return repos;
}

function* repositoryListEntries(source: string): Iterable<string> {
  let entryStart: number | null = null;

  for (let index = 0; index < source.length; index += 1) {
    if (isRepositoryListSeparator(source[index])) {
      if (entryStart !== null) {
        yield source.slice(entryStart, index);
        entryStart = null;
      }
      continue;
    }

    entryStart ??= index;
  }

  if (entryStart !== null) {
    yield source.slice(entryStart);
  }
}

function isRepositoryListSeparator(value: string): boolean {
  return REPOSITORY_LIST_SEPARATOR_PATTERN.test(value);
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
