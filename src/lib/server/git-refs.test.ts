import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  assertFullGitSha,
  isFullGitSha,
  safeGitBranchName,
  sanitizeGitBranchName,
  sanitizeGitTargetRef
} from './git-refs';

const SHA = 'de0fac2e4500dabe0009e67214ff5f5447ce83dd';

test('git ref helpers accept branch names and full SHAs where appropriate', () => {
  assert.equal(isFullGitSha(SHA), true);
  assert.equal(assertFullGitSha(SHA, 'target SHA'), SHA);
  assert.equal(sanitizeGitBranchName(' release/v1.2.3 '), 'release/v1.2.3');
  assert.equal(sanitizeGitTargetRef(SHA), SHA);
  assert.equal(sanitizeGitTargetRef(' main '), 'main');
});

test('git ref helpers reject unsafe branch names without echoing input', () => {
  for (const value of [
    '',
    'refs/heads/main',
    '/main',
    'main/',
    'main.lock',
    'release//next',
    'release/../main',
    'release/@{upstream}',
    'main\ninjected',
    `branch-${'x'.repeat(260)}`,
    `${' '.repeat(1025)}main`
  ]) {
    assert.throws(
      () => sanitizeGitBranchName(value, 'default branch'),
      (error: unknown) => error instanceof Error && error.message === 'Invalid default branch.'
    );
  }

  assert.throws(
    () => sanitizeGitTargetRef(`${' '.repeat(1025)}${SHA}`),
    (error: unknown) => error instanceof Error && error.message === 'Invalid target ref.'
  );
});

test('safeGitBranchName returns a bounded fallback for unsafe input', () => {
  assert.equal(safeGitBranchName('main\ninjected', 'unknown'), 'unknown');
  assert.equal(safeGitBranchName('release/v1.2.3', 'unknown'), 'release/v1.2.3');
});
