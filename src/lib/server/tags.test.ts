import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { BUILD_PR_TAG_PREFIX, defaultBuildPrTagName, sanitizeBuildPrTagName, sanitizeReleaseTagName } from './tags';

test('defaultBuildPrTagName includes PR number and short SHA', () => {
  assert.equal(defaultBuildPrTagName(17, 'abcdef1234567890'), `${BUILD_PR_TAG_PREFIX}17-abcdef1`);
});

test('sanitizeBuildPrTagName accepts only build-pr tags', () => {
  assert.equal(sanitizeBuildPrTagName(' build-pr-17-abcdef1 '), 'build-pr-17-abcdef1');
  assert.throws(() => sanitizeBuildPrTagName('v1.2.3'), /Build PR tag must start/);
});

test('sanitizeReleaseTagName accepts only v-prefixed release tags', () => {
  assert.equal(sanitizeReleaseTagName(' v1.2.3 '), 'v1.2.3');
  assert.throws(() => sanitizeReleaseTagName('build-pr-17'), /Release tag must start/);
});

test('tag sanitizers reject unsafe git ref fragments', () => {
  assert.throws(() => sanitizeBuildPrTagName('build-pr-bad..tag'), /^Error: Invalid tag name\.$/);
  assert.throws(() => sanitizeBuildPrTagName('build-pr-bad/tag'), /^Error: Invalid tag name\.$/);
  assert.throws(() => sanitizeBuildPrTagName('build-pr-17.lock'), /^Error: Invalid tag name\.$/);
  assert.throws(() => sanitizeReleaseTagName('v1.2.3.'), /^Error: Invalid tag name\.$/);
  assert.throws(() => sanitizeReleaseTagName('v1.2.3.lock'), /^Error: Invalid tag name\.$/);
  assert.throws(() => sanitizeReleaseTagName(`v${'a'.repeat(121)}`), /^Error: Invalid tag name\.$/);
  assert.throws(() => sanitizeBuildPrTagName(`${' '.repeat(513)}build-pr-17`), /^Error: Invalid tag name\.$/);
  assert.throws(() => sanitizeReleaseTagName(`${' '.repeat(513)}v1.2.3`), /^Error: Invalid tag name\.$/);
});

test('tag sanitizers do not echo unsafe tag input in errors', () => {
  assert.throws(
    () => sanitizeBuildPrTagName('build-pr-\x1b[31mred'),
    (error: unknown) => error instanceof Error && error.message === 'Invalid tag name.'
  );
  assert.throws(
    () => sanitizeReleaseTagName('v1.2.3\ninjected'),
    (error: unknown) => error instanceof Error && error.message === 'Invalid tag name.'
  );
});
