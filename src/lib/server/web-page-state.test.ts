import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import type { Cookies } from '@sveltejs/kit';
import type { AuditReport } from './audit-types';
import { AUTH_COOKIE, createSessionToken } from './auth';
import { readConfig } from './config';
import type { DashboardData } from './github-dashboard';
import { buildDashboardPageState, resolveDashboardAccess } from './web-page-state';

test('dashboard page state blocks token-backed data until web auth is valid', () => {
  const config = readConfig({
    NULLBUILDER_REPOS: 'nullbuilder',
    NULLBUILDER_GITHUB_TOKEN: 'github-token'
  });
  const cookies = cookiesWith();
  const access = resolveDashboardAccess(config, cookies);

  assert.deepEqual(access, {
    authRequired: true,
    authConfigured: false,
    authenticated: false,
    canReadData: false
  });
  assert.deepEqual(buildDashboardPageState(config, cookies, access), {
    dashboard: null,
    audit: null,
    authRequired: true,
    authConfigured: false,
    authenticated: false,
    webMutationsEnabled: false,
    webMutationsAvailable: false,
    hasGitHubToken: true,
    ownerUrl: 'https://github.com/nullclaw',
    csrfToken: null
  });
});

test('dashboard page state ignores payload when access cannot read data', () => {
  const config = readConfig({
    NULLBUILDER_REPOS: 'nullbuilder',
    NULLBUILDER_GITHUB_TOKEN: 'github-token',
    NULLBUILDER_WEB_TOKEN: 'web-secret',
    NULLBUILDER_ENABLE_MUTATIONS: 'true'
  });
  const cookies = cookiesWith();
  const access = resolveDashboardAccess(config, cookies);
  const state = buildDashboardPageState(config, cookies, access, pagePayload());

  assert.equal(access.canReadData, false);
  assert.equal(state.dashboard, null);
  assert.equal(state.audit, null);
  assert.equal(state.csrfToken, null);
  assert.equal(state.webMutationsAvailable, false);
});

test('dashboard page state allows anonymous data when no tokens are configured', () => {
  const config = readConfig({
    NULLBUILDER_REPOS: 'nullbuilder',
    NULLBUILDER_GITHUB_WEB_URL: 'https://github.example.test/'
  });
  const cookies = cookiesWith();
  const access = resolveDashboardAccess(config, cookies);
  const payload = pagePayload();

  assert.equal(access.canReadData, true);
  assert.deepEqual(buildDashboardPageState(config, cookies, access, payload), {
    dashboard: payload.dashboard,
    audit: payload.audit,
    authRequired: false,
    authConfigured: false,
    authenticated: true,
    webMutationsEnabled: false,
    webMutationsAvailable: false,
    hasGitHubToken: false,
    ownerUrl: 'https://github.example.test/nullclaw',
    csrfToken: null
  });
});

test('dashboard page state exposes mutations only for authenticated web sessions', () => {
  const config = readConfig({
    NULLBUILDER_REPOS: 'nullbuilder',
    NULLBUILDER_WEB_TOKEN: 'web-secret',
    NULLBUILDER_ENABLE_MUTATIONS: 'true'
  });
  const cookies = cookiesWith(createSessionToken('web-secret'));
  const access = resolveDashboardAccess(config, cookies);
  const state = buildDashboardPageState(config, cookies, access, pagePayload());

  assert.equal(access.canReadData, true);
  assert.equal(state.authRequired, true);
  assert.equal(state.authConfigured, true);
  assert.equal(state.authenticated, true);
  assert.equal(state.webMutationsEnabled, true);
  assert.equal(state.webMutationsAvailable, true);
  assert.equal(typeof state.csrfToken, 'string');
});

test('dashboard page state keeps mutation csrf tied to authenticated access', () => {
  const config = readConfig({
    NULLBUILDER_REPOS: 'nullbuilder',
    NULLBUILDER_WEB_TOKEN: 'web-secret',
    NULLBUILDER_ENABLE_MUTATIONS: 'true'
  });
  const cookies = cookiesWith(createSessionToken('web-secret'));
  const access = resolveDashboardAccess(config, cookies);
  const state = buildDashboardPageState(config, cookies, access);

  assert.equal(state.dashboard, null);
  assert.equal(state.audit, null);
  assert.equal(state.webMutationsAvailable, true);
  assert.equal(typeof state.csrfToken, 'string');
});

function pagePayload(): { dashboard: DashboardData; audit: AuditReport } {
  return {
    dashboard: { generatedAt: '2026-06-09T00:00:00Z' } as DashboardData,
    audit: { generatedAt: '2026-06-09T00:00:00Z' } as AuditReport
  };
}

function cookiesWith(value?: string): Cookies {
  return {
    get: (name: string) => (name === AUTH_COOKIE ? value : undefined)
  } as Cookies;
}
