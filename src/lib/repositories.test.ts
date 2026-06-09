import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { normalizeOwner, normalizeRepoSlug, parseRepositoryList } from './repositories';

test('normalizeOwner rejects invalid owners', () => {
  assert.equal(normalizeOwner('NullClaw'), 'NullClaw');
  assert.throws(() => normalizeOwner('-bad'), /Invalid repository owner/);
  assert.throws(() => normalizeOwner('bad/owner'), /Invalid repository owner/);
});

test('normalizeRepoSlug validates default owner for unqualified repositories', () => {
  assert.equal(normalizeRepoSlug('nullbuilder', 'nullclaw'), 'nullclaw/nullbuilder');
  assert.throws(() => normalizeRepoSlug('nullbuilder', 'bad_owner!'), /Invalid repository owner/);
});

test('parseRepositoryList deduplicates case-insensitively', () => {
  assert.deepEqual(parseRepositoryList('nullclaw/nullbuilder NullClaw/NullBuilder nullhub'), [
    'nullclaw/nullbuilder',
    'nullclaw/nullhub'
  ]);
});
