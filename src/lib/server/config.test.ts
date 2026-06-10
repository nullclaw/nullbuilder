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

test('readConfig parses booleans and integers from explicit decimal env values only', () => {
  const config = readConfig({
    NULLBUILDER_REPOS: 'nullbuilder',
    NULLBUILDER_DISCOVER_REPOS: ' TRUE ',
    NULLBUILDER_ENABLE_MUTATIONS: ' yes ',
    NULLBUILDER_CACHE_TTL_MS: '0x10',
    NULLBUILDER_CONCURRENCY: '1e2',
    NULLBUILDER_REQUEST_TIMEOUT_MS: '5000.5'
  });

  assert.equal(config.discoverRepos, true);
  assert.equal(config.enableWebMutations, true);
  assert.equal(config.cacheTtlMs, 60_000);
  assert.equal(config.concurrency, 3);
  assert.equal(config.requestTimeoutMs, 15_000);
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
    (error: unknown) =>
      error instanceof Error &&
      error.message === 'Invalid URL protocol for NULLBUILDER_GITHUB_API_URL.' &&
      !error.message.includes('/tmp/api')
  );

  assert.throws(
    () =>
      readConfig({
        NULLBUILDER_GITHUB_API_URL: 'https://token@api.github.com'
      }),
    (error: unknown) =>
      error instanceof Error &&
      error.message === 'Invalid URL credentials for NULLBUILDER_GITHUB_API_URL.' &&
      !error.message.includes('token')
  );

  assert.throws(
    () =>
      readConfig({
        NULLBUILDER_GITHUB_WEB_URL: 'https://user:pass@github.com'
      }),
    (error: unknown) =>
      error instanceof Error &&
      error.message === 'Invalid URL credentials for NULLBUILDER_GITHUB_WEB_URL.' &&
      !error.message.includes('user') &&
      !error.message.includes('pass')
  );

  assert.throws(
    () =>
      readConfig({
        NULLBUILDER_GITHUB_API_URL: 'https://secret@[::1'
      }),
    (error: unknown) =>
      error instanceof Error &&
      error.message === 'Invalid URL for NULLBUILDER_GITHUB_API_URL.' &&
      !error.message.includes('secret')
  );
});
