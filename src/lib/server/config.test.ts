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

test('readConfig allows plaintext URLs only for loopback development origins', () => {
  const localhostConfig = readConfig({
    NULLBUILDER_REPOS: 'nullbuilder',
    NULLBUILDER_GITHUB_API_URL: 'http://localhost:8080/api/',
    NULLBUILDER_GITHUB_WEB_URL: 'http://127.0.0.1:3000/'
  });

  assert.equal(localhostConfig.apiBaseUrl, 'http://localhost:8080/api');
  assert.equal(localhostConfig.webBaseUrl, 'http://127.0.0.1:3000');

  const ipv4LoopbackConfig = readConfig({
    NULLBUILDER_REPOS: 'nullbuilder',
    NULLBUILDER_GITHUB_API_URL: 'http://127.255.255.255:65535/api/'
  });

  assert.equal(ipv4LoopbackConfig.apiBaseUrl, 'http://127.255.255.255:65535/api');

  const ipv6LoopbackConfig = readConfig({
    NULLBUILDER_REPOS: 'nullbuilder',
    NULLBUILDER_GITHUB_API_URL: 'http://[::1]:8080/api/'
  });

  assert.equal(ipv6LoopbackConfig.apiBaseUrl, 'http://[::1]:8080/api');

  assert.throws(
    () =>
      readConfig({
        NULLBUILDER_REPOS: 'nullbuilder',
        NULLBUILDER_GITHUB_API_URL: 'http://api.example.test'
      }),
    (error: unknown) =>
      error instanceof Error &&
      error.message === 'Invalid URL protocol for NULLBUILDER_GITHUB_API_URL.' &&
      !error.message.includes('api.example.test')
  );

  assert.throws(
    () =>
      readConfig({
        NULLBUILDER_REPOS: 'nullbuilder',
        NULLBUILDER_GITHUB_WEB_URL: 'http://github.example.test'
      }),
    (error: unknown) =>
      error instanceof Error &&
      error.message === 'Invalid URL protocol for NULLBUILDER_GITHUB_WEB_URL.' &&
      !error.message.includes('github.example.test')
  );

  for (const value of [
    'http://127.0.0.01:3000',
    'http://0177.0.0.1:3000',
    'http://localhost:08080',
    'http://127.0.0',
    'http://127.0.0.1.2',
    'http://127.0.0.256',
    'http://127.0.0.a',
    'http://126.0.0.1'
  ]) {
    assert.throws(
      () =>
        readConfig({
          NULLBUILDER_REPOS: 'nullbuilder',
          NULLBUILDER_GITHUB_API_URL: value
        }),
      (error: unknown) =>
        error instanceof Error &&
        (error.message === 'Invalid URL protocol for NULLBUILDER_GITHUB_API_URL.' ||
          error.message === 'Invalid URL for NULLBUILDER_GITHUB_API_URL.') &&
        !error.message.includes(value)
    );
  }
});

test('readConfig parses booleans and integers from bounded explicit env values only', () => {
  const config = readConfig({
    NULLBUILDER_REPOS: 'nullbuilder',
    NULLBUILDER_DISCOVER_REPOS: ' TRUE ',
    NULLBUILDER_ENABLE_MUTATIONS: 'yes\n',
    NULLBUILDER_CACHE_TTL_MS: '0x10',
    NULLBUILDER_CONCURRENCY: '1e2',
    NULLBUILDER_REQUEST_TIMEOUT_MS: '1'.repeat(100_000)
  });

  assert.equal(config.discoverRepos, true);
  assert.equal(config.enableWebMutations, false);
  assert.equal(config.cacheTtlMs, 60_000);
  assert.equal(config.concurrency, 3);
  assert.equal(config.requestTimeoutMs, 15_000);
});

test('readConfig trims and bounds configured secrets', () => {
  const config = readConfig({
    NULLBUILDER_REPOS: 'nullbuilder',
    NULLBUILDER_GITHUB_TOKEN: ' github-token ',
    NULLBUILDER_WEB_TOKEN: ' web-secret '
  });

  assert.equal(config.token, 'github-token');
  assert.equal(config.webToken, 'web-secret');

  assert.throws(
    () =>
      readConfig({
        NULLBUILDER_REPOS: 'nullbuilder',
        NULLBUILDER_GITHUB_TOKEN: `github-token\n${'x'.repeat(20)}`
      }),
    (error: unknown) =>
      error instanceof Error &&
      error.message === 'Invalid secret for NULLBUILDER_GITHUB_TOKEN.' &&
      !error.message.includes('github-token')
  );

  assert.throws(
    () =>
      readConfig({
        NULLBUILDER_REPOS: 'nullbuilder',
        NULLBUILDER_WEB_TOKEN: 'x'.repeat(513)
      }),
    (error: unknown) =>
      error instanceof Error &&
      error.message === 'Invalid secret for NULLBUILDER_WEB_TOKEN.' &&
      !error.message.includes('xxxxx')
  );
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

  assert.throws(
    () =>
      readConfig({
        NULLBUILDER_GITHUB_API_URL: 'https://api.github.com\nsecret'
      }),
    (error: unknown) =>
      error instanceof Error &&
      error.message === 'Invalid URL for NULLBUILDER_GITHUB_API_URL.' &&
      !error.message.includes('secret')
  );

  for (const [name, env, secret] of [
    [
      'NULLBUILDER_GITHUB_API_URL',
      {
        NULLBUILDER_GITHUB_API_URL: 'https://api.github.com?token=secret-query-value'
      },
      'secret-query-value'
    ],
    [
      'NULLBUILDER_GITHUB_WEB_URL',
      {
        NULLBUILDER_GITHUB_WEB_URL: 'https://github.com#secret-fragment-value'
      },
      'secret-fragment-value'
    ]
  ] as const) {
    assert.throws(
      () => readConfig(env),
      (error: unknown) =>
        error instanceof Error && error.message === `Invalid URL for ${name}.` && !error.message.includes(secret)
    );
  }

  assert.throws(
    () =>
      readConfig({
        NULLBUILDER_GITHUB_WEB_URL: `https://github.com/${'x'.repeat(2048)}`
      }),
    (error: unknown) =>
      error instanceof Error &&
      error.message === 'Invalid URL for NULLBUILDER_GITHUB_WEB_URL.' &&
      !error.message.includes('xxxxx')
  );

  for (const [name, env] of [
    [
      'NULLBUILDER_GITHUB_API_URL',
      {
        NULLBUILDER_GITHUB_API_URL: 'https://api.github.com/%0asecret'
      }
    ],
    [
      'NULLBUILDER_GITHUB_WEB_URL',
      {
        NULLBUILDER_GITHUB_WEB_URL: 'https://github.com/%c2%85secret'
      }
    ]
  ] as const) {
    assert.throws(
      () => readConfig(env),
      (error: unknown) =>
        error instanceof Error &&
        error.message === `Invalid URL for ${name}.` &&
        !error.message.includes('secret')
    );
  }

  for (const [name, env] of [
    [
      'NULLBUILDER_GITHUB_API_URL',
      {
        NULLBUILDER_GITHUB_API_URL: 'https://api.github.com/%e2%80%aesecret'
      }
    ],
    [
      'NULLBUILDER_GITHUB_WEB_URL',
      {
        NULLBUILDER_GITHUB_WEB_URL: 'https://github.com/\u202esecret'
      }
    ]
  ] as const) {
    assert.throws(
      () => readConfig(env),
      (error: unknown) =>
        error instanceof Error &&
        error.message === `Invalid URL for ${name}.` &&
        !error.message.includes('secret')
    );
  }
});
