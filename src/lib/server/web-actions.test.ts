import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import type { Cookies } from '@sveltejs/kit';
import { AUTH_COOKIE, createCsrfToken, createSessionToken, isSessionTokenMatch, LoginRateLimiter } from './auth';
import { readConfig } from './config';
import {
  mutationAccessError,
  parseBuildPrMutationForm,
  parsePositiveFormInteger,
  parseReleaseTagMutationForm,
  runBuildPrWebMutation,
  runLoginWebAction,
  runLogoutWebAction,
  runReleaseTagWebMutation
} from './web-actions';

test('parsePositiveFormInteger accepts only safe positive base-10 integers', () => {
  assert.equal(parsePositiveFormInteger('1'), 1);
  assert.equal(parsePositiveFormInteger('42'), 42);
  assert.equal(parsePositiveFormInteger('0'), null);
  assert.equal(parsePositiveFormInteger('01'), null);
  assert.equal(parsePositiveFormInteger(' 42 '), null);
  assert.equal(parsePositiveFormInteger('1.5'), null);
  assert.equal(parsePositiveFormInteger('9007199254740992'), null);
  assert.equal(parsePositiveFormInteger('1'.repeat(100_000)), null);
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

test('mutation form parsers reject oversized text fields', () => {
  const oversized = 'x'.repeat(10_000);
  const paddedRepo = `${' '.repeat(600)}nullbuilder`;
  const buildFormData = new FormData();
  buildFormData.set('repo', paddedRepo);
  buildFormData.set('prNumber', '17');
  buildFormData.set('tagName', oversized);
  buildFormData.set('confirm', 'on');

  assert.deepEqual(parseBuildPrMutationForm(buildFormData), {
    repo: '',
    prNumber: 17,
    tagName: undefined,
    confirm: true,
    force: false
  });

  const releaseFormData = new FormData();
  releaseFormData.set('repo', oversized);
  releaseFormData.set('tagName', oversized);
  releaseFormData.set('targetRef', oversized);
  releaseFormData.set('force', 'on');

  assert.deepEqual(parseReleaseTagMutationForm(releaseFormData), {
    repo: '',
    tagName: '',
    targetRef: undefined,
    confirm: false,
    force: true
  });
});

test('mutation form parsers reject control-bearing text fields', () => {
  const buildFormData = new FormData();
  buildFormData.set('repo', 'nullbuilder\x1b[31m');
  buildFormData.set('prNumber', '17');
  buildFormData.set('tagName', 'build-pr-17\nsecret');

  assert.deepEqual(parseBuildPrMutationForm(buildFormData), {
    repo: '',
    prNumber: 17,
    tagName: undefined,
    confirm: false,
    force: false
  });

  const releaseFormData = new FormData();
  releaseFormData.set('repo', ' nullbuilder ');
  releaseFormData.set('tagName', 'v1.2.3');
  releaseFormData.set('targetRef', 'release/v1\x85hidden');

  assert.deepEqual(parseReleaseTagMutationForm(releaseFormData), {
    repo: 'nullbuilder',
    tagName: 'v1.2.3',
    targetRef: undefined,
    confirm: false,
    force: false
  });
});

test('mutation form parsers reject duplicate fields without echoing values', () => {
  const buildFormData = new FormData();
  buildFormData.append('repo', 'nullbuilder');
  buildFormData.append('repo', 'other');
  buildFormData.set('prNumber', '17');

  assert.throws(() => parseBuildPrMutationForm(buildFormData), (error) => {
    assert(error instanceof Error);
    assert.equal(error.message, 'Duplicate form field.');
    assert.doesNotMatch(error.message, /nullbuilder|other/);
    return true;
  });

  const releaseFormData = new FormData();
  releaseFormData.set('repo', 'nullbuilder');
  releaseFormData.set('tagName', 'v1.2.3');
  releaseFormData.append('targetRef', 'main');
  releaseFormData.append('targetRef', 'release/v1');

  assert.throws(() => parseReleaseTagMutationForm(releaseFormData), (error) => {
    assert(error instanceof Error);
    assert.equal(error.message, 'Duplicate form field.');
    assert.doesNotMatch(error.message, /release\/v1|main/);
    return true;
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

test('runLoginWebAction creates a session token and clears prior failures', () => {
  const config = readConfig({
    NULLBUILDER_REPOS: 'nullbuilder',
    NULLBUILDER_WEB_TOKEN: 'web-secret'
  });
  const limiter = testLoginRateLimiter(2);
  const formData = new FormData();
  formData.set('webToken', 'web-secret');
  limiter.recordFailure('client');

  const result = runLoginWebAction(config, limiter, 'client', formData);

  assert.equal(result.ok, true);
  assert.equal(limiter.size, 0);
  if (result.ok) {
    assert.equal(isSessionTokenMatch(result.sessionToken, 'web-secret'), true);
  }
});

test('runLoginWebAction records failures and blocks rate-limited clients', () => {
  const config = readConfig({
    NULLBUILDER_REPOS: 'nullbuilder',
    NULLBUILDER_WEB_TOKEN: 'web-secret'
  });
  const limiter = testLoginRateLimiter();
  const formData = new FormData();
  formData.set('webToken', 'wrong');

  assert.deepEqual(runLoginWebAction(config, limiter, 'client', formData), {
    ok: false,
    status: 403,
    message: 'Invalid web token.'
  });
  assert.deepEqual(runLoginWebAction(config, limiter, 'client', formData), {
    ok: false,
    status: 429,
    message: 'Too many failed login attempts. Try again later.'
  });
});

test('runLoginWebAction rejects duplicate web token fields', () => {
  const config = readConfig({
    NULLBUILDER_REPOS: 'nullbuilder',
    NULLBUILDER_WEB_TOKEN: 'web-secret'
  });
  const formData = new FormData();
  formData.append('webToken', 'web-secret');
  formData.append('webToken', 'web-secret');

  assert.deepEqual(runLoginWebAction(config, testLoginRateLimiter(), 'client', formData), {
    ok: false,
    status: 403,
    message: 'Invalid web token.'
  });
});

test('runLoginWebAction rejects missing web token configuration', () => {
  const config = readConfig({
    NULLBUILDER_REPOS: 'nullbuilder'
  });

  assert.deepEqual(runLoginWebAction(config, testLoginRateLimiter(), 'client', new FormData()), {
    ok: false,
    status: 403,
    message: 'Set NULLBUILDER_WEB_TOKEN before exposing token-backed dashboard data.'
  });
});

test('runLogoutWebAction enforces CSRF only for authenticated web sessions', () => {
  const config = readConfig({
    NULLBUILDER_REPOS: 'nullbuilder',
    NULLBUILDER_WEB_TOKEN: 'web-secret'
  });
  const session = createSessionToken('web-secret');
  const cookies = cookiesWith(session);
  const duplicateCsrfForm = new FormData();
  const csrfToken = createCsrfToken(cookies, config);

  if (!csrfToken) {
    throw new Error('Expected authenticated test context to create a CSRF token.');
  }

  duplicateCsrfForm.append('csrfToken', csrfToken);
  duplicateCsrfForm.append('csrfToken', csrfToken);

  assert.deepEqual(runLogoutWebAction(config, cookiesWith(session), new FormData()), {
    ok: false,
    status: 403,
    message: 'Invalid request token.'
  });
  assert.deepEqual(runLogoutWebAction(config, cookiesWith(), new FormData()), {
    ok: true
  });
  assert.deepEqual(runLogoutWebAction(config, cookies, duplicateCsrfForm), {
    ok: false,
    status: 403,
    message: 'Invalid request token.'
  });
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
    repo: 'nullclaw/nullbuilder',
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

test('runBuildPrWebMutation rejects duplicate form fields before executor', async () => {
  const { config, cookies, csrfToken } = authorizedMutationContext();
  const formData = new FormData();
  formData.set('csrfToken', csrfToken);
  formData.append('repo', 'nullbuilder');
  formData.append('repo', 'other');
  formData.set('prNumber', '17');
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
    message: 'Invalid form data.'
  });
});

test('runBuildPrWebMutation rejects duplicate csrf token fields before executor', async () => {
  const { config, cookies, csrfToken } = authorizedMutationContext();
  const formData = new FormData();
  formData.append('csrfToken', csrfToken);
  formData.append('csrfToken', csrfToken);
  formData.set('repo', 'nullbuilder');
  formData.set('prNumber', '17');
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
    status: 403,
    field: 'buildError',
    message: 'Invalid request token.'
  });
});

test('runBuildPrWebMutation rejects tampered repository and tag fields before executor', async () => {
  const { config, cookies, csrfToken } = authorizedMutationContext();
  const formData = new FormData();
  formData.set('csrfToken', csrfToken);
  formData.set('repo', 'unconfigured');
  formData.set('prNumber', '17');
  let executed = false;

  const unconfiguredRepo = await runBuildPrWebMutation(
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
  assert.deepEqual(unconfiguredRepo, {
    ok: false,
    status: 400,
    field: 'buildError',
    message: 'Repository must be one of the configured repositories.'
  });

  formData.set('repo', 'nullbuilder');
  formData.set('tagName', 'v1.2.3');
  const invalidTag = await runBuildPrWebMutation(
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
  assert.deepEqual(invalidTag, {
    ok: false,
    status: 400,
    field: 'buildError',
    message: 'Invalid build PR tag.'
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

test('runReleaseTagWebMutation rejects tampered repository tag and target ref before executor', async () => {
  const { config, cookies, csrfToken } = authorizedMutationContext();
  let executed = false;

  const unconfiguredRepo = await runReleaseTagWebMutation(
    config,
    cookies,
    mutationForm(csrfToken, {
      repo: 'unconfigured',
      tagName: 'v1.2.3'
    }),
    async () => {
      executed = true;
      return {};
    },
    String
  );

  assert.equal(executed, false);
  assert.deepEqual(unconfiguredRepo, {
    ok: false,
    status: 400,
    field: 'releaseError',
    message: 'Repository must be one of the configured repositories.'
  });

  executed = false;
  const invalidTag = await runReleaseTagWebMutation(
    config,
    cookies,
    mutationForm(csrfToken, {
      repo: 'nullbuilder',
      tagName: 'build-pr-17'
    }),
    async () => {
      executed = true;
      return {};
    },
    String
  );

  assert.equal(executed, false);
  assert.deepEqual(invalidTag, {
    ok: false,
    status: 400,
    field: 'releaseError',
    message: 'Invalid release tag.'
  });

  executed = false;
  const invalidTargetRef = await runReleaseTagWebMutation(
    config,
    cookies,
    mutationForm(csrfToken, {
      repo: 'nullbuilder',
      tagName: 'v1.2.3',
      targetRef: 'refs/heads/main'
    }),
    async () => {
      executed = true;
      return {};
    },
    String
  );

  assert.equal(executed, false);
  assert.deepEqual(invalidTargetRef, {
    ok: false,
    status: 400,
    field: 'releaseError',
    message: 'Invalid target ref.'
  });
});

test('runReleaseTagWebMutation rejects duplicate form fields before executor', async () => {
  const { config, cookies, csrfToken } = authorizedMutationContext();
  const formData = mutationForm(csrfToken, {
    repo: 'nullbuilder',
    tagName: 'v1.2.3'
  });
  formData.append('tagName', 'v2.0.0');
  let executed = false;

  const result = await runReleaseTagWebMutation(
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
    field: 'releaseError',
    message: 'Invalid form data.'
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

function testLoginRateLimiter(maxFailures = 1): LoginRateLimiter {
  return new LoginRateLimiter({
    windowMs: 1000,
    maxFailures,
    maxKeys: 10,
    now: () => 10_000
  });
}

function mutationForm(
  csrfToken: string,
  values: {
    repo: string;
    tagName: string;
    targetRef?: string;
  }
): FormData {
  const formData = new FormData();
  formData.set('csrfToken', csrfToken);
  formData.set('repo', values.repo);
  formData.set('tagName', values.tagName);
  if (values.targetRef !== undefined) {
    formData.set('targetRef', values.targetRef);
  }
  return formData;
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
