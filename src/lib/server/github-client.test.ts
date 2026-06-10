import { strict as assert } from 'node:assert';
import { afterEach, test } from 'node:test';
import { readConfig } from './config';
import {
  GITHUB_ABSOLUTE_MAX_PAGES,
  GITHUB_ACCEPT_HEADER_MAX_LENGTH,
  GITHUB_CONTENT_LENGTH_HEADER_MAX_LENGTH,
  GITHUB_DEFAULT_MAX_PAGES,
  GITHUB_ERROR_RESPONSE_MAX_BYTES,
  GITHUB_ERROR_MESSAGE_MAX_LENGTH,
  GITHUB_IN_FLIGHT_REQUEST_MAX_ENTRIES,
  GITHUB_JSON_RESPONSE_MAX_BYTES,
  GITHUB_LINK_HEADER_MAX_LENGTH,
  GITHUB_METHOD_MAX_LENGTH,
  GITHUB_PAGINATED_ITEMS_MAX,
  GITHUB_RATE_LIMIT_RESET_MAX_LENGTH,
  GITHUB_RESPONSE_CACHE_MAX_ENTRIES,
  GITHUB_STATUS_TEXT_MAX_LENGTH,
  GitHubApiError,
  githubGetPages,
  githubRequest
} from './github-client';

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

test('githubGetPages follows only explicit next link relations', async () => {
  const config = readConfig({
    NULLBUILDER_REPOS: 'nullbuilder',
    NULLBUILDER_GITHUB_API_URL: 'https://strict-link.example.test',
    NULLBUILDER_CACHE_TTL_MS: '0'
  });
  const requests: string[] = [];

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    requests.push(String(input));
    return new Response(JSON.stringify([{ id: 1 }]), {
      headers: {
        Link: '<https://strict-link.example.test/repos?page=2&rel="next">; rel="prev", <https://strict-link.example.test/repos?page=3>; rel="last"'
      }
    });
  }) as typeof fetch;

  const pages = await githubGetPages<{ id: number }>(config, '/repos', {}, 5);

  assert.deepEqual(pages, [{ id: 1 }]);
  assert.deepEqual(requests, ['https://strict-link.example.test/repos']);
});

test('githubGetPages keeps commas inside pagination link URLs', async () => {
  const config = readConfig({
    NULLBUILDER_REPOS: 'nullbuilder',
    NULLBUILDER_GITHUB_API_URL: 'https://comma-link.example.test',
    NULLBUILDER_CACHE_TTL_MS: '0'
  });
  const requests: string[] = [];

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    requests.push(url);

    if (requests.length === 1) {
      return new Response(JSON.stringify([{ id: 1 }]), {
        headers: {
          Link: '<https://comma-link.example.test/repos?page=2&cursor=a,b>; rel="next", <https://comma-link.example.test/repos?page=3>; rel="last"'
        }
      });
    }

    return new Response(JSON.stringify([{ id: 2 }]));
  }) as typeof fetch;

  const pages = await githubGetPages<{ id: number }>(config, '/repos', {}, 5);

  assert.deepEqual(pages, [{ id: 1 }, { id: 2 }]);
  assert.deepEqual(requests, [
    'https://comma-link.example.test/repos',
    'https://comma-link.example.test/repos?page=2&cursor=a,b'
  ]);
});

test('githubGetPages parses quoted pagination relation parameters', async () => {
  const config = readConfig({
    NULLBUILDER_REPOS: 'nullbuilder',
    NULLBUILDER_GITHUB_API_URL: 'https://quoted-link.example.test',
    NULLBUILDER_CACHE_TTL_MS: '0'
  });
  const requests: string[] = [];

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    requests.push(url);

    if (requests.length === 1) {
      return new Response(JSON.stringify([{ id: 1 }]), {
        headers: {
          Link: '<https://quoted-link.example.test/repos?page=2>; title="safe; title"; REL = "prev next"'
        }
      });
    }

    return new Response(JSON.stringify([{ id: 2 }]));
  }) as typeof fetch;

  const pages = await githubGetPages<{ id: number }>(config, '/repos', {}, 5);

  assert.deepEqual(pages, [{ id: 1 }, { id: 2 }]);
  assert.deepEqual(requests, [
    'https://quoted-link.example.test/repos',
    'https://quoted-link.example.test/repos?page=2'
  ]);
});

test('githubGetPages ignores relation parameters without next tokens', async () => {
  const config = readConfig({
    NULLBUILDER_REPOS: 'nullbuilder',
    NULLBUILDER_GITHUB_API_URL: 'https://not-next-link.example.test',
    NULLBUILDER_CACHE_TTL_MS: '0'
  });
  const requests: string[] = [];

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    requests.push(String(input));
    return new Response(JSON.stringify([{ id: 1 }]), {
      headers: {
        Link: '<https://not-next-link.example.test/repos?page=2>; rel="not-next newest"'
      }
    });
  }) as typeof fetch;

  const pages = await githubGetPages<{ id: number }>(config, '/repos', {}, 5);

  assert.deepEqual(pages, [{ id: 1 }]);
  assert.deepEqual(requests, ['https://not-next-link.example.test/repos']);
});

test('githubGetPages ignores oversized pagination link headers', async () => {
  const config = readConfig({
    NULLBUILDER_REPOS: 'nullbuilder',
    NULLBUILDER_GITHUB_API_URL: 'https://oversized-link.example.test',
    NULLBUILDER_CACHE_TTL_MS: '0'
  });
  const requests: string[] = [];

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    requests.push(String(input));
    return new Response(JSON.stringify([{ id: 1 }]), {
      headers: {
        Link: `${'x'.repeat(GITHUB_LINK_HEADER_MAX_LENGTH + 1)}, <https://oversized-link.example.test/repos?page=2>; rel="next"`
      }
    });
  }) as typeof fetch;

  const pages = await githubGetPages<{ id: number }>(config, '/repos', {}, 5);

  assert.deepEqual(pages, [{ id: 1 }]);
  assert.deepEqual(requests, ['https://oversized-link.example.test/repos']);
});

test('githubGetPages caps large pages without spreading array arguments', async () => {
  const config = readConfig({
    NULLBUILDER_REPOS: 'nullbuilder',
    NULLBUILDER_GITHUB_API_URL: 'https://large-page.example.test',
    NULLBUILDER_CACHE_TTL_MS: '0'
  });
  const page = Array.from({ length: 150_000 }, (_, index) => index);

  globalThis.fetch = (async () => new Response(JSON.stringify(page))) as typeof fetch;

  const values = await githubGetPages<number>(config, '/repos', {}, 1);

  assert.equal(values.length, GITHUB_PAGINATED_ITEMS_MAX);
  assert.equal(values[0], 0);
  assert.equal(values.at(-1), GITHUB_PAGINATED_ITEMS_MAX - 1);
});

test('githubGetPages stops once the total item cap is reached', async () => {
  const config = readConfig({
    NULLBUILDER_REPOS: 'nullbuilder',
    NULLBUILDER_GITHUB_API_URL: 'https://capped-items.example.test',
    NULLBUILDER_CACHE_TTL_MS: '0'
  });
  const requests: string[] = [];

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    requests.push(url);
    return new Response(JSON.stringify([{ id: requests.length * 2 - 1 }, { id: requests.length * 2 }]), {
      headers: {
        Link: `<https://capped-items.example.test/repos?page=${requests.length + 1}>; rel="next"`
      }
    });
  }) as typeof fetch;

  const values = await githubGetPages<{ id: number }>(config, '/repos', {}, 5, 3);

  assert.deepEqual(values, [{ id: 1 }, { id: 2 }, { id: 3 }]);
  assert.deepEqual(requests, ['https://capped-items.example.test/repos', 'https://capped-items.example.test/repos?page=2']);
});

test('githubGetPages normalizes unsafe page limits', async () => {
  const config = readConfig({
    NULLBUILDER_REPOS: 'nullbuilder',
    NULLBUILDER_GITHUB_API_URL: 'https://bounded-pages.example.test',
    NULLBUILDER_CACHE_TTL_MS: '0'
  });

  async function countRequests(maxPages: unknown): Promise<number> {
    let requests = 0;
    globalThis.fetch = (async () => {
      requests += 1;
      return new Response(JSON.stringify([{ id: requests }]), {
        headers: {
          Link: `<https://bounded-pages.example.test/repos?page=${requests + 1}>; rel="next"`
        }
      });
    }) as typeof fetch;

    await githubGetPages<{ id: number }>(config, '/repos', {}, maxPages);
    return requests;
  }

  assert.equal(await countRequests(0), 0);
  assert.equal(await countRequests(2.8), 2);
  assert.equal(await countRequests('2'), GITHUB_DEFAULT_MAX_PAGES);
  assert.equal(await countRequests(Number.NaN), GITHUB_DEFAULT_MAX_PAGES);
  assert.equal(await countRequests(Number.POSITIVE_INFINITY), GITHUB_DEFAULT_MAX_PAGES);
  assert.equal(await countRequests(GITHUB_ABSOLUTE_MAX_PAGES + 1), GITHUB_ABSOLUTE_MAX_PAGES);
});

test('githubGetPages normalizes unsafe item limits', async () => {
  const config = readConfig({
    NULLBUILDER_REPOS: 'nullbuilder',
    NULLBUILDER_GITHUB_API_URL: 'https://bounded-items.example.test',
    NULLBUILDER_CACHE_TTL_MS: '0'
  });
  const page = Array.from({ length: 5 }, (_, index) => ({ id: index + 1 }));
  let requests = 0;

  globalThis.fetch = (async () => {
    requests += 1;
    return new Response(JSON.stringify(page));
  }) as typeof fetch;

  assert.deepEqual(await githubGetPages<{ id: number }>(config, '/repos', {}, 1, 0), []);
  assert.equal(requests, 0);

  const values = await githubGetPages<{ id: number }>(config, '/repos', {}, 1, '3');

  assert.deepEqual(values, page);
  assert.equal(requests, 1);
});

test('githubGetPages rejects non-array paginated responses', async () => {
  const config = readConfig({
    NULLBUILDER_REPOS: 'nullbuilder',
    NULLBUILDER_GITHUB_API_URL: 'https://malformed-page.example.test',
    NULLBUILDER_CACHE_TTL_MS: '0'
  });

  for (const [index, page] of ['not-an-array', { items: [] }].entries()) {
    globalThis.fetch = (async () => new Response(JSON.stringify(page))) as typeof fetch;

    await assert.rejects(
      githubGetPages(config, `/repos?page=${index}`, {}, 1),
      (error: unknown) =>
        error instanceof Error && error.message === 'GitHub paginated response must be an array.'
    );
  }
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

test('githubRequest keeps cached response data isolated from caller mutations', async () => {
  type CachedPayload = {
    id: number;
    nested: {
      topics: string[];
    };
  };
  const config = readConfig({
    NULLBUILDER_REPOS: 'nullbuilder',
    NULLBUILDER_GITHUB_API_URL: 'https://cache-mutation.example.test',
    NULLBUILDER_CACHE_TTL_MS: '60000'
  });
  const requests: string[] = [];

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    requests.push(String(input));
    return new Response(JSON.stringify({ id: 1, nested: { topics: ['zig'] } }));
  }) as typeof fetch;

  const first = await githubRequest<CachedPayload>(config, '/repos/nullclaw/nullbuilder');
  first.nested.topics.push('mutated-first');

  const second = await githubRequest<CachedPayload>(config, '/repos/nullclaw/nullbuilder');
  second.nested.topics.push('mutated-second');

  const third = await githubRequest<CachedPayload>(config, '/repos/nullclaw/nullbuilder');

  assert.deepEqual(second, { id: 1, nested: { topics: ['zig', 'mutated-second'] } });
  assert.deepEqual(third, { id: 1, nested: { topics: ['zig'] } });
  assert.notEqual(first, second);
  assert.notEqual(second, third);
  assert.deepEqual(requests, ['https://cache-mutation.example.test/repos/nullclaw/nullbuilder']);
});

test('githubRequest bypasses cache writes and fresh hits while cache clock is unsafe', async () => {
  const config = readConfig({
    NULLBUILDER_REPOS: 'nullbuilder',
    NULLBUILDER_GITHUB_API_URL: 'https://unsafe-cache-clock.example.test',
    NULLBUILDER_CACHE_TTL_MS: '60000'
  });
  const requests: string[] = [];
  let now = 10_000;
  Date.now = () => now;

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    requests.push(String(input));
    return new Response(JSON.stringify({ id: requests.length }));
  }) as typeof fetch;

  const first = await githubRequest<{ id: number }>(config, '/repos/nullclaw/nullbuilder');
  Date.now = () => Number.MAX_SAFE_INTEGER + 1;
  const second = await githubRequest<{ id: number }>(config, '/repos/nullclaw/nullbuilder');
  now += 1;
  Date.now = () => now;
  const third = await githubRequest<{ id: number }>(config, '/repos/nullclaw/nullbuilder');

  assert.deepEqual(first, { id: 1 });
  assert.deepEqual(second, { id: 2 });
  assert.deepEqual(third, { id: 1 });
  assert.deepEqual(requests, [
    'https://unsafe-cache-clock.example.test/repos/nullclaw/nullbuilder',
    'https://unsafe-cache-clock.example.test/repos/nullclaw/nullbuilder'
  ]);
});

test('githubRequest keeps cached responses isolated by GitHub token', async () => {
  const baseEnv = {
    NULLBUILDER_REPOS: 'nullbuilder',
    NULLBUILDER_GITHUB_API_URL: 'https://token-cache.example.test',
    NULLBUILDER_CACHE_TTL_MS: '60000'
  };
  const firstConfig = readConfig({
    ...baseEnv,
    NULLBUILDER_GITHUB_TOKEN: 'github-token-a'
  });
  const secondConfig = readConfig({
    ...baseEnv,
    NULLBUILDER_GITHUB_TOKEN: 'github-token-b'
  });
  const requests: Array<{ url: string; authorization: string | null }> = [];

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({
      url: String(input),
      authorization: new Headers(init?.headers).get('Authorization')
    });
    return new Response(JSON.stringify({ id: requests.length }));
  }) as typeof fetch;

  assert.deepEqual(await githubRequest<{ id: number }>(firstConfig, '/repos/nullclaw/nullbuilder'), { id: 1 });
  assert.deepEqual(await githubRequest<{ id: number }>(secondConfig, '/repos/nullclaw/nullbuilder'), { id: 2 });
  assert.deepEqual(await githubRequest<{ id: number }>(firstConfig, '/repos/nullclaw/nullbuilder'), { id: 1 });

  assert.deepEqual(requests, [
    {
      url: 'https://token-cache.example.test/repos/nullclaw/nullbuilder',
      authorization: 'Bearer github-token-a'
    },
    {
      url: 'https://token-cache.example.test/repos/nullclaw/nullbuilder',
      authorization: 'Bearer github-token-b'
    }
  ]);
});

test('githubRequest keeps cache keys structured across delimiter-bearing inputs', async () => {
  const config = readConfig({
    NULLBUILDER_REPOS: 'nullbuilder',
    NULLBUILDER_GITHUB_API_URL: 'https://cache-key.example.test',
    NULLBUILDER_CACHE_TTL_MS: '60000'
  });
  const requests: Array<{ url: string; accept: string | null }> = [];

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    requests.push({
      url,
      accept: new Headers(init?.headers).get('Accept')
    });
    return new Response(JSON.stringify({ id: requests.length, url }));
  }) as typeof fetch;

  const first = await githubRequest<{ id: number; url: string }>(config, '/repos/first', {
    accept: 'first|https://cache-key.example.test/repos/second'
  });
  const second = await githubRequest<{ id: number; url: string }>(
    config,
    '/repos/second|https://cache-key.example.test/repos/first',
    {
      accept: 'first'
    }
  );
  const firstAgain = await githubRequest<{ id: number; url: string }>(config, '/repos/first', {
    accept: 'first|https://cache-key.example.test/repos/second'
  });

  assert.deepEqual(first, {
    id: 1,
    url: 'https://cache-key.example.test/repos/first'
  });
  assert.deepEqual(second, {
    id: 2,
    url: 'https://cache-key.example.test/repos/second|https://cache-key.example.test/repos/first'
  });
  assert.deepEqual(firstAgain, first);
  assert.deepEqual(requests, [
    {
      url: 'https://cache-key.example.test/repos/first',
      accept: 'first|https://cache-key.example.test/repos/second'
    },
    {
      url: 'https://cache-key.example.test/repos/second|https://cache-key.example.test/repos/first',
      accept: 'first'
    }
  ]);
});

test('githubRequest strips caller-supplied credential headers before fetching GitHub', async () => {
  const anonymousConfig = readConfig({
    NULLBUILDER_REPOS: 'nullbuilder',
    NULLBUILDER_GITHUB_API_URL: 'https://credentials.example.test',
    NULLBUILDER_CACHE_TTL_MS: '0'
  });
  const tokenConfig = readConfig({
    NULLBUILDER_REPOS: 'nullbuilder',
    NULLBUILDER_GITHUB_API_URL: 'https://credentials.example.test',
    NULLBUILDER_CACHE_TTL_MS: '0',
    NULLBUILDER_GITHUB_TOKEN: 'configured-token'
  });
  const requests: Array<{
    authorization: string | null;
    cookie: string | null;
    proxyAuthorization: string | null;
  }> = [];

  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    requests.push({
      authorization: headers.get('Authorization'),
      cookie: headers.get('Cookie'),
      proxyAuthorization: headers.get('Proxy-Authorization')
    });
    return new Response(JSON.stringify({ ok: true }));
  }) as typeof fetch;

  await githubRequest(anonymousConfig, '/repos/nullclaw/nullbuilder', {
    headers: {
      Authorization: 'Bearer caller-token',
      Cookie: 'session=caller-cookie',
      'Proxy-Authorization': 'Basic caller-proxy-token'
    }
  });
  await githubRequest(tokenConfig, '/repos/nullclaw/nullbuilder', {
    headers: {
      Authorization: 'Bearer caller-token',
      Cookie: 'session=caller-cookie',
      'Proxy-Authorization': 'Basic caller-proxy-token'
    }
  });

  assert.deepEqual(requests, [
    {
      authorization: null,
      cookie: null,
      proxyAuthorization: null
    },
    {
      authorization: 'Bearer configured-token',
      cookie: null,
      proxyAuthorization: null
    }
  ]);
});

test('githubRequest validates custom accept headers before fetching GitHub', async () => {
  const config = readConfig({
    NULLBUILDER_REPOS: 'nullbuilder',
    NULLBUILDER_GITHUB_API_URL: 'https://accept.example.test',
    NULLBUILDER_CACHE_TTL_MS: '0'
  });
  const accepts: Array<string | null> = [];

  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    accepts.push(new Headers(init?.headers).get('Accept'));
    return new Response(JSON.stringify({ ok: true }));
  }) as typeof fetch;

  await githubRequest(config, '/repos/nullclaw/nullbuilder', {
    accept: ' application/vnd.github.star+json '
  });

  for (const accept of ['', 'bad\naccept', 'x'.repeat(GITHUB_ACCEPT_HEADER_MAX_LENGTH + 1)]) {
    await assert.rejects(
      githubRequest(config, `/repos/nullclaw/nullbuilder-${accept.length}`, { accept }),
      (error: unknown) => error instanceof Error && error.message === 'Invalid GitHub accept header.'
    );
  }

  assert.deepEqual(accepts, ['application/vnd.github.star+json']);
});

test('githubRequest forces manual redirects before fetching GitHub', async () => {
  const config = readConfig({
    NULLBUILDER_REPOS: 'nullbuilder',
    NULLBUILDER_GITHUB_API_URL: 'https://redirect-policy.example.test',
    NULLBUILDER_CACHE_TTL_MS: '0'
  });
  const redirects: Array<RequestRedirect | undefined> = [];

  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    redirects.push(init?.redirect);
    return new Response(JSON.stringify({ ok: true }));
  }) as typeof fetch;

  await githubRequest(config, '/repos/nullclaw/nullbuilder');
  await githubRequest(config, '/repos/nullclaw/nullbuilder', {
    redirect: 'follow'
  });

  assert.deepEqual(redirects, ['manual', 'manual']);
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

test('githubRequest bounds in-flight cacheable GET coalescing entries', async () => {
  const config = readConfig({
    NULLBUILDER_REPOS: 'nullbuilder',
    NULLBUILDER_GITHUB_API_URL: 'https://bounded-inflight.example.test',
    NULLBUILDER_CACHE_TTL_MS: '60000'
  });
  const requests: string[] = [];
  const releaseFetches: Array<() => void> = [];

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    requests.push(url);
    await new Promise<void>((resolve) => {
      releaseFetches.push(resolve);
    });
    return new Response(JSON.stringify({ url }));
  }) as typeof fetch;

  const pendingRequests = Array.from({ length: GITHUB_IN_FLIGHT_REQUEST_MAX_ENTRIES + 1 }, (_, index) =>
    githubRequest<{ url: string }>(config, `/repos/nullclaw/repo-${index}`)
  );

  assert.equal(requests.length, GITHUB_IN_FLIGHT_REQUEST_MAX_ENTRIES + 1);

  const duplicateFirst = githubRequest<{ url: string }>(config, '/repos/nullclaw/repo-0');
  assert.equal(requests.length, GITHUB_IN_FLIGHT_REQUEST_MAX_ENTRIES + 2);
  assert.equal(requests.at(-1), 'https://bounded-inflight.example.test/repos/nullclaw/repo-0');

  releaseFetches.forEach((release) => release());
  await Promise.all([...pendingRequests, duplicateFirst]);
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
  const methods: Array<string | undefined> = [];

  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    methods.push(init?.method);
    return new Response(null, { status: 204 });
  }) as typeof fetch;

  assert.equal(await githubRequest<void>(config, '/repos/nullclaw/nullbuilder', { method: 'delete' }), undefined);
  assert.deepEqual(methods, ['DELETE']);
});

test('githubRequest validates request methods before fetching GitHub', async () => {
  const config = readConfig({
    NULLBUILDER_REPOS: 'nullbuilder',
    NULLBUILDER_GITHUB_API_URL: 'https://method.example.test',
    NULLBUILDER_CACHE_TTL_MS: '0'
  });
  let fetched = false;
  globalThis.fetch = (async () => {
    fetched = true;
    return new Response(JSON.stringify({ ok: true }));
  }) as typeof fetch;

  for (const method of ['', 'CONNECT', 'GET\nPOST', 'x'.repeat(GITHUB_METHOD_MAX_LENGTH + 1)]) {
    await assert.rejects(
      githubRequest(config, `/repos/nullclaw/nullbuilder-${method.length}`, { method }),
      (error: unknown) => error instanceof Error && error.message === 'Invalid GitHub request method.'
    );
  }

  assert.equal(fetched, false);
});

test('githubRequest rejects oversized JSON responses before parsing', async () => {
  const config = readConfig({
    NULLBUILDER_REPOS: 'nullbuilder',
    NULLBUILDER_GITHUB_API_URL: 'https://oversized-json.example.test',
    NULLBUILDER_CACHE_TTL_MS: '0'
  });

  globalThis.fetch = (async () =>
    new Response('{}', {
      headers: {
        'Content-Length': String(GITHUB_JSON_RESPONSE_MAX_BYTES + 1)
      }
    })) as typeof fetch;

  await assert.rejects(
    githubRequest(config, '/repos/nullclaw/nullbuilder'),
    (error: unknown) => error instanceof Error && error.message === 'GitHub response body is too large.'
  );
});

test('githubRequest rejects malformed UTF-8 JSON responses before parsing', async () => {
  const config = readConfig({
    NULLBUILDER_REPOS: 'nullbuilder',
    NULLBUILDER_GITHUB_API_URL: 'https://malformed-utf8.example.test',
    NULLBUILDER_CACHE_TTL_MS: '0'
  });

  globalThis.fetch = (async () => new Response(new Uint8Array([0xc0, 0x80]))) as typeof fetch;

  await assert.rejects(
    githubRequest(config, '/repos/nullclaw/nullbuilder'),
    (error: unknown) => error instanceof Error && error.message === 'GitHub response body is not valid UTF-8.'
  );
});

test('githubRequest rejects malformed JSON responses with a generic parse error', async () => {
  const config = readConfig({
    NULLBUILDER_REPOS: 'nullbuilder',
    NULLBUILDER_GITHUB_API_URL: 'https://malformed-json.example.test',
    NULLBUILDER_CACHE_TTL_MS: '0'
  });

  globalThis.fetch = (async () => new Response('{"private":"secret",')) as typeof fetch;

  await assert.rejects(
    githubRequest(config, '/repos/nullclaw/nullbuilder'),
    (error: unknown) =>
      error instanceof Error &&
      error.message === 'GitHub response body is not valid JSON.' &&
      !error.message.includes('secret')
  );
});

test('githubRequest releases response stream readers after successful reads', async () => {
  const config = readConfig({
    NULLBUILDER_REPOS: 'nullbuilder',
    NULLBUILDER_GITHUB_API_URL: 'https://released-stream.example.test',
    NULLBUILDER_CACHE_TTL_MS: '0'
  });
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"ok":true}'));
      controller.close();
    }
  });

  globalThis.fetch = (async () => new Response(stream)) as typeof fetch;

  assert.deepEqual(await githubRequest(config, '/repos/nullclaw/nullbuilder'), { ok: true });
  assert.equal(stream.locked, false);
});

test('githubRequest ignores empty streamed response chunks while enforcing limits', async () => {
  const config = readConfig({
    NULLBUILDER_REPOS: 'nullbuilder',
    NULLBUILDER_GITHUB_API_URL: 'https://empty-stream-chunks.example.test',
    NULLBUILDER_CACHE_TTL_MS: '0'
  });

  globalThis.fetch = (async () =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array());
          controller.enqueue(new TextEncoder().encode('{"ok":true}'));
          controller.enqueue(new Uint8Array());
          controller.close();
        }
      })
    )) as typeof fetch;

  assert.deepEqual(await githubRequest(config, '/repos/nullclaw/nullbuilder'), { ok: true });
});

test('githubRequest rejects malformed content-length before parsing', async () => {
  const config = readConfig({
    NULLBUILDER_REPOS: 'nullbuilder',
    NULLBUILDER_GITHUB_API_URL: 'https://malformed-content-length.example.test',
    NULLBUILDER_CACHE_TTL_MS: '0'
  });

  for (const contentLength of [
    '10junk',
    '1e9',
    '-1',
    '1.5',
    '9007199254740992',
    '0'.repeat(GITHUB_CONTENT_LENGTH_HEADER_MAX_LENGTH + 1)
  ]) {
    globalThis.fetch = (async () =>
      new Response('{}', {
        headers: {
          'Content-Length': contentLength
        }
      })) as typeof fetch;

    await assert.rejects(
      githubRequest(config, `/repos/nullclaw/nullbuilder-${contentLength}`),
      (error: unknown) => error instanceof Error && error.message === 'GitHub response body is too large.'
    );
  }
});

test('githubRequest bounds streamed JSON responses without content-length', async () => {
  const config = readConfig({
    NULLBUILDER_REPOS: 'nullbuilder',
    NULLBUILDER_GITHUB_API_URL: 'https://streamed-oversized-json.example.test',
    NULLBUILDER_CACHE_TTL_MS: '0'
  });
  const oversizedJson = `"${'x'.repeat(GITHUB_JSON_RESPONSE_MAX_BYTES)}"`;

  globalThis.fetch = (async () => new Response(oversizedJson)) as typeof fetch;

  await assert.rejects(
    githubRequest(config, '/repos/nullclaw/nullbuilder'),
    (error: unknown) => error instanceof Error && error.message === 'GitHub response body is too large.'
  );
});

test('githubRequest rejects streamed responses that exceed the limit across chunk boundaries', async () => {
  const config = readConfig({
    NULLBUILDER_REPOS: 'nullbuilder',
    NULLBUILDER_GITHUB_API_URL: 'https://chunk-boundary-json.example.test',
    NULLBUILDER_CACHE_TTL_MS: '0'
  });
  const maxSizeChunk = new Uint8Array(GITHUB_JSON_RESPONSE_MAX_BYTES);
  const overflowChunk = new Uint8Array(1);

  globalThis.fetch = (async () =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(maxSizeChunk);
          controller.enqueue(overflowChunk);
        }
      })
    )) as typeof fetch;

  await assert.rejects(
    githubRequest(config, '/repos/nullclaw/nullbuilder'),
    (error: unknown) => error instanceof Error && error.message === 'GitHub response body is too large.'
  );
});

test('githubRequest keeps stream cancel errors from masking oversized responses', async () => {
  const config = readConfig({
    NULLBUILDER_REPOS: 'nullbuilder',
    NULLBUILDER_GITHUB_API_URL: 'https://cancel-oversized-json.example.test',
    NULLBUILDER_CACHE_TTL_MS: '0'
  });
  const oversizedChunk = new Uint8Array(GITHUB_JSON_RESPONSE_MAX_BYTES + 1);

  globalThis.fetch = (async () =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(oversizedChunk);
        },
        cancel() {
          throw new Error('private cancel detail');
        }
      })
    )) as typeof fetch;

  await assert.rejects(
    githubRequest(config, '/repos/nullclaw/nullbuilder'),
    (error: unknown) =>
      error instanceof Error &&
      error.message === 'GitHub response body is too large.' &&
      !error.message.includes('private cancel detail')
  );
});

test('githubRequest keeps oversized error bodies from masking API status', async () => {
  const config = readConfig({
    NULLBUILDER_REPOS: 'nullbuilder',
    NULLBUILDER_GITHUB_API_URL: 'https://oversized-error.example.test',
    NULLBUILDER_CACHE_TTL_MS: '0'
  });

  globalThis.fetch = (async () =>
    new Response('{}', {
      status: 500,
      statusText: 'Server Error',
      headers: {
        'Content-Length': String(GITHUB_JSON_RESPONSE_MAX_BYTES + 1)
      }
    })) as typeof fetch;

  await assert.rejects(
    githubRequest(config, '/repos/nullclaw/nullbuilder'),
    (error: unknown) =>
      error instanceof GitHubApiError &&
      error.status === 500 &&
      error.message === 'GitHub 500 Server Error'
  );
});

test('githubRequest bounds error detail bodies below successful JSON bodies', async () => {
  const config = readConfig({
    NULLBUILDER_REPOS: 'nullbuilder',
    NULLBUILDER_GITHUB_API_URL: 'https://bounded-error-body.example.test',
    NULLBUILDER_CACHE_TTL_MS: '0'
  });

  assert.equal(GITHUB_ERROR_RESPONSE_MAX_BYTES < GITHUB_JSON_RESPONSE_MAX_BYTES, true);

  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ message: 'private upstream detail' }), {
      status: 500,
      statusText: 'Server Error',
      headers: {
        'Content-Length': String(GITHUB_ERROR_RESPONSE_MAX_BYTES + 1)
      }
    })) as typeof fetch;

  await assert.rejects(
    githubRequest(config, '/repos/nullclaw/nullbuilder'),
    (error: unknown) =>
      error instanceof GitHubApiError &&
      error.status === 500 &&
      error.message === 'GitHub 500 Server Error' &&
      !error.message.includes('private upstream detail')
  );
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

test('githubRequest rejects unsafe GitHub error detail text', async () => {
  const config = readConfig({
    NULLBUILDER_REPOS: 'nullbuilder',
    NULLBUILDER_GITHUB_API_URL: 'https://unsafe-error-detail.example.test',
    NULLBUILDER_CACHE_TTL_MS: '0'
  });

  for (const message of [
    'private\nupstream',
    'private\x1b[31mupstream',
    'x'.repeat(GITHUB_ERROR_MESSAGE_MAX_LENGTH + 1)
  ]) {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ message }), {
        status: 500,
        statusText: 'Server Error'
      })) as typeof fetch;

    await assert.rejects(
      githubRequest(config, `/repos/nullclaw/nullbuilder-${message.length}`),
      (error: unknown) =>
        error instanceof GitHubApiError &&
        error.status === 500 &&
        error.message === 'GitHub 500 Server Error'
    );
  }
});

test('githubRequest bounds unsafe GitHub status text', async () => {
  const config = readConfig({
    NULLBUILDER_REPOS: 'nullbuilder',
    NULLBUILDER_GITHUB_API_URL: 'https://unsafe-status-text.example.test',
    NULLBUILDER_CACHE_TTL_MS: '0'
  });

  const response = new Response(JSON.stringify({ message: 'upstream unavailable' }), {
    status: 500,
    statusText: 'Server Error'
  });
  Object.defineProperty(response, 'statusText', {
    value: 'x'.repeat(GITHUB_STATUS_TEXT_MAX_LENGTH + 1)
  });

  globalThis.fetch = (async () => response) as typeof fetch;

  await assert.rejects(
    githubRequest(config, '/repos/nullclaw/nullbuilder'),
    (error: unknown) =>
      error instanceof GitHubApiError &&
      error.status === 500 &&
      error.message === 'GitHub 500 Error: upstream unavailable'
  );
});

test('githubRequest keeps malformed rate-limit reset headers from masking API errors', async () => {
  const config = readConfig({
    NULLBUILDER_REPOS: 'nullbuilder',
    NULLBUILDER_GITHUB_API_URL: 'https://rate-limit.example.test',
    NULLBUILDER_CACHE_TTL_MS: '0'
  });

  for (const [index, reset] of [
    'not-a-timestamp',
    '1760000000.5',
    '1e3',
    '0',
    '9007199254740992',
    '1'.repeat(GITHUB_RATE_LIMIT_RESET_MAX_LENGTH + 1)
  ].entries()) {
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
      githubRequest(config, `/repos/nullclaw/nullbuilder-${index}`),
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
