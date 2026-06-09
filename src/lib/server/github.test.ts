import { strict as assert } from 'node:assert';
import { afterEach, test } from 'node:test';
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

test('resolveGitHubApiUrl rejects cross-origin absolute next URLs', () => {
  const config = readConfig({
    NULLBUILDER_GITHUB_API_URL: 'https://api.github.com',
    NULLBUILDER_REPOS: 'nullbuilder'
  });

  assert.throws(
    () => resolveGitHubApiUrl(config, 'https://evil.example.test/repos/nullclaw/nullbuilder'),
    /Invalid GitHub API URL/
  );
});

test('publicErrorMessage keeps GitHub authorization details generic', () => {
  assert.equal(
    publicErrorMessage(new GitHubApiError('GitHub 403 Forbidden: secret detail', 403)),
    'GitHub API authorization or rate-limit error (403).'
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
