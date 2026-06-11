import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import type { RepoSlug } from '../repositories';
import {
  githubActionsBranchQueryUrl,
  githubActionsUrl,
  githubOwnerWebUrl,
  githubReleaseTagUrl,
  githubRepositoryUrlContext,
  githubRepositoryWebUrl,
  MAX_GITHUB_WEB_URL_LENGTH,
  safeGitHubWebUrl
} from './github-web-urls';

const REPO = 'nullclaw/nullbuilder' as RepoSlug;
const originalUrl = globalThis.URL;

function restoreGlobalUrl(): void {
  Object.defineProperty(globalThis, 'URL', {
    configurable: true,
    writable: true,
    value: originalUrl
  });
}

test('github web URL helpers build repository owner and mutation URLs', () => {
  const context = githubRepositoryUrlContext('https://github.example.test/', REPO);

  assert.equal(githubOwnerWebUrl('https://github.example.test/', 'nullclaw'), 'https://github.example.test/nullclaw');
  assert.equal(githubOwnerWebUrl('https://github.example.test/', 'bad owner'), 'https://github.example.test/nullclaw');
  assert.equal(githubRepositoryWebUrl('https://github.example.test/', REPO), 'https://github.example.test/nullclaw/nullbuilder');
  assert.equal(context.repositoryUrl, 'https://github.example.test/nullclaw/nullbuilder');
  assert.equal(context.repositoryOrigin, 'https://github.example.test');
  assert.equal(context.repositoryPathPrefix, '/nullclaw/nullbuilder');
  assert.equal(githubActionsUrl(context), 'https://github.example.test/nullclaw/nullbuilder/actions');
  assert.equal(
    githubReleaseTagUrl(context, 'v1.2.3'),
    'https://github.example.test/nullclaw/nullbuilder/releases/tag/v1.2.3'
  );
  assert.equal(
    githubReleaseTagUrl(context, 'release/v1?draft#notes'),
    'https://github.example.test/nullclaw/nullbuilder/releases/tag/release%2Fv1%3Fdraft%23notes'
  );
  assert.equal(
    githubActionsBranchQueryUrl(context, 'release/v1.2.3'),
    'https://github.example.test/nullclaw/nullbuilder/actions?query=branch%3Arelease%2Fv1.2.3'
  );
});

test('github web URL helpers normalize unsafe configured bases before composing hrefs', () => {
  for (const [value, secret] of [
    ['https://github.example.test?token=secret-query-value', 'secret-query-value'],
    ['https://github.example.test#secret-fragment-value', 'secret-fragment-value'],
    ['https://user:pass@github.example.test/base', 'user'],
    ['https://github.example.test/base/../secret-path', 'secret-path'],
    ['https://github.example.test/base/%2e%2e/secret-path', 'secret-path'],
    ['https://github.example.test/base//secret-path', 'secret-path'],
    ['http://github.example.test/base', 'github.example.test']
  ] as const) {
    const repositoryUrl = githubRepositoryWebUrl(value, REPO);
    const ownerUrl = githubOwnerWebUrl(value, 'nullclaw');
    const context = githubRepositoryUrlContext(value, REPO);

    assert.equal(repositoryUrl, 'https://github.com/nullclaw/nullbuilder');
    assert.equal(ownerUrl, 'https://github.com/nullclaw');
    assert.equal(context.repositoryUrl, 'https://github.com/nullclaw/nullbuilder');
    assert.equal(context.repositoryOrigin, 'https://github.com');
    assert.equal(context.repositoryPathPrefix, '/nullclaw/nullbuilder');
    assert.equal(repositoryUrl.includes(secret), false);
    assert.equal(ownerUrl.includes(secret), false);
    assert.equal(context.repositoryUrl.includes(secret), false);
  }
});

test('github web URL helpers parse with captured URL constructor', () => {
  Object.defineProperty(globalThis, 'URL', {
    configurable: true,
    writable: true,
    value: class URLShouldNotBeCalled {
      constructor() {
        throw new Error('global URL constructor should not be called');
      }
    }
  });

  try {
    const context = githubRepositoryUrlContext(
      'https://github.example.test/',
      REPO,
      'https://github.example.test/nullclaw/nullbuilder/'
    );

    assert.equal(
      githubRepositoryWebUrl('https://github.example.test/', REPO),
      'https://github.example.test/nullclaw/nullbuilder'
    );
    assert.equal(context.repositoryUrl, 'https://github.example.test/nullclaw/nullbuilder');
    assert.equal(context.repositoryOrigin, 'https://github.example.test');
    assert.equal(context.repositoryPathPrefix, '/nullclaw/nullbuilder');
  } finally {
    restoreGlobalUrl();
  }
});

test('safeGitHubWebUrl rejects unsafe URLs before they become hrefs', () => {
  const fallback = 'https://github.example.test/nullclaw/nullbuilder';
  const allowedOrigin = 'https://github.example.test';

  for (const value of [
    '',
    'javascript:alert(1)',
    'http://github.example.test/nullclaw/nullbuilder',
    'https://evil.example/nullclaw/nullbuilder',
    'https://user:pass@github.example.test/nullclaw/nullbuilder',
    'https://github.example.test/nullclaw/nullbuilder bad',
    'https://github.example.test/nullclaw/nullbuilder/actions%0a',
    'https://github.example.test/nullclaw/nullbuilder/actions%1b',
    'https://github.example.test/nullclaw/nullbuilder/actions%c2%85',
    'https://github.example.test/nullclaw/nullbuilder/actions%e2%80%ae',
    'https://github.example.test/nullclaw/nullbuilder/actions\u202esecret',
    'https://github.example.test/nullclaw/nullbuilder/actions\ud800',
    `https://github.example.test/${'x'.repeat(MAX_GITHUB_WEB_URL_LENGTH)}`
  ]) {
    assert.equal(safeGitHubWebUrl(value, fallback, allowedOrigin), fallback);
  }

  assert.equal(
    safeGitHubWebUrl(
      'https://github.example.test/nullclaw/nullbuilder/actions?query=branch%3Amain',
      fallback,
      allowedOrigin,
      '/nullclaw/nullbuilder'
    ),
    'https://github.example.test/nullclaw/nullbuilder/actions?query=branch%3Amain'
  );
  assert.equal(
    safeGitHubWebUrl(
      'https://github.example.test/nullclaw/nullbuilder/actions?query=check%20suite',
      fallback,
      allowedOrigin,
      '/nullclaw/nullbuilder'
    ),
    'https://github.example.test/nullclaw/nullbuilder/actions?query=check%20suite'
  );
  assert.equal(
    safeGitHubWebUrl(
      'http://localhost/nullclaw/nullbuilder/actions?query=branch%3Amain',
      'http://localhost/nullclaw/nullbuilder',
      'http://localhost',
      '/nullclaw/nullbuilder'
    ),
    'http://localhost/nullclaw/nullbuilder/actions?query=branch%3Amain'
  );
  assert.equal(
    safeGitHubWebUrl(
      'https://github.example.test/other/repo/actions?query=branch%3Amain',
      fallback,
      allowedOrigin,
      '/nullclaw/nullbuilder'
    ),
    fallback
  );
});

test('safeGitHubWebUrl rejects malformed runtime values without throwing type errors', () => {
  const fallback = 'https://github.example.test/nullclaw/nullbuilder';

  for (const value of [null, undefined, 17, true, { url: fallback }]) {
    assert.equal(safeGitHubWebUrl(value, fallback, 'https://github.example.test'), fallback);
  }
});

test('githubRepositoryUrlContext falls back to configured repository URLs', () => {
  const trailingSlashContext = githubRepositoryUrlContext(
    'https://github.example.test',
    REPO,
    'https://github.example.test/nullclaw/nullbuilder/'
  );
  const crossOriginContext = githubRepositoryUrlContext(
    'https://github.example.test',
    REPO,
    'https://evil.example/nullclaw/nullbuilder'
  );
  const wrongPathContext = githubRepositoryUrlContext(
    'https://github.example.test',
    REPO,
    'https://github.example.test/other/repo'
  );
  const nestedPathContext = githubRepositoryUrlContext(
    'https://github.example.test',
    REPO,
    'https://github.example.test/nullclaw/nullbuilder/issues/7'
  );
  const queryContext = githubRepositoryUrlContext(
    'https://github.example.test',
    REPO,
    'https://github.example.test/nullclaw/nullbuilder?token=secret'
  );
  const fragmentContext = githubRepositoryUrlContext(
    'https://github.example.test',
    REPO,
    'https://github.example.test/nullclaw/nullbuilder#secret'
  );

  assert.equal(trailingSlashContext.repositoryUrl, 'https://github.example.test/nullclaw/nullbuilder');
  assert.equal(crossOriginContext.repositoryUrl, 'https://github.example.test/nullclaw/nullbuilder');
  assert.equal(wrongPathContext.repositoryUrl, 'https://github.example.test/nullclaw/nullbuilder');
  assert.equal(nestedPathContext.repositoryUrl, 'https://github.example.test/nullclaw/nullbuilder');
  assert.equal(queryContext.repositoryUrl, 'https://github.example.test/nullclaw/nullbuilder');
  assert.equal(fragmentContext.repositoryUrl, 'https://github.example.test/nullclaw/nullbuilder');
});
