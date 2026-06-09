import { createHmac, timingSafeEqual } from 'node:crypto';
import { fail, type Cookies } from '@sveltejs/kit';
import { getAuditReport } from '$lib/server/audit';
import { buildPrTag, createReleaseTag, discoverRepositories, getDashboard, publicErrorMessage } from '$lib/server/github';
import { readConfig, type NullbuilderConfig } from '$lib/server/config';
import type { Actions, PageServerLoad } from './$types';

const AUTH_COOKIE = 'nullbuilder_auth';
const AUTH_MAX_AGE_SECONDS = 8 * 60 * 60;
const LOGIN_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_RATE_LIMIT_MAX_FAILURES = 5;
const LOGIN_RATE_LIMIT_MAX_KEYS = 1000;

type LoginAttempt = {
  failures: number;
  resetAt: number;
};

const loginAttempts = new Map<string, LoginAttempt>();

export const load: PageServerLoad = async ({ cookies }) => {
  const config = readConfig();
  const authRequired = Boolean(config.webToken || config.token);
  const authConfigured = Boolean(config.webToken);
  const authenticated = isAuthenticated(cookies, config);

  if (authRequired && !authenticated) {
    return {
      dashboard: null,
      audit: null,
      authRequired,
      authConfigured,
      authenticated: false,
      webMutationsEnabled: config.enableWebMutations,
      webMutationsAvailable: false,
      hasGitHubToken: Boolean(config.token),
      csrfToken: null
    };
  }

  const repos = config.discoverRepos ? await discoverRepositories(config) : config.repos;
  const readConfigWithRepos = {
    ...config,
    repos,
    discoverRepos: false
  };
  const [dashboard, audit] = await Promise.all([getDashboard(readConfigWithRepos), getAuditReport(readConfigWithRepos)]);
  const csrfToken = createCsrfToken(cookies, config);

  return {
    dashboard,
    audit,
    authRequired,
    authConfigured,
    authenticated,
    webMutationsEnabled: config.enableWebMutations,
    webMutationsAvailable: config.enableWebMutations && authConfigured && authenticated,
    hasGitHubToken: Boolean(config.token),
    csrfToken
  };
};

export const actions: Actions = {
  login: async ({ request, cookies, getClientAddress }) => {
    const config = readConfig();
    const rateLimitKey = getClientAddress();
    const formData = await request.formData();
    const token = String(formData.get('webToken') ?? '');

    if (!config.webToken) {
      return fail(403, {
        authError: 'Set NULLBUILDER_WEB_TOKEN before exposing token-backed dashboard data.'
      });
    }

    if (!isLoginAllowed(rateLimitKey)) {
      return fail(429, {
        authError: 'Too many failed login attempts. Try again later.'
      });
    }

    if (!isTokenMatch(token, config.webToken)) {
      recordLoginFailure(rateLimitKey);
      return fail(403, {
        authError: 'Invalid web token.'
      });
    }

    clearLoginFailures(rateLimitKey);
    cookies.set(AUTH_COOKIE, createSessionToken(config.webToken), {
      httpOnly: true,
      maxAge: AUTH_MAX_AGE_SECONDS,
      path: '/',
      sameSite: 'strict',
      secure: process.env.NODE_ENV === 'production'
    });

    return {
      authenticated: true
    };
  },

  logout: async ({ request, cookies }) => {
    const config = readConfig();
    const formData = await request.formData();

    if (config.webToken && isAuthenticated(cookies, config) && !isCsrfTokenMatch(formData.get('csrfToken'), cookies, config)) {
      return fail(403, {
        authError: 'Invalid request token.'
      });
    }

    cookies.delete(AUTH_COOKIE, {
      path: '/'
    });

    return {
      authenticated: false
    };
  },

  buildPr: async ({ request, cookies }) => {
    const config = readConfig();
    const formData = await request.formData();
    const accessError = mutationAccessError(config, cookies, formData.get('csrfToken'), 'build-pr');
    if (accessError) {
      return fail(403, {
        buildError: accessError
      });
    }

    const repo = String(formData.get('repo') ?? '');
    const prNumber = parsePositiveFormInteger(formData.get('prNumber'));
    const tagName = String(formData.get('tagName') ?? '').trim();
    const confirm = formData.get('confirm') === 'on';
    const force = formData.get('force') === 'on';

    if (!repo || !prNumber) {
      return fail(400, {
        buildError: 'Repository and a positive PR number are required.'
      });
    }

    try {
      const result = await buildPrTag(config, {
        repo,
        prNumber,
        tagName: tagName || undefined,
        confirm,
        force
      });

      return {
        buildResult: result
      };
    } catch (error) {
      return fail(500, {
        buildError: publicErrorMessage(error)
      });
    }
  },

  releaseTag: async ({ request, cookies }) => {
    const config = readConfig();
    const formData = await request.formData();
    const accessError = mutationAccessError(config, cookies, formData.get('csrfToken'), 'release-tag');
    if (accessError) {
      return fail(403, {
        releaseError: accessError
      });
    }

    const repo = String(formData.get('repo') ?? '');
    const tagName = String(formData.get('tagName') ?? '').trim();
    const targetRef = String(formData.get('targetRef') ?? '').trim();
    const confirm = formData.get('confirm') === 'on';
    const force = formData.get('force') === 'on';

    if (!repo || !tagName) {
      return fail(400, {
        releaseError: 'Repository and release tag are required.'
      });
    }

    try {
      const result = await createReleaseTag(config, {
        repo,
        tagName,
        targetRef: targetRef || undefined,
        confirm,
        force
      });

      return {
        releaseResult: result
      };
    } catch (error) {
      return fail(500, {
        releaseError: publicErrorMessage(error)
      });
    }
  }
};

function isAuthenticated(cookies: Cookies, config: NullbuilderConfig): boolean {
  if (!config.webToken) {
    return !config.token;
  }

  const cookie = cookies.get(AUTH_COOKIE);
  return Boolean(cookie && isSessionTokenMatch(cookie, config.webToken));
}

function isTokenMatch(value: string, expected: string): boolean {
  const left = Buffer.from(value);
  const right = Buffer.from(expected);

  return left.length === right.length && timingSafeEqual(left, right);
}

function createSessionToken(secret: string): string {
  const issuedAt = Date.now().toString(36);
  return `${issuedAt}.${sessionSignature(issuedAt, secret)}`;
}

function isSessionTokenMatch(value: string, secret: string): boolean {
  const parts = value.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    return false;
  }

  const [issuedAt, signature] = parts;
  const timestamp = Number.parseInt(issuedAt, 36);
  const now = Date.now();

  if (!Number.isFinite(timestamp) || timestamp > now + 60_000 || now - timestamp > AUTH_MAX_AGE_SECONDS * 1000) {
    return false;
  }

  return isTokenMatch(signature, sessionSignature(issuedAt, secret));
}

function sessionSignature(issuedAt: string, secret: string): string {
  return createHmac('sha256', secret).update(issuedAt).digest('hex');
}

function createCsrfToken(cookies: Cookies, config: NullbuilderConfig): string | null {
  if (!config.webToken) {
    return null;
  }

  const session = cookies.get(AUTH_COOKIE);
  if (!session || !isSessionTokenMatch(session, config.webToken)) {
    return null;
  }

  return createHmac('sha256', config.webToken).update(`csrf:${session}`).digest('hex');
}

function isCsrfTokenMatch(value: FormDataEntryValue | null, cookies: Cookies, config: NullbuilderConfig): boolean {
  const expected = createCsrfToken(cookies, config);
  return typeof value === 'string' && Boolean(expected && isTokenMatch(value, expected));
}

function mutationAccessError(
  config: NullbuilderConfig,
  cookies: Cookies,
  csrfToken: FormDataEntryValue | null,
  operation: 'build-pr' | 'release-tag'
): string | null {
  if (!config.enableWebMutations) {
    return `Web mutations are disabled. Set NULLBUILDER_ENABLE_MUTATIONS=true to enable ${operation} from the UI.`;
  }

  if (!config.webToken || !isAuthenticated(cookies, config)) {
    return 'Web mutations require NULLBUILDER_WEB_TOKEN authentication.';
  }

  if (!isCsrfTokenMatch(csrfToken, cookies, config)) {
    return 'Invalid request token.';
  }

  return null;
}

function parsePositiveFormInteger(value: FormDataEntryValue | null): number | null {
  if (typeof value !== 'string') {
    return null;
  }

  if (!/^[1-9]\d*$/.test(value)) {
    return null;
  }

  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function isLoginAllowed(key: string): boolean {
  pruneLoginAttempts();
  const attempt = loginAttempts.get(key);
  if (!attempt) {
    return true;
  }

  if (attempt.resetAt <= Date.now()) {
    loginAttempts.delete(key);
    return true;
  }

  return attempt.failures < LOGIN_RATE_LIMIT_MAX_FAILURES;
}

function recordLoginFailure(key: string): void {
  const now = Date.now();
  pruneLoginAttempts(now);
  const current = loginAttempts.get(key);

  if (!current || current.resetAt <= now) {
    loginAttempts.set(key, {
      failures: 1,
      resetAt: now + LOGIN_RATE_LIMIT_WINDOW_MS
    });
    return;
  }

  current.failures += 1;
}

function clearLoginFailures(key: string): void {
  loginAttempts.delete(key);
}

function pruneLoginAttempts(now = Date.now()): void {
  for (const [key, attempt] of loginAttempts) {
    if (attempt.resetAt <= now) {
      loginAttempts.delete(key);
    }
  }

  while (loginAttempts.size > LOGIN_RATE_LIMIT_MAX_KEYS) {
    const oldestKey = loginAttempts.keys().next().value;
    if (oldestKey === undefined) {
      return;
    }
    loginAttempts.delete(oldestKey);
  }
}
