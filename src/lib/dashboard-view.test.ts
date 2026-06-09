import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  DASHBOARD_SECTIONS,
  authStateLabel,
  buildPrResultMessage,
  dashboardOwner,
  hasDashboardReadErrors,
  releaseResultMessage,
  visibleAuditFindings
} from './dashboard-view';

test('dashboardOwner falls back to the default owner', () => {
  assert.equal(dashboardOwner({ owner: 'octo' }), 'octo');
  assert.equal(dashboardOwner(null), 'nullclaw');
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
