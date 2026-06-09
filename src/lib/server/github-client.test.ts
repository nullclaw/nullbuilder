import { strict as assert } from 'node:assert';
import { afterEach, test } from 'node:test';
import { readConfig } from './config';
import { GITHUB_RESPONSE_CACHE_MAX_ENTRIES, githubGetPages, githubRequest } from './github-client';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test('githubGetPages follows same-origin pagination links', async () => {
  const config = readConfig({
    NULLBUILDER_REPOS: 'nullbuilder',
    NULLBUILDER_GITHUB_API_URL: 'https://api.example.test',
    NULLBUILDER_CACHE_TTL_MS: '0'
  });
  const requests: string[] = [];

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    requests.push(url);

    if (requests.length === 1) {
      return new Response(JSON.stringify([{ id: 1 }]), {
        headers: {
          Link: '<https://api.example.test/repos?page=2>; rel="next"'
        }
      });
    }

    return new Response(JSON.stringify([{ id: 2 }]));
  }) as typeof fetch;

  const pages = await githubGetPages<{ id: number }>(config, '/repos', {}, 5);

  assert.deepEqual(pages, [{ id: 1 }, { id: 2 }]);
  assert.deepEqual(requests, ['https://api.example.test/repos', 'https://api.example.test/repos?page=2']);
});

test('githubRequest reuses fresh cached GET responses', async () => {
  const config = readConfig({
    NULLBUILDER_REPOS: 'nullbuilder',
    NULLBUILDER_GITHUB_API_URL: 'https://cache.example.test',
    NULLBUILDER_CACHE_TTL_MS: '60000'
  });
  const requests: string[] = [];

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    requests.push(String(input));
    return new Response(JSON.stringify({ id: requests.length }));
  }) as typeof fetch;

  const first = await githubRequest<{ id: number }>(config, '/repos/nullclaw/nullbuilder');
  const second = await githubRequest<{ id: number }>(config, '/repos/nullclaw/nullbuilder');

  assert.deepEqual(first, { id: 1 });
  assert.deepEqual(second, { id: 1 });
  assert.deepEqual(requests, ['https://cache.example.test/repos/nullclaw/nullbuilder']);
});

test('githubRequest bounds cached responses and evicts the oldest entry', async () => {
  const config = readConfig({
    NULLBUILDER_REPOS: 'nullbuilder',
    NULLBUILDER_GITHUB_API_URL: 'https://bounded-cache.example.test',
    NULLBUILDER_CACHE_TTL_MS: '60000'
  });
  const requests: string[] = [];

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    requests.push(url);
    return new Response(JSON.stringify({ url }));
  }) as typeof fetch;

  for (let index = 0; index <= GITHUB_RESPONSE_CACHE_MAX_ENTRIES; index += 1) {
    await githubRequest<{ url: string }>(config, `/repos/nullclaw/repo-${index}`);
  }

  await githubRequest<{ url: string }>(config, '/repos/nullclaw/repo-0');

  assert.equal(requests.length, GITHUB_RESPONSE_CACHE_MAX_ENTRIES + 2);
  assert.equal(requests.at(-1), 'https://bounded-cache.example.test/repos/nullclaw/repo-0');
});
