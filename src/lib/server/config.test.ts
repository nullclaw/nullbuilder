import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { readConfig } from './config';

test('readConfig normalizes URLs and clamps numeric settings', () => {
  const config = readConfig({
    NULLBUILDER_OWNER: 'nullclaw',
    NULLBUILDER_REPOS: 'nullbuilder',
    NULLBUILDER_GITHUB_API_URL: 'https://api.github.com/',
    NULLBUILDER_GITHUB_WEB_URL: 'https://github.com/',
    NULLBUILDER_CACHE_TTL_MS: '999999999',
    NULLBUILDER_CONCURRENCY: '9999',
    NULLBUILDER_REQUEST_TIMEOUT_MS: '1'
  });

  assert.equal(config.apiBaseUrl, 'https://api.github.com');
  assert.equal(config.webBaseUrl, 'https://github.com');
  assert.equal(config.cacheTtlMs, 300_000);
  assert.equal(config.concurrency, 10);
  assert.equal(config.requestTimeoutMs, 5_000);
});

test('readConfig rejects invalid configured owners and URLs', () => {
  assert.throws(
    () =>
      readConfig({
        NULLBUILDER_OWNER: '../bad'
      }),
    /Invalid repository owner/
  );

  assert.throws(
    () =>
      readConfig({
        NULLBUILDER_GITHUB_API_URL: 'file:///tmp/api'
      }),
    /Invalid URL/
  );
});
