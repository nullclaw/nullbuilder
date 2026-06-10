import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import type { Cookies } from '@sveltejs/kit';
import { AUTH_COOKIE, createCsrfToken, createSessionToken, isSessionTokenMatch, LoginRateLimiter } from './auth';
import { readConfig } from './config';
import {
  MAX_WEB_ACTION_FORM_FIELDS,
  MAX_WEB_ACTION_FORM_BYTES,
  mutationAccessError,
  parseBuildPrMutationForm,
  parsePositiveFormInteger,
  parseReleaseTagMutationForm,
  readWebActionFormData,
  runBuildPrWebMutation,
  runLoginWebAction,
  runLogoutWebAction,
  runReleaseTagWebMutation,
  webActionContentLengthFailure
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

test('mutation form parsers reject unknown fields without echoing values', () => {
  const buildFormData = new FormData();
  buildFormData.set('repo', 'nullbuilder');
  buildFormData.set('prNumber', '17');
  buildFormData.set('private-note', 'secret-build-value');

  assert.throws(() => parseBuildPrMutationForm(buildFormData), (error) => {
    assert(error instanceof Error);
    assert.equal(error.message, 'Unknown form field.');
    assert.doesNotMatch(error.message, /private-note|secret-build-value/);
    return true;
  });

  const releaseFormData = new FormData();
  releaseFormData.set('repo', 'nullbuilder');
  releaseFormData.set('tagName', 'v1.2.3');
  releaseFormData.set('unexpected', 'secret-release-value');

  assert.throws(() => parseReleaseTagMutationForm(releaseFormData), (error) => {
    assert(error instanceof Error);
    assert.equal(error.message, 'Unknown form field.');
    assert.doesNotMatch(error.message, /unexpected|secret-release-value/);
    return true;
  });
});

test('mutation form parsers avoid getAll allocations while validating form shape', () => {
  const buildFormData = formDataWithoutGetAll();
  buildFormData.set('repo', 'nullbuilder');
  buildFormData.set('prNumber', '17');
  buildFormData.set('tagName', 'build-pr-17');

  assert.deepEqual(parseBuildPrMutationForm(buildFormData), {
    repo: 'nullbuilder',
    prNumber: 17,
    tagName: 'build-pr-17',
    confirm: false,
    force: false
  });

  const releaseFormData = formDataWithoutGetAll();
  releaseFormData.set('repo', 'nullbuilder');
  releaseFormData.set('tagName', 'v1.2.3');
  releaseFormData.append('targetRef', 'main');
  releaseFormData.append('targetRef', 'release/v1');

  assert.throws(() => parseReleaseTagMutationForm(releaseFormData), /^Error: Duplicate form field\.$/);
});

test('mutation form parsers reject oversized field counts without getAll allocations', () => {
  const formData = formDataWithoutGetAll();
  formData.set('csrfToken', 'token');
  formData.set('repo', 'nullbuilder');
  formData.set('prNumber', '17');
  formData.set('tagName', 'build-pr-17');
  formData.set('confirm', 'on');
  formData.set('force', 'on');
  assert.equal(Array.from(formData.keys()).length, MAX_WEB_ACTION_FORM_FIELDS);
  formData.append('unexpected', 'value');

  assert.throws(() => parseBuildPrMutationForm(formData), /^Error: Too many form fields\.$/);
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

test('web action content length guard rejects oversized and malformed bodies before parsing', () => {
  assert.equal(webActionContentLengthFailure(new Headers()), null);
  assert.equal(webActionContentLengthFailure(new Headers({ 'Content-Length': '0' })), null);
  assert.equal(
    webActionContentLengthFailure(new Headers({ 'Content-Length': String(MAX_WEB_ACTION_FORM_BYTES) })),
    null
  );

  for (const contentLength of [
    String(MAX_WEB_ACTION_FORM_BYTES + 1),
    'not-a-number',
    '1e9',
    '-1',
    '1.5',
    '9007199254740992',
    '1'.repeat(100)
  ]) {
    assert.deepEqual(webActionContentLengthFailure(new Headers({ 'Content-Length': contentLength })), {
      ok: false,
      status: 413,
      message: 'Request body is too large.'
    });
  }
});

test('readWebActionFormData rejects non-POST requests before body validation', async () => {
  const result = await readWebActionFormData(
    new Request('https://nullbuilder.example.test/', {
      method: 'PUT',
      headers: {
        'Content-Length': 'not-a-number',
        'Content-Type': 'text/plain'
      },
      body: 'private=secret'
    })
  );

  assert.deepEqual(result, {
    ok: false,
    status: 405,
    message: 'Invalid request method.'
  });
  assert.equal(result.message.includes('secret'), false);
});

test('readWebActionFormData parses bounded form bodies without content length', async () => {
  const result = await readWebActionFormData(
    webFormRequest('webToken=web-secret', {
      'Content-Type': 'APPLICATION/X-WWW-FORM-URLENCODED; charset=UTF-8'
    })
  );

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.formData.get('webToken'), 'web-secret');
  }
});

test('readWebActionFormData rejects oversized streamed bodies without content length', async () => {
  const result = await readWebActionFormData(webFormRequest(`webToken=${'x'.repeat(MAX_WEB_ACTION_FORM_BYTES)}`));

  assert.deepEqual(result, {
    ok: false,
    status: 413,
    message: 'Request body is too large.'
  });
});

test('readWebActionFormData rejects bodies larger than the declared content length', async () => {
  const result = await readWebActionFormData(
    webFormRequest(`webToken=${'x'.repeat(MAX_WEB_ACTION_FORM_BYTES)}`, {
      'Content-Length': '1'
    })
  );

  assert.deepEqual(result, {
    ok: false,
    status: 413,
    message: 'Request body is too large.'
  });
});

test('readWebActionFormData rejects unsupported content types before streamed body size checks', async () => {
  const result = await readWebActionFormData(
    new Request('https://nullbuilder.example.test/', {
      method: 'POST',
      headers: {
        'Content-Type': 'text/plain'
      },
      body: `private=${'x'.repeat(MAX_WEB_ACTION_FORM_BYTES)}`
    })
  );

  assert.deepEqual(result, {
    ok: false,
    status: 400,
    message: 'Invalid form body.'
  });
  assert.equal(result.message.includes('private'), false);
});

test('readWebActionFormData rejects malformed form bodies without throwing parser details', async () => {
  const textResult = await readWebActionFormData(
    new Request('https://nullbuilder.example.test/', {
      method: 'POST',
      headers: {
        'Content-Type': 'text/plain'
      },
      body: 'private=secret'
    })
  );

  assert.deepEqual(textResult, {
    ok: false,
    status: 400,
    message: 'Invalid form body.'
  });
  assert.equal(textResult.message.includes('secret'), false);

  const multipartResult = await readWebActionFormData(
    new Request('https://nullbuilder.example.test/', {
      method: 'POST',
      headers: {
        'Content-Type': 'multipart/form-data; boundary=nullbuilder'
      },
      body: '--nullbuilder\r\nContent-Disposition: form-data; name="webToken"\r\n\r\nprivate-secret'
    })
  );

  assert.deepEqual(multipartResult, {
    ok: false,
    status: 400,
    message: 'Invalid form body.'
  });
  assert.equal(multipartResult.message.includes('private-secret'), false);
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

test('runLoginWebAction rejects unknown form fields before creating a session', () => {
  const config = readConfig({
    NULLBUILDER_REPOS: 'nullbuilder',
    NULLBUILDER_WEB_TOKEN: 'web-secret'
  });
  const limiter = testLoginRateLimiter(2);
  const formData = new FormData();
  formData.set('webToken', 'web-secret');
  formData.set('unexpected', 'private-login-value');

  assert.deepEqual(runLoginWebAction(config, limiter, 'client', formData), {
    ok: false,
    status: 403,
    message: 'Invalid web token.'
  });
  assert.equal(limiter.size, 1);
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

  const unknownFieldForm = new FormData();
  unknownFieldForm.set('csrfToken', csrfToken);
  unknownFieldForm.set('unexpected', 'private-logout-value');

  assert.deepEqual(runLogoutWebAction(config, cookies, unknownFieldForm), {
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

test('runBuildPrWebMutation rejects unknown form fields before executor', async () => {
  const { config, cookies, csrfToken } = authorizedMutationContext();
  const formData = new FormData();
  formData.set('csrfToken', csrfToken);
  formData.set('repo', 'nullbuilder');
  formData.set('prNumber', '17');
  formData.set('unexpected', 'secret');
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

test('runBuildPrWebMutation rejects excessive form fields before executor', async () => {
  const { config, cookies, csrfToken } = authorizedMutationContext();
  const formData = new FormData();
  formData.set('csrfToken', csrfToken);
  formData.set('repo', 'nullbuilder');
  formData.set('prNumber', '17');
  formData.set('tagName', 'build-pr-17');
  formData.set('confirm', 'on');
  formData.set('force', 'on');
  assert.equal(Array.from(formData.keys()).length, MAX_WEB_ACTION_FORM_FIELDS);
  formData.append('unexpected', 'value');
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

function formDataWithoutGetAll(): FormData {
  const formData = new FormData();
  formData.getAll = () => {
    throw new Error('getAll should not be called.');
  };
  return formData;
}

function webFormRequest(body: string, headers: HeadersInit = {}): Request {
  return new Request('https://nullbuilder.example.test/', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      ...headers
    },
    body
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
