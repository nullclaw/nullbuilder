import { strict as assert } from 'node:assert';
import { afterEach, test } from 'node:test';
import { readConfig } from './config';
import { githubGetPages } from './github-client';

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
