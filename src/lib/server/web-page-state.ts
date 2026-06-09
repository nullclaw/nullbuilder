import type { Cookies } from '@sveltejs/kit';
import type { AuditReport } from './audit-types';
import { createCsrfToken, isAuthenticated } from './auth';
import type { NullbuilderConfig } from './config';
import type { DashboardData } from './github-dashboard';

export type DashboardAccessState = {
  authRequired: boolean;
  authConfigured: boolean;
  authenticated: boolean;
  canReadData: boolean;
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
  csrfToken: string | null;
};

export function resolveDashboardAccess(config: NullbuilderConfig, cookies: Cookies): DashboardAccessState {
  const authRequired = Boolean(config.webToken || config.token);
  const authenticated = isAuthenticated(cookies, config);

  return {
    authRequired,
    authConfigured: Boolean(config.webToken),
    authenticated,
    canReadData: !authRequired || authenticated
  };
}

export function buildDashboardPageState(
  config: NullbuilderConfig,
  cookies: Cookies,
  access: DashboardAccessState,
  payload?: DashboardPagePayload
): DashboardPageState {
  return {
    dashboard: payload?.dashboard ?? null,
    audit: payload?.audit ?? null,
    authRequired: access.authRequired,
    authConfigured: access.authConfigured,
    authenticated: access.authenticated,
    webMutationsEnabled: config.enableWebMutations,
    webMutationsAvailable: config.enableWebMutations && access.authConfigured && access.authenticated,
    hasGitHubToken: Boolean(config.token),
    csrfToken: payload ? createCsrfToken(cookies, config) : null
  };
}
