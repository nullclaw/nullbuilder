import { fail } from '@sveltejs/kit';
import { getAuditReport } from '$lib/server/audit';
import {
  AUTH_COOKIE,
  AUTH_MAX_AGE_SECONDS,
  createCsrfToken,
  createSessionToken,
  isAuthenticated,
  isCsrfTokenMatch,
  isTokenMatch,
  LoginRateLimiter
} from '$lib/server/auth';
import { buildPrTag, createReleaseTag, discoverRepositories, getDashboard, publicErrorMessage } from '$lib/server/github';
import { readConfig } from '$lib/server/config';
import {
  mutationAccessError,
  parseBuildPrMutationForm,
  parseReleaseTagMutationForm
} from '$lib/server/web-actions';
import type { Actions, PageServerLoad } from './$types';

const LOGIN_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_RATE_LIMIT_MAX_FAILURES = 5;
const LOGIN_RATE_LIMIT_MAX_KEYS = 1000;

const loginRateLimiter = new LoginRateLimiter({
  windowMs: LOGIN_RATE_LIMIT_WINDOW_MS,
  maxFailures: LOGIN_RATE_LIMIT_MAX_FAILURES,
  maxKeys: LOGIN_RATE_LIMIT_MAX_KEYS
});

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

    if (!loginRateLimiter.isAllowed(rateLimitKey)) {
      return fail(429, {
        authError: 'Too many failed login attempts. Try again later.'
      });
    }

    if (!isTokenMatch(token, config.webToken)) {
      loginRateLimiter.recordFailure(rateLimitKey);
      return fail(403, {
        authError: 'Invalid web token.'
      });
    }

    loginRateLimiter.clear(rateLimitKey);
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

    const buildForm = parseBuildPrMutationForm(formData);

    if (!buildForm.repo || !buildForm.prNumber) {
      return fail(400, {
        buildError: 'Repository and a positive PR number are required.'
      });
    }

    try {
      const result = await buildPrTag(config, {
        repo: buildForm.repo,
        prNumber: buildForm.prNumber,
        tagName: buildForm.tagName,
        confirm: buildForm.confirm,
        force: buildForm.force
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

    const releaseForm = parseReleaseTagMutationForm(formData);

    if (!releaseForm.repo || !releaseForm.tagName) {
      return fail(400, {
        releaseError: 'Repository and release tag are required.'
      });
    }

    try {
      const result = await createReleaseTag(config, {
        repo: releaseForm.repo,
        tagName: releaseForm.tagName,
        targetRef: releaseForm.targetRef,
        confirm: releaseForm.confirm,
        force: releaseForm.force
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
