import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import type { Cookies } from '@sveltejs/kit';
import { AUTH_COOKIE, createCsrfToken, createSessionToken } from './auth';
import { readConfig } from './config';
import {
  mutationAccessError,
  parseBuildPrMutationForm,
  parsePositiveFormInteger,
  parseReleaseTagMutationForm,
  runBuildPrWebMutation,
  runReleaseTagWebMutation
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

test('runBuildPrWebMutation validates access and passes normalized input to executor', async () => {
  const { config, cookies, csrfToken } = authorizedMutationContext();
  const formData = new FormData();
  formData.set('csrfToken', csrfToken);
  formData.set('repo', ' nullbuilder ');
  formData.set('prNumber', '17');
  formData.set('tagName', ' build-pr-17 ');
  formData.set('confirm', 'on');
  let received: unknown;

  const result = await runBuildPrWebMutation(
    config,
    cookies,
    formData,
    async (input) => {
      received = input;
      return { tagName: 'build-pr-17' };
    },
    String
  );

  assert.deepEqual(received, {
    repo: 'nullbuilder',
    prNumber: 17,
    tagName: 'build-pr-17',
    confirm: true,
    force: false
  });
  assert.deepEqual(result, {
    ok: true,
    result: { tagName: 'build-pr-17' }
  });
});

test('runBuildPrWebMutation rejects invalid form data before executor', async () => {
  const { config, cookies, csrfToken } = authorizedMutationContext();
  const formData = new FormData();
  formData.set('csrfToken', csrfToken);
  formData.set('repo', 'nullbuilder');
  let executed = false;

  const result = await runBuildPrWebMutation(
    config,
    cookies,
    formData,
    async () => {
      executed = true;
      return {};
    },
    String
  );

  assert.equal(executed, false);
  assert.deepEqual(result, {
    ok: false,
    status: 400,
    field: 'buildError',
    message: 'Repository and a positive PR number are required.'
  });
});

test('runReleaseTagWebMutation returns access failures before parsing execution', async () => {
  const config = readConfig({
    NULLBUILDER_REPOS: 'nullbuilder'
  });
  const result = await runReleaseTagWebMutation(config, cookiesWith(), new FormData(), async () => ({}), String);

  assert.deepEqual(result, {
    ok: false,
    status: 403,
    field: 'releaseError',
    message: 'Web mutations are disabled. Set NULLBUILDER_ENABLE_MUTATIONS=true to enable release-tag from the UI.'
  });
});

test('runReleaseTagWebMutation maps executor errors through formatter', async () => {
  const { config, cookies, csrfToken } = authorizedMutationContext();
  const formData = new FormData();
  formData.set('csrfToken', csrfToken);
  formData.set('repo', 'nullbuilder');
  formData.set('tagName', 'v1.2.3');

  const result = await runReleaseTagWebMutation(
    config,
    cookies,
    formData,
    async () => {
      throw new Error('private upstream detail');
    },
    () => 'public failure'
  );

  assert.deepEqual(result, {
    ok: false,
    status: 500,
    field: 'releaseError',
    message: 'public failure'
  });
});

function cookiesWith(value?: string): Cookies {
  return {
    get: (name: string) => (name === AUTH_COOKIE ? value : undefined)
  } as Cookies;
}

function authorizedMutationContext(): { config: ReturnType<typeof readConfig>; cookies: Cookies; csrfToken: string } {
  const config = readConfig({
    NULLBUILDER_REPOS: 'nullbuilder',
    NULLBUILDER_WEB_TOKEN: 'web-secret',
    NULLBUILDER_ENABLE_MUTATIONS: 'true'
  });
  const cookies = cookiesWith(createSessionToken('web-secret'));
  const csrfToken = createCsrfToken(cookies, config);

  if (!csrfToken) {
    throw new Error('Expected authenticated test context to create a CSRF token.');
  }

  return {
    config,
    cookies,
    csrfToken
  };
}
