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
export type RepoSlugParts = {
  owner: string;
  name: string;
};

const OWNER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const REPO_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,98}[A-Za-z0-9])?$/;
const REPOSITORY_LIST_SEPARATOR_PATTERN = /[\s,]/u;
const NON_WHITESPACE_PATTERN = /\S/u;
const MAX_OWNER_CHARS = 39;
const MAX_REPO_CHARS = 100;
const MAX_OWNER_INPUT_CHARS = 128;
const MAX_REPOSITORY_SLUG_CHARS = MAX_OWNER_CHARS + 1 + MAX_REPO_CHARS;
const MAX_REPOSITORY_SLUG_INPUT_CHARS = 512;
const MAX_REPOSITORY_LIST_CHARS = 256 * 1024;
export const MAX_REPOSITORY_LIST_ENTRIES = 1000;

export function normalizeRepoSlug(value: unknown, defaultOwner: unknown = DEFAULT_OWNER): RepoSlug {
  if (typeof value !== 'string') {
    throw new Error('Invalid repository slug.');
  }

  if (value.length > MAX_REPOSITORY_SLUG_INPUT_CHARS) {
    throw new Error('Repository slug is too large.');
  }

  const trimmed = value.trim();
  const normalizedDefaultOwner = normalizeOwner(defaultOwner);

  if (!trimmed) {
    throw new Error('Repository name cannot be empty.');
  }

  if (trimmed.length > MAX_REPOSITORY_SLUG_CHARS) {
    throw new Error('Repository slug is too large.');
  }

  const slashIndex = trimmed.indexOf('/');
  if (slashIndex !== -1) {
    if (slashIndex !== trimmed.lastIndexOf('/')) {
      throw new Error('Invalid repository slug.');
    }
    const owner = trimmed.slice(0, slashIndex);
    const repo = trimmed.slice(slashIndex + 1);
    validateOwner(owner);
    validateRepo(repo);
    return `${owner}/${repo}`;
  }

  validateRepo(trimmed);
  return `${normalizedDefaultOwner}/${trimmed}`;
}

export function normalizeOwner(value: unknown): string {
  if (typeof value !== 'string') {
    throw new Error('Invalid repository owner.');
  }

  if (value.length > MAX_OWNER_INPUT_CHARS) {
    throw new Error('Repository owner is too large.');
  }

  const owner = value.trim();
  validateOwner(owner);
  return owner;
}

export function parseRepositoryList(
  value: unknown,
  defaultOwner = DEFAULT_OWNER,
  fallback: readonly string[] = DEFAULT_REPOSITORIES
): RepoSlug[] {
  const source = repositoryListSource(value, fallback);
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

export function findConfiguredRepoSlug(
  configuredRepos: readonly RepoSlug[],
  value: unknown,
  defaultOwner: unknown = DEFAULT_OWNER
): RepoSlug | null {
  let repo: RepoSlug;
  try {
    repo = normalizeRepoSlug(value, defaultOwner);
  } catch {
    return null;
  }

  const key = repositoryKey(repo);
  for (const configuredRepo of configuredRepos) {
    if (repositoryKey(configuredRepo) === key) {
      return configuredRepo;
    }
  }

  return null;
}

export function repoSlugParts(repo: RepoSlug): RepoSlugParts {
  const slashIndex = repo.indexOf('/');
  if (slashIndex <= 0 || slashIndex >= repo.length - 1 || slashIndex !== repo.lastIndexOf('/')) {
    throw new Error('Invalid repository slug.');
  }

  return {
    owner: repo.slice(0, slashIndex),
    name: repo.slice(slashIndex + 1)
  };
}

function repositoryListSource(value: unknown, fallback: readonly string[]): string {
  if (value !== undefined) {
    if (typeof value !== 'string') {
      throw new Error('Invalid repository list.');
    }

    if (value.length > MAX_REPOSITORY_LIST_CHARS) {
      throw new Error('Repository list is too large.');
    }

    if (NON_WHITESPACE_PATTERN.test(value)) {
      return value;
    }
  }

  return fallback.join(',');
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

function repositoryKey(repo: RepoSlug): string {
  return repo.toLowerCase();
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
