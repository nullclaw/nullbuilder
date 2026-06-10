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

test('safeGitHubWebUrl rejects unsafe URLs before they become hrefs', () => {
  const fallback = 'https://github.example.test/nullclaw/nullbuilder';
  const allowedOrigin = 'https://github.example.test';

  for (const value of [
    '',
    'javascript:alert(1)',
    'https://evil.example/nullclaw/nullbuilder',
    'https://user:pass@github.example.test/nullclaw/nullbuilder',
    'https://github.example.test/nullclaw/nullbuilder bad',
    'https://github.example.test/nullclaw/nullbuilder/actions%0a',
    'https://github.example.test/nullclaw/nullbuilder/actions%1b',
    'https://github.example.test/nullclaw/nullbuilder/actions%c2%85',
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
      'https://github.example.test/other/repo/actions?query=branch%3Amain',
      fallback,
      allowedOrigin,
      '/nullclaw/nullbuilder'
    ),
    fallback
  );
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
