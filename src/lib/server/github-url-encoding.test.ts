import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { encodeGitHubPath, encodeGitHubPathSegment } from './github-url-encoding';

test('encodeGitHubPath encodes path segments without flattening slashes', () => {
  assert.equal(encodeGitHubPath('.github/workflows/build pr.yml'), '.github/workflows/build%20pr.yml');
});

test('encodeGitHubPathSegment escapes reserved path and query characters', () => {
  assert.equal(encodeGitHubPathSegment('release/v1?draft#notes'), 'release%2Fv1%3Fdraft%23notes');
  assert.equal(encodeGitHubPathSegment("tag!'()*"), 'tag%21%27%28%29%2A');
});
