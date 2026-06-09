import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { readConfig } from './config';
import { GitHubApiError, publicErrorMessage, resolveGitHubApiUrl } from './github';

test('resolveGitHubApiUrl appends relative paths to configured API base', () => {
  const config = readConfig({
    NULLBUILDER_GITHUB_API_URL: 'https://github.example.test/api/v3',
    NULLBUILDER_REPOS: 'nullbuilder'
  });

  assert.equal(
    resolveGitHubApiUrl(config, '/repos/nullclaw/nullbuilder'),
    'https://github.example.test/api/v3/repos/nullclaw/nullbuilder'
  );
});

test('resolveGitHubApiUrl rejects cross-origin absolute next URLs', () => {
  const config = readConfig({
    NULLBUILDER_GITHUB_API_URL: 'https://api.github.com',
    NULLBUILDER_REPOS: 'nullbuilder'
  });

  assert.throws(
    () => resolveGitHubApiUrl(config, 'https://evil.example.test/repos/nullclaw/nullbuilder'),
    /Invalid GitHub API URL/
  );
});

test('publicErrorMessage keeps GitHub authorization details generic', () => {
  assert.equal(
    publicErrorMessage(new GitHubApiError('GitHub 403 Forbidden: secret detail', 403)),
    'GitHub API authorization or rate-limit error (403).'
  );
});
