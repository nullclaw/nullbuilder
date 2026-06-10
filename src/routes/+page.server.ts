import { fail } from '@sveltejs/kit';
import { getAuditReport } from '$lib/server/audit';
import {
  AUTH_COOKIE,
  AUTH_COOKIE_DELETE_OPTIONS,
  authCookieOptions,
  LoginRateLimiter
} from '$lib/server/auth';
import { buildPrTag, createReleaseTag, discoverRepositories, getDashboard, publicErrorMessage } from '$lib/server/github';
import { readConfig } from '$lib/server/config';
import { buildDashboardPageState, resolveDashboardAccess } from '$lib/server/web-page-state';
import {
  runBuildPrWebMutation,
  runLoginWebAction,
  runLogoutWebAction,
  runReleaseTagWebMutation,
  readWebActionFormData
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
  const access = resolveDashboardAccess(config, cookies);

  if (!access.canReadData) {
    return buildDashboardPageState(config, cookies, access);
  }

  const repos = config.discoverRepos ? await discoverRepositories(config) : config.repos;
  const readConfigWithRepos = {
    ...config,
    repos,
    discoverRepos: false
  };
  const [dashboard, audit] = await Promise.all([getDashboard(readConfigWithRepos), getAuditReport(readConfigWithRepos)]);

  return buildDashboardPageState(config, cookies, access, { dashboard, audit });
};

export const actions: Actions = {
  login: async ({ request, cookies, getClientAddress }) => {
    const config = readConfig();
    const rateLimitKey = getClientAddress();
    const form = await readWebActionFormData(request);
    if (!form.ok) {
      return fail(form.status, {
        authError: form.message
      });
    }

    const login = runLoginWebAction(config, loginRateLimiter, rateLimitKey, form.formData);

    if (!login.ok) {
      return fail(login.status, {
        authError: login.message
      });
    }

    cookies.set(AUTH_COOKIE, login.sessionToken, authCookieOptions(process.env.NODE_ENV === 'production'));

    return {
      authenticated: true
    };
  },

  logout: async ({ request, cookies }) => {
    const config = readConfig();
    const form = await readWebActionFormData(request);
    if (!form.ok) {
      return fail(form.status, {
        authError: form.message
      });
    }

    const logout = runLogoutWebAction(config, cookies, form.formData);

    if (!logout.ok) {
      return fail(logout.status, {
        authError: logout.message
      });
    }

    cookies.delete(AUTH_COOKIE, AUTH_COOKIE_DELETE_OPTIONS);

    return {
      authenticated: false
    };
  },

  buildPr: async ({ request, cookies }) => {
    const config = readConfig();
    const form = await readWebActionFormData(request);
    if (!form.ok) {
      return fail(form.status, {
        buildError: form.message
      });
    }

    const mutation = await runBuildPrWebMutation(
      config,
      cookies,
      form.formData,
      (input) => buildPrTag(config, input),
      publicErrorMessage
    );

    if (!mutation.ok) {
      return fail(mutation.status, {
        buildError: mutation.message
      });
    }

    return {
      buildResult: mutation.result
    };
  },

  releaseTag: async ({ request, cookies }) => {
    const config = readConfig();
    const form = await readWebActionFormData(request);
    if (!form.ok) {
      return fail(form.status, {
        releaseError: form.message
      });
    }

    const mutation = await runReleaseTagWebMutation(
      config,
      cookies,
      form.formData,
      (input) => createReleaseTag(config, input),
      publicErrorMessage
    );

    if (!mutation.ok) {
      return fail(mutation.status, {
        releaseError: mutation.message
      });
    }

    return {
      releaseResult: mutation.result
    };
  }
};
