import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import type { Cookies } from '@sveltejs/kit';
import { AUTH_COOKIE, createCsrfToken, createSessionToken } from './auth';
import { readConfig } from './config';
import {
  mutationAccessError,
  parseBuildPrMutationForm,
  parsePositiveFormInteger,
  parseReleaseTagMutationForm
} from './web-actions';

test('parsePositiveFormInteger accepts only safe positive base-10 integers', () => {
  assert.equal(parsePositiveFormInteger('1'), 1);
  assert.equal(parsePositiveFormInteger('42'), 42);
  assert.equal(parsePositiveFormInteger('0'), null);
  assert.equal(parsePositiveFormInteger('01'), null);
  assert.equal(parsePositiveFormInteger('1.5'), null);
  assert.equal(parsePositiveFormInteger('9007199254740992'), null);
  assert.equal(parsePositiveFormInteger(null), null);
});

test('parseBuildPrMutationForm trims text fields and reads checkbox flags', () => {
  const formData = new FormData();
  formData.set('repo', ' nullbuilder ');
  formData.set('prNumber', '17');
  formData.set('tagName', ' build-pr-17 ');
  formData.set('confirm', 'on');
  formData.set('force', 'off');

  assert.deepEqual(parseBuildPrMutationForm(formData), {
    repo: 'nullbuilder',
    prNumber: 17,
    tagName: 'build-pr-17',
    confirm: true,
    force: false
  });
});

test('parseReleaseTagMutationForm trims optional ref and drops empty target ref', () => {
  const formData = new FormData();
  formData.set('repo', ' nullbuilder ');
  formData.set('tagName', ' v1.2.3 ');
  formData.set('targetRef', '   ');
  formData.set('force', 'on');

  assert.deepEqual(parseReleaseTagMutationForm(formData), {
    repo: 'nullbuilder',
    tagName: 'v1.2.3',
    targetRef: undefined,
    confirm: false,
    force: true
  });
});

test('mutationAccessError enforces enablement authentication and CSRF order', () => {
  const disabled = readConfig({
    NULLBUILDER_REPOS: 'nullbuilder',
    NULLBUILDER_WEB_TOKEN: 'web-secret'
  });
  assert.match(mutationAccessError(disabled, cookiesWith(), null, 'build-pr') ?? '', /Web mutations are disabled/);

  const config = readConfig({
    NULLBUILDER_REPOS: 'nullbuilder',
    NULLBUILDER_WEB_TOKEN: 'web-secret',
    NULLBUILDER_ENABLE_MUTATIONS: 'true'
  });
  assert.equal(
    mutationAccessError(config, cookiesWith(), null, 'release-tag'),
    'Web mutations require NULLBUILDER_WEB_TOKEN authentication.'
  );

  const session = createSessionToken('web-secret');
  const cookies = cookiesWith(session);
  assert.equal(mutationAccessError(config, cookies, 'bad-token', 'release-tag'), 'Invalid request token.');

  const csrfToken = createCsrfToken(cookies, config);
  assert.equal(mutationAccessError(config, cookies, csrfToken, 'release-tag'), null);
});

function cookiesWith(value?: string): Cookies {
  return {
    get: (name: string) => (name === AUTH_COOKIE ? value : undefined)
  } as Cookies;
}
