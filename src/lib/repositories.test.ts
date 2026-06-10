import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { normalizeOwner, normalizeRepoSlug, parseRepositoryList } from './repositories';

test('normalizeOwner rejects invalid owners', () => {
  assert.equal(normalizeOwner('NullClaw'), 'NullClaw');
  assert.throws(() => normalizeOwner('-bad'), /^Error: Invalid repository owner\.$/);
  assert.throws(() => normalizeOwner('bad/owner'), /^Error: Invalid repository owner\.$/);
});

test('normalizeRepoSlug validates default owner for unqualified repositories', () => {
  assert.equal(normalizeRepoSlug('nullbuilder', 'nullclaw'), 'nullclaw/nullbuilder');
  assert.throws(() => normalizeRepoSlug('nullbuilder', 'bad_owner!'), /^Error: Invalid repository owner\.$/);
});

test('parseRepositoryList deduplicates case-insensitively', () => {
  assert.deepEqual(parseRepositoryList('nullclaw/nullbuilder NullClaw/NullBuilder nullhub'), [
    'nullclaw/nullbuilder',
    'nullclaw/nullhub'
  ]);
});

test('repository validators do not echo unsafe input in errors', () => {
  assert.throws(
    () => normalizeOwner('bad\nowner'),
    (error: unknown) => error instanceof Error && error.message === 'Invalid repository owner.'
  );
  assert.throws(
    () => normalizeRepoSlug('nullclaw/bad\x1b[31mrepo'),
    (error: unknown) => error instanceof Error && error.message === 'Invalid repository name.'
  );
  assert.throws(
    () => normalizeRepoSlug('nullclaw/nullbuilder/extra'),
    (error: unknown) => error instanceof Error && error.message === 'Invalid repository slug.'
  );
});
