import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import type { RepoSlug } from '../repositories';
import type { AuditFinding, AuditRepositoryResult, AuditSeverity } from './audit-types';
import {
  buildAuditTotals,
  checkStatus,
  countFindings,
  scoreFindings,
  sortFindings
} from './audit-summary';

test('checkStatus returns the highest severity present', () => {
  assert.equal(checkStatus([]), 'ok');
  assert.equal(checkStatus([finding('info')]), 'info');
  assert.equal(checkStatus([finding('info'), finding('warning')]), 'warning');
  assert.equal(checkStatus([finding('warning'), finding('critical')]), 'critical');
});

test('scoreFindings applies severity penalties and clamps to zero', () => {
  assert.equal(scoreFindings([]), 100);
  assert.equal(scoreFindings([finding('critical'), finding('warning'), finding('info')]), 45);
  assert.equal(scoreFindings(Array.from({ length: 4 }, () => finding('critical'))), 0);
});

test('countFindings counts each severity independently', () => {
  assert.deepEqual(countFindings([finding('critical'), finding('warning'), finding('warning')]), {
    critical: 1,
    warning: 2,
    info: 0
  });
});

test('sortFindings orders by severity repository and title', () => {
  const sorted = [
    finding('info', 'nullclaw/zeta', 'Zeta'),
    finding('critical', 'nullclaw/zeta', 'Beta'),
    finding('critical', 'nullclaw/alpha', 'Gamma'),
    finding('critical', 'nullclaw/alpha', 'Alpha'),
    finding('warning', 'nullclaw/alpha', 'Alpha')
  ].sort(sortFindings);

  assert.deepEqual(
    sorted.map((item) => `${item.severity}:${item.repo}:${item.title}`),
    [
      'critical:nullclaw/alpha:Alpha',
      'critical:nullclaw/alpha:Gamma',
      'critical:nullclaw/zeta:Beta',
      'warning:nullclaw/alpha:Alpha',
      'info:nullclaw/zeta:Zeta'
    ]
  );
});

test('buildAuditTotals summarizes loaded errored and average score', () => {
  const critical = finding('critical');
  const warning = finding('warning');
  const info = finding('info');

  assert.deepEqual(
    buildAuditTotals([repository('ok', 80), repository('ok', 70), repository('error', 0)], [critical, warning, info]),
    {
      repositories: 3,
      loadedRepositories: 2,
      erroredRepositories: 1,
      critical: 1,
      warning: 1,
      info: 1,
      findings: 3,
      averageScore: 75
    }
  );

  assert.equal(buildAuditTotals([repository('error', 0)], []).averageScore, 0);
});

test('buildAuditTotals clamps unsafe repository scores before averaging', () => {
  assert.equal(
    buildAuditTotals([repository('ok', 150), repository('ok', -25), repository('ok', Number.NaN)], []).averageScore,
    33
  );
});

function finding(
  severity: AuditSeverity,
  repo: RepoSlug = 'nullclaw/nullbuilder',
  title = `${severity} finding`
): AuditFinding {
  return {
    id: `${repo}:${severity}:${title}`,
    ruleId: 'test-rule',
    repo,
    severity,
    area: 'workflow',
    title,
    detail: 'detail'
  };
}

function repository(status: 'ok' | 'error', score: number): AuditRepositoryResult {
  return {
    repo: status === 'ok' ? ('nullclaw/nullbuilder' as const) : ('nullclaw/broken' as const),
    url: 'https://github.example.test/nullclaw/nullbuilder',
    defaultBranch: status === 'ok' ? 'main' : 'unknown',
    status,
    score,
    checks: [],
    findings: []
  };
}
