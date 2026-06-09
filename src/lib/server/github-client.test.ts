import { strict as assert } from 'node:assert';
import { afterEach, test } from 'node:test';
import { readConfig } from './config';
import { GITHUB_RESPONSE_CACHE_MAX_ENTRIES, GitHubApiError, githubGetPages, githubRequest } from './github-client';

const originalFetch = globalThis.fetch;
const originalDateNow = Date.now;

afterEach(() => {
  globalThis.fetch = originalFetch;
  Date.now = originalDateNow;
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

test('githubRequest shares in-flight cacheable GET responses', async () => {
  const config = readConfig({
    NULLBUILDER_REPOS: 'nullbuilder',
    NULLBUILDER_GITHUB_API_URL: 'https://inflight-cache.example.test',
    NULLBUILDER_CACHE_TTL_MS: '60000'
  });
  const requests: string[] = [];
  let releaseFetch: (() => void) | undefined;

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    requests.push(String(input));
    await new Promise<void>((resolve) => {
      releaseFetch = resolve;
    });
    return new Response(JSON.stringify({ id: requests.length }));
  }) as typeof fetch;

  const first = githubRequest<{ id: number }>(config, '/repos/nullclaw/nullbuilder');
  const second = githubRequest<{ id: number }>(config, '/repos/nullclaw/nullbuilder');

  assert.equal(requests.length, 1);
  assert.ok(releaseFetch);
  releaseFetch?.();

  assert.deepEqual(await Promise.all([first, second]), [{ id: 1 }, { id: 1 }]);
  assert.deepEqual(await githubRequest<{ id: number }>(config, '/repos/nullclaw/nullbuilder'), { id: 1 });
  assert.deepEqual(requests, ['https://inflight-cache.example.test/repos/nullclaw/nullbuilder']);
});

test('githubRequest keeps caller-abortable GET requests independent', async () => {
  const config = readConfig({
    NULLBUILDER_REPOS: 'nullbuilder',
    NULLBUILDER_GITHUB_API_URL: 'https://abortable-cache.example.test',
    NULLBUILDER_CACHE_TTL_MS: '60000'
  });
  const requests: string[] = [];
  const releaseFetches: Array<() => void> = [];

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const id = requests.push(String(input));
    await new Promise<void>((resolve) => {
      releaseFetches.push(resolve);
    });
    return new Response(JSON.stringify({ id }));
  }) as typeof fetch;

  const firstController = new AbortController();
  const secondController = new AbortController();
  const first = githubRequest<{ id: number }>(config, '/repos/nullclaw/nullbuilder', {
    signal: firstController.signal
  });
  const second = githubRequest<{ id: number }>(config, '/repos/nullclaw/nullbuilder', {
    signal: secondController.signal
  });

  assert.equal(requests.length, 2);
  assert.equal(releaseFetches.length, 2);
  releaseFetches.forEach((release) => release());

  assert.deepEqual(await Promise.all([first, second]), [{ id: 1 }, { id: 2 }]);
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

test('githubRequest revalidates stale cached GET responses with ETags', async () => {
  const config = readConfig({
    NULLBUILDER_REPOS: 'nullbuilder',
    NULLBUILDER_GITHUB_API_URL: 'https://etag-cache.example.test',
    NULLBUILDER_CACHE_TTL_MS: '1'
  });
  const requests: Array<{ url: string; ifNoneMatch: string | null }> = [];
  let now = 1_000;
  Date.now = () => now;

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    requests.push({
      url: String(input),
      ifNoneMatch: headers.get('If-None-Match')
    });

    if (requests.length === 1) {
      return new Response(JSON.stringify({ id: 1 }), {
        headers: {
          ETag: '"repo-v1"'
        }
      });
    }

    return new Response(null, { status: 304 });
  }) as typeof fetch;

  const first = await githubRequest<{ id: number }>(config, '/repos/nullclaw/nullbuilder');
  now = 1_002;
  const second = await githubRequest<{ id: number }>(config, '/repos/nullclaw/nullbuilder');

  assert.deepEqual(first, { id: 1 });
  assert.deepEqual(second, { id: 1 });
  assert.deepEqual(requests, [
    {
      url: 'https://etag-cache.example.test/repos/nullclaw/nullbuilder',
      ifNoneMatch: null
    },
    {
      url: 'https://etag-cache.example.test/repos/nullclaw/nullbuilder',
      ifNoneMatch: '"repo-v1"'
    }
  ]);
});

test('githubRequest returns undefined for no-content responses', async () => {
  const config = readConfig({
    NULLBUILDER_REPOS: 'nullbuilder',
    NULLBUILDER_GITHUB_API_URL: 'https://no-content.example.test',
    NULLBUILDER_CACHE_TTL_MS: '0'
  });

  globalThis.fetch = (async () => new Response(null, { status: 204 })) as typeof fetch;

  assert.equal(await githubRequest<void>(config, '/repos/nullclaw/nullbuilder', { method: 'DELETE' }), undefined);
});

test('githubRequest ignores non-string GitHub error messages', async () => {
  const config = readConfig({
    NULLBUILDER_REPOS: 'nullbuilder',
    NULLBUILDER_GITHUB_API_URL: 'https://non-string-error.example.test',
    NULLBUILDER_CACHE_TTL_MS: '0'
  });

  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ message: { text: 'private upstream detail' } }), {
      status: 500,
      statusText: 'Server Error'
    })) as typeof fetch;

  await assert.rejects(
    githubRequest(config, '/repos/nullclaw/nullbuilder'),
    (error: unknown) =>
      error instanceof GitHubApiError &&
      error.status === 500 &&
      error.message === 'GitHub 500 Server Error'
  );
});

test('githubRequest keeps malformed rate-limit reset headers from masking API errors', async () => {
  const config = readConfig({
    NULLBUILDER_REPOS: 'nullbuilder',
    NULLBUILDER_GITHUB_API_URL: 'https://rate-limit.example.test',
    NULLBUILDER_CACHE_TTL_MS: '0'
  });

  for (const reset of ['not-a-timestamp', '1760000000.5', '1e3', '0', '9007199254740992']) {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ message: 'rate limited' }), {
        status: 403,
        statusText: 'Forbidden',
        headers: {
          'X-RateLimit-Remaining': '0',
          'X-RateLimit-Reset': reset
        }
      })) as typeof fetch;

    await assert.rejects(
      githubRequest(config, `/repos/nullclaw/nullbuilder-${reset}`),
      (error: unknown) =>
        error instanceof GitHubApiError &&
        error.status === 403 &&
        error.message === 'GitHub 403 Forbidden: rate limited'
    );
  }
});

test('githubRequest includes valid rate-limit reset timestamps in API errors', async () => {
  const config = readConfig({
    NULLBUILDER_REPOS: 'nullbuilder',
    NULLBUILDER_GITHUB_API_URL: 'https://rate-limit-reset.example.test',
    NULLBUILDER_CACHE_TTL_MS: '0'
  });

  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ message: 'rate limited' }), {
      status: 403,
      statusText: 'Forbidden',
      headers: {
        'X-RateLimit-Remaining': '0',
        'X-RateLimit-Reset': '1760000000'
      }
    })) as typeof fetch;

  await assert.rejects(
    githubRequest(config, '/repos/nullclaw/nullbuilder'),
    (error: unknown) =>
      error instanceof GitHubApiError &&
      error.status === 403 &&
      error.message === 'GitHub 403 Forbidden: rate limited; rate limit resets at 2025-10-09T08:53:20.000Z'
  );
});
