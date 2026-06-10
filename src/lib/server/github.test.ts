import { strict as assert } from 'node:assert';
import { afterEach, test } from 'node:test';
import { MAX_REPOSITORY_LIST_ENTRIES } from '../repositories';
import { readConfig } from './config';
import { discoverRepositories, GitHubApiError, publicErrorMessage, resolveGitHubApiUrl } from './github';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test('resolveGitHubApiUrl appends relative paths to configured API base', () => {
  const config = readConfig({
    NULLBUILDER_GITHUB_API_URL: 'https://github.example.test/api/v3',
    NULLBUILDER_REPOS: 'nullbuilder'
  });

  assert.equal(
    resolveGitHubApiUrl(config, '/repos/nullclaw/nullbuilder'),
    'https://github.example.test/api/v3/repos/nullclaw/nullbuilder'
  );
});

test('resolveGitHubApiUrl validates relative paths before URL normalization', () => {
  const config = readConfig({
    NULLBUILDER_GITHUB_API_URL: 'https://github.example.test/api/v3',
    NULLBUILDER_REPOS: 'nullbuilder'
  });

  assert.equal(
    resolveGitHubApiUrl(config, '/repos/nullclaw/nullbuilder#ignored'),
    'https://github.example.test/api/v3/repos/nullclaw/nullbuilder'
  );

  for (const path of [
    '/../meta',
    '/%2e%2e/meta',
    '//evil.example.test/repos',
    '/repos\nsecret',
    '/repos/%0asecret',
    '/repos/%7Fsecret',
    '/repos/%C2%85secret'
  ]) {
    assert.throws(
      () => resolveGitHubApiUrl(config, path),
      (error: unknown) => error instanceof Error && error.message === 'Invalid GitHub API path.'
    );
  }
});

test('resolveGitHubApiUrl rejects cross-origin absolute next URLs', () => {
  const config = readConfig({
    NULLBUILDER_GITHUB_API_URL: 'https://api.github.com',
    NULLBUILDER_REPOS: 'nullbuilder'
  });

  assert.throws(
    () => resolveGitHubApiUrl(config, 'not-a-url\nsecret'),
    (error: unknown) => error instanceof Error && error.message === 'Invalid GitHub API path.'
  );

  assert.throws(
    () => resolveGitHubApiUrl(config, 'https://evil.example.test/repos/nullclaw/nullbuilder'),
    (error: unknown) => error instanceof Error && error.message === 'Invalid GitHub API URL.'
  );

  for (const url of [
    'https://token@api.github.com/repos/nullclaw/nullbuilder',
    'https://user:token@api.github.com/repos/nullclaw/nullbuilder',
    'https://api.github.com/repos/nullclaw/nullbuilder/%0asecret',
    'https://api.github.com/repos/nullclaw/nullbuilder/%C2%85secret'
  ]) {
    assert.throws(
      () => resolveGitHubApiUrl(config, url),
      (error: unknown) => error instanceof Error && error.message === 'Invalid GitHub API URL.'
    );
  }
});

test('publicErrorMessage keeps GitHub authorization details generic', () => {
  assert.equal(
    publicErrorMessage(new GitHubApiError('GitHub 403 Forbidden: secret detail', 403)),
    'GitHub API authorization or rate-limit error (403).'
  );
  assert.equal(
    publicErrorMessage(new Error('Invalid GitHub API URL: https://evil.example.test/repos?token=secret')),
    'Invalid GitHub API URL.'
  );
});

test('discoverRepositories normalizes API repository slugs before adding them', async () => {
  const config = readConfig({
    NULLBUILDER_REPOS: 'nullbuilder',
    NULLBUILDER_GITHUB_API_URL: 'https://discover.example.test',
    NULLBUILDER_CACHE_TTL_MS: '0'
  });
  const requests: string[] = [];

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    requests.push(String(input));
    return new Response(
      JSON.stringify([
        {
          name: 'nullbuilder',
          full_name: 'nullclaw/nullbuilder',
          language: 'TypeScript',
          archived: false
        },
        {
          name: 'nullthing',
          full_name: 'nullclaw/nullthing',
          language: 'TypeScript',
          archived: false
        },
        {
          name: 'utility',
          full_name: 'nullclaw/utility',
          language: 'Zig',
          archived: false
        },
        {
          name: 'nullbad',
          full_name: 'nullclaw/../nullbad',
          language: 'Zig',
          archived: false
        },
        {
          name: 'sentry-zig',
          full_name: 'nullclaw/sentry-zig',
          language: 'Zig',
          archived: false
        },
        {
          name: 'archived-zig',
          full_name: 'nullclaw/archived-zig',
          language: 'Zig',
          archived: true
        },
        {
          name: 'website',
          full_name: 'nullclaw/website',
          language: 'TypeScript',
          archived: false
        }
      ])
    );
  }) as typeof fetch;

  assert.deepEqual(await discoverRepositories(config), [
    'nullclaw/nullbuilder',
    'nullclaw/nullthing',
    'nullclaw/utility'
  ]);
  assert.deepEqual(requests, ['https://discover.example.test/users/nullclaw/repos?type=owner&sort=updated&per_page=100']);
});

test('discoverRepositories skips malformed API repository entries', async () => {
  const config = readConfig({
    NULLBUILDER_REPOS: 'nullbuilder',
    NULLBUILDER_GITHUB_API_URL: 'https://discover-malformed.example.test',
    NULLBUILDER_CACHE_TTL_MS: '0'
  });

  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify([
        null,
        'not-a-repo',
        {
          full_name: 'nullclaw/missing-name',
          language: 'Zig',
          archived: false
        },
        {
          name: 42,
          full_name: 'nullclaw/bad-name',
          language: 'Zig',
          archived: false
        },
        {
          name: 'nullthing',
          full_name: 'nullclaw/nullthing',
          language: 7,
          archived: false
        },
        {
          name: 'utility',
          full_name: 'nullclaw/utility',
          language: 'Zig',
          archived: 'false'
        }
      ])
    )) as typeof fetch;

  assert.deepEqual(await discoverRepositories(config), [
    'nullclaw/nullbuilder',
    'nullclaw/nullthing',
    'nullclaw/utility'
  ]);
});

test('discoverRepositories caps discovered repositories before dashboard fan-out', async () => {
  const config = readConfig({
    NULLBUILDER_REPOS: 'nullbuilder',
    NULLBUILDER_GITHUB_API_URL: 'https://discover-cap.example.test',
    NULLBUILDER_CACHE_TTL_MS: '0'
  });
  const discovered = Array.from({ length: MAX_REPOSITORY_LIST_ENTRIES + 5 }, (_, index) => {
    const name = `nullrepo${String(index).padStart(4, '0')}`;
    return {
      name,
      full_name: `nullclaw/${name}`,
      language: 'TypeScript',
      archived: false
    };
  });

  globalThis.fetch = (async () => new Response(JSON.stringify(discovered))) as typeof fetch;

  const repos = await discoverRepositories(config);

  assert.equal(repos.length, MAX_REPOSITORY_LIST_ENTRIES);
  assert.equal(repos.includes('nullclaw/nullbuilder'), true);
  assert.equal(repos.includes('nullclaw/nullrepo0998'), true);
  assert.equal(repos.includes('nullclaw/nullrepo0999'), false);
});
