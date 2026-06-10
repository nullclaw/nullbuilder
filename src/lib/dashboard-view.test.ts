import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  DASHBOARD_SECTIONS,
  auditFindingHref,
  auditRepositoryHref,
  authGateCopy,
  authStateLabel,
  buildAuditRepositoryUrls,
  buildPrResultMessage,
  dashboardOwner,
  dashboardExternalHref,
  hasDashboardReadErrors,
  releaseResultMessage,
  visibleAuditFindings
} from './dashboard-view';

test('dashboardOwner falls back to the default owner', () => {
  assert.equal(dashboardOwner({ owner: 'octo' }), 'octo');
  assert.equal(dashboardOwner(null), 'nullclaw');
});

test('authGateCopy keeps authentication panel copy centralized', () => {
  assert.deepEqual(authGateCopy(true), {
    title: 'Authentication Required',
    description: 'Enter the configured web token to unlock the dashboard.'
  });
  assert.deepEqual(authGateCopy(false), {
    title: 'Web Token Required',
    description: 'Set NULLBUILDER_WEB_TOKEN before exposing token-backed dashboard data.'
  });
});

test('authStateLabel keeps token state display logic explicit', () => {
  assert.equal(authStateLabel(true, true), 'Authenticated');
  assert.equal(authStateLabel(false, true), 'Locked token');
  assert.equal(authStateLabel(false, false), 'Anonymous API');
});

test('hasDashboardReadErrors includes repository and audit failures', () => {
  assert.equal(hasDashboardReadErrors([{ error: 'failed' }], null), true);
  assert.equal(hasDashboardReadErrors([], { hasReadErrors: true }), true);
  assert.equal(hasDashboardReadErrors([{ error: '' }], { hasReadErrors: false }), false);
});

test('visibleAuditFindings bounds and validates the display limit', () => {
  assert.deepEqual(visibleAuditFindings([1, 2, 3], 2), [1, 2]);
  assert.deepEqual(visibleAuditFindings([1, 2, 3], 0), []);
  assert.deepEqual(visibleAuditFindings([1, 2, 3], Number.NaN), []);
});

test('audit href helpers prefer safe finding URLs before repository fallbacks', () => {
  const repositoryUrls = buildAuditRepositoryUrls([
    { repo: 'nullclaw/nullbuilder', url: 'https://github.example.test/nullclaw/nullbuilder' },
    { repo: 'nullclaw/unsafe', url: 'javascript:alert(1)' }
  ]);

  assert.equal(
    auditFindingHref(
      {
        repo: 'nullclaw/nullbuilder',
        url: 'https://github.example.test/nullclaw/nullbuilder/actions'
      },
      repositoryUrls
    ),
    'https://github.example.test/nullclaw/nullbuilder/actions'
  );
  assert.equal(
    auditFindingHref({ repo: 'nullclaw/nullbuilder', url: '' }, repositoryUrls),
    'https://github.example.test/nullclaw/nullbuilder'
  );
  assert.equal(auditFindingHref({ repo: 'nullclaw/unsafe' }, repositoryUrls), '#audit');
  assert.equal(auditRepositoryHref('javascript:alert(1)'), '#audit');
});

test('audit href helpers reject control-bearing and credentialed URLs', () => {
  const repositoryUrls = buildAuditRepositoryUrls([
    { repo: 'nullclaw/control', url: 'https://github.example.test/nullclaw/control%0aoutput=true' },
    { repo: 'nullclaw/creds', url: 'https://user:pass@github.example.test/nullclaw/creds' },
    { repo: 'nullclaw/runtime', url: 42 },
    { repo: 'nullclaw/safe', url: 'http://localhost/nullclaw/safe' }
  ]);

  assert.equal(repositoryUrls.has('nullclaw/control'), false);
  assert.equal(repositoryUrls.has('nullclaw/creds'), false);
  assert.equal(repositoryUrls.has('nullclaw/runtime'), false);
  assert.equal(repositoryUrls.get('nullclaw/safe'), 'http://localhost/nullclaw/safe');
  assert.equal(
    auditFindingHref(
      { repo: 'nullclaw/safe', url: 'https://github.example.test/nullclaw/safe\nbad' },
      repositoryUrls
    ),
    'http://localhost/nullclaw/safe'
  );
});

test('dashboardExternalHref applies a safe fallback before the local fallback', () => {
  assert.equal(
    dashboardExternalHref('javascript:alert(1)', 'https://github.example.test/nullclaw/nullbuilder'),
    'https://github.example.test/nullclaw/nullbuilder'
  );
  assert.equal(dashboardExternalHref('javascript:alert(1)', '#audit'), '#audit');
  assert.equal(dashboardExternalHref('javascript:alert(1)', 'https://user:pass@github.example.test/repo'), '#');
  assert.equal(
    dashboardExternalHref('https://github.example.test/nullclaw/nullbuilder'),
    'https://github.example.test/nullclaw/nullbuilder'
  );
});

test('mutation result messages share dry-run move and create wording', () => {
  assert.equal(
    buildPrResultMessage({
      dryRun: true,
      forced: false,
      repo: 'nullclaw/nullbuilder',
      tagName: 'build-pr-7-de0fac2',
      prNumber: 7
    }),
    'Previewed build-pr-7-de0fac2 for nullclaw/nullbuilder #7'
  );

  assert.equal(
    buildPrResultMessage({
      dryRun: false,
      forced: true,
      repo: 'nullclaw/nullbuilder',
      tagName: 'build-pr-7-de0fac2',
      prNumber: 7
    }),
    'Moved build-pr-7-de0fac2 for nullclaw/nullbuilder #7'
  );

  assert.equal(
    releaseResultMessage({
      dryRun: false,
      forced: false,
      repo: 'nullclaw/nullbuilder',
      tagName: 'v1.2.3',
      targetSha: 'de0fac2e4500dabe0009e67214ff5f5447ce83dd'
    }),
    'Created v1.2.3 for nullclaw/nullbuilder at de0fac2'
  );
});

test('DASHBOARD_SECTIONS defines stable in-page navigation ids', () => {
  assert.deepEqual(
    DASHBOARD_SECTIONS.map((section) => section.id),
    ['repos', 'audit', 'issues', 'prs', 'build-pr', 'release-tag']
  );
});
