import type { Cookies } from '@sveltejs/kit';
import type { AuditReport } from './audit-types';
import { resolveAuthContext } from './auth';
import type { NullbuilderConfig } from './config';
import type { DashboardData } from './github-dashboard';
import { githubOwnerWebUrl } from './github-web-urls';

export type DashboardAccessState = {
  authRequired: boolean;
  authConfigured: boolean;
  authenticated: boolean;
  canReadData: boolean;
  csrfToken: string | null;
};

export type DashboardPagePayload = {
  dashboard: DashboardData;
  audit: AuditReport;
};

export type DashboardPageState = {
  dashboard: DashboardData | null;
  audit: AuditReport | null;
  authRequired: boolean;
  authConfigured: boolean;
  authenticated: boolean;
  webMutationsEnabled: boolean;
  webMutationsAvailable: boolean;
  hasGitHubToken: boolean;
  ownerUrl: string;
  csrfToken: string | null;
};

export function resolveDashboardAccess(config: NullbuilderConfig, cookies: Cookies): DashboardAccessState {
  const authRequired = Boolean(config.webToken || config.token);
  const authContext = resolveAuthContext(cookies, config);

  return {
    authRequired,
    authConfigured: Boolean(config.webToken),
    authenticated: authContext.authenticated,
    canReadData: !authRequired || authContext.authenticated,
    csrfToken: authContext.csrfToken
  };
}

export function buildDashboardPageState(
  config: NullbuilderConfig,
  access: DashboardAccessState,
  payload?: DashboardPagePayload
): DashboardPageState {
  const visiblePayload = access.canReadData ? payload : undefined;
  const webMutationsAvailable = config.enableWebMutations && access.authConfigured && access.authenticated;
  const csrfToken = access.authConfigured && access.authenticated ? access.csrfToken : null;

  return {
    dashboard: visiblePayload?.dashboard ?? null,
    audit: visiblePayload?.audit ?? null,
    authRequired: access.authRequired,
    authConfigured: access.authConfigured,
    authenticated: access.authenticated,
    webMutationsEnabled: config.enableWebMutations,
    webMutationsAvailable,
    hasGitHubToken: Boolean(config.token),
    ownerUrl: githubOwnerWebUrl(config.webBaseUrl, config.owner),
    csrfToken
  };
}
