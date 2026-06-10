import { strict as assert } from 'node:assert';
import { afterEach, test } from 'node:test';
import type { RepoSlug } from '../repositories';
import { readConfig } from './config';
import { getStarGrowth, STAR_PAGE_SIZE } from './github-star-growth';

const originalFetch = globalThis.fetch;
const originalDateNow = Date.now;
const REPO = 'nullclaw/nullbuilder' as RepoSlug;

afterEach(() => {
  globalThis.fetch = originalFetch;
  Date.now = originalDateNow;
});

test('getStarGrowth scans recent stargazer pages and stops at old pages', async () => {
  const config = readConfig({
    NULLBUILDER_REPOS: 'nullbuilder',
    NULLBUILDER_GITHUB_API_URL: 'https://stars.example.test',
    NULLBUILDER_CACHE_TTL_MS: '0'
  });
  const requests: string[] = [];
  const now = Date.parse('2026-06-09T00:00:00Z');

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    requests.push(url);

    if (url.endsWith('page=3')) {
      return jsonResponse([
        { starred_at: '2026-06-08T00:00:00Z' },
        { starred_at: '2026-05-25T00:00:00Z' },
        { starred_at: '2026-07-01T00:00:00Z' },
        { starred_at: 'not-a-date' },
        {}
      ]);
    }

    return jsonResponse([{ starred_at: '2026-04-01T00:00:00Z' }]);
  }) as typeof fetch;

  const growth = await getStarGrowth(config, REPO, 250, now);

  assert.deepEqual(growth, {
    current: 250,
    last7Days: 1,
    last30Days: 2
  });
  assert.deepEqual(requests, [
    'https://stars.example.test/repos/nullclaw/nullbuilder/stargazers?per_page=100&page=3',
    'https://stars.example.test/repos/nullclaw/nullbuilder/stargazers?per_page=100&page=2'
  ]);
});

test('getStarGrowth returns exact zeros without fetching for repositories with no stars', async () => {
  const config = readConfig({
    NULLBUILDER_REPOS: 'nullbuilder',
    NULLBUILDER_GITHUB_API_URL: 'https://zero-stars.example.test',
    NULLBUILDER_CACHE_TTL_MS: '0'
  });
  let requests = 0;

  globalThis.fetch = (async () => {
    requests += 1;
    return jsonResponse([]);
  }) as typeof fetch;

  assert.deepEqual(await getStarGrowth(config, REPO, 0), {
    current: 0,
    last7Days: 0,
    last30Days: 0
  });
  assert.equal(requests, 0);
});

test('getStarGrowth treats unsafe current stars as unknown without fetching', async () => {
  const config = readConfig({
    NULLBUILDER_REPOS: 'nullbuilder',
    NULLBUILDER_GITHUB_API_URL: 'https://unsafe-stars.example.test',
    NULLBUILDER_CACHE_TTL_MS: '0'
  });
  let requests = 0;

  globalThis.fetch = (async () => {
    requests += 1;
    return jsonResponse([]);
  }) as typeof fetch;

  assert.deepEqual(await getStarGrowth(config, REPO, Number.MAX_SAFE_INTEGER + 1), {
    current: null,
    last7Days: null,
    last30Days: null
  });
  assert.deepEqual(await getStarGrowth(config, REPO, -1), {
    current: null,
    last7Days: null,
    last30Days: null
  });
  assert.equal(requests, 0);
});

test('getStarGrowth treats unsafe clocks as unknown deltas without fetching', async () => {
  const config = readConfig({
    NULLBUILDER_REPOS: 'nullbuilder',
    NULLBUILDER_GITHUB_API_URL: 'https://unsafe-star-clock.example.test',
    NULLBUILDER_CACHE_TTL_MS: '0'
  });
  let requests = 0;
  Date.now = () => Number.POSITIVE_INFINITY;

  globalThis.fetch = (async () => {
    requests += 1;
    return jsonResponse([{ starred_at: '2026-06-08T00:00:00Z' }]);
  }) as typeof fetch;

  assert.deepEqual(await getStarGrowth(config, REPO, 12), {
    current: 12,
    last7Days: null,
    last30Days: null
  });
  assert.deepEqual(await getStarGrowth(config, REPO, 12, Number.MAX_SAFE_INTEGER + 1), {
    current: 12,
    last7Days: null,
    last30Days: null
  });
  assert.deepEqual(await getStarGrowth(config, REPO, 12, Number.NaN), {
    current: 12,
    last7Days: null,
    last30Days: null
  });
  assert.equal(requests, 0);
});

test('getStarGrowth rejects unsafe and non-UTC stargazer timestamps', async () => {
  const config = readConfig({
    NULLBUILDER_REPOS: 'nullbuilder',
    NULLBUILDER_GITHUB_API_URL: 'https://unsafe-star-dates.example.test',
    NULLBUILDER_CACHE_TTL_MS: '0'
  });
  const now = Date.parse('2026-06-09T00:00:00Z');

  globalThis.fetch = (async () =>
    jsonResponse([
      { starred_at: '2026-06-08T00:00:00Z' },
      { starred_at: '2026-06-01T00:00:00Z\nhidden' },
      { starred_at: '2026-06-02T00:00:00Z'.padEnd(128, 'x') },
      { starred_at: '2026-06-03' },
      { starred_at: '2026-06-04T00:00:00+00:00' },
      { starred_at: '2026-02-29T00:00:00Z' },
      { starred_at: 123 },
      null,
      '2026-06-08T00:00:00Z'
    ])) as typeof fetch;

  assert.deepEqual(await getStarGrowth(config, REPO, 1, now), {
    current: 1,
    last7Days: 1,
    last30Days: 1
  });
});

test('getStarGrowth bounds oversized stargazer pages to the API page size', async () => {
  const config = readConfig({
    NULLBUILDER_REPOS: 'nullbuilder',
    NULLBUILDER_GITHUB_API_URL: 'https://oversized-star-page.example.test',
    NULLBUILDER_CACHE_TTL_MS: '0'
  });
  const now = Date.parse('2026-06-09T00:00:00Z');

  globalThis.fetch = (async () =>
    jsonResponse(
      Array.from({ length: STAR_PAGE_SIZE + 25 }, (_, index) => ({
        starred_at: index < STAR_PAGE_SIZE ? '2026-06-08T00:00:00Z' : '2026-05-20T00:00:00Z'
      }))
    )) as typeof fetch;

  assert.deepEqual(await getStarGrowth(config, REPO, STAR_PAGE_SIZE, now), {
    current: STAR_PAGE_SIZE,
    last7Days: STAR_PAGE_SIZE,
    last30Days: STAR_PAGE_SIZE
  });
});

test('getStarGrowth preserves current stars and marks deltas unknown when GitHub fetch fails', async () => {
  const config = readConfig({
    NULLBUILDER_REPOS: 'nullbuilder',
    NULLBUILDER_GITHUB_API_URL: 'https://failed-stars.example.test',
    NULLBUILDER_CACHE_TTL_MS: '0'
  });

  globalThis.fetch = (async () => jsonResponse({ message: 'rate limited' }, 403)) as typeof fetch;

  assert.deepEqual(await getStarGrowth(config, REPO, 12), {
    current: 12,
    last7Days: null,
    last30Days: null
  });
});

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      'Content-Type': 'application/json'
    }
  });
}
