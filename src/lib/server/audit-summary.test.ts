import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import type { RepoSlug } from '../repositories';
import type { AuditFinding, AuditRepositoryResult, AuditSeverity } from './audit-types';
import {
  buildAuditTotals,
  checkStatus,
  collectAuditFindings,
  collectCheckFindings,
  countFindings,
  MAX_AUDIT_REPORT_FINDINGS,
  MAX_AUDIT_REPOSITORY_FINDINGS,
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

test('collectCheckFindings flattens checks into sorted repository findings', () => {
  const collected = collectCheckFindings([
    {
      id: 'info-check',
      title: 'Info check',
      area: 'workflow',
      status: 'info',
      findings: [finding('info', 'nullclaw/zeta', 'Info')]
    },
    {
      id: 'critical-check',
      title: 'Critical check',
      area: 'security',
      status: 'critical',
      findings: [
        finding('critical', 'nullclaw/zeta', 'Beta'),
        finding('critical', 'nullclaw/alpha', 'Alpha')
      ]
    }
  ]);

  assert.deepEqual(
    collected.map((item) => `${item.severity}:${item.repo}:${item.title}`),
    [
      'critical:nullclaw/alpha:Alpha',
      'critical:nullclaw/zeta:Beta',
      'info:nullclaw/zeta:Info'
    ]
  );
});

test('collectCheckFindings caps noisy repository findings', () => {
  const findings = Array.from({ length: MAX_AUDIT_REPOSITORY_FINDINGS + 2 }, (_, index) =>
    finding('warning', 'nullclaw/noisy', `Finding ${String(index).padStart(4, '0')}`)
  );
  const noisyCheck = {
    id: 'noisy-check',
    title: 'Noisy check',
    area: 'workflow',
    status: 'warning',
    findings
  } as const;
  const collected = collectCheckFindings([noisyCheck]);
  const explicitlyOversized = collectCheckFindings([noisyCheck], MAX_AUDIT_REPOSITORY_FINDINGS + 500);

  assert.equal(collected.length, MAX_AUDIT_REPOSITORY_FINDINGS);
  assert.equal(explicitlyOversized.length, MAX_AUDIT_REPOSITORY_FINDINGS);
  assert.equal(
    collected.at(-1)?.title,
    `Finding ${String(MAX_AUDIT_REPOSITORY_FINDINGS - 1).padStart(4, '0')}`
  );
  assert.deepEqual(
    collectCheckFindings([noisyCheck], 0),
    []
  );
  assert.deepEqual(
    collectCheckFindings([noisyCheck], Number.NaN),
    []
  );
});

test('collectCheckFindings isolates collected findings from check results', () => {
  const sourceFinding = finding('critical', 'nullclaw/nullbuilder', 'Original title');
  const collected = collectCheckFindings([
    {
      id: 'source-check',
      title: 'Source check',
      area: 'security',
      status: 'critical',
      findings: [sourceFinding]
    }
  ]);

  assert.notEqual(collected[0], sourceFinding);
  collected[0].title = 'Changed title';

  assert.equal(sourceFinding.title, 'Original title');
});

test('audit summary helpers avoid user-controlled array iterators', () => {
  class UnsafeIteratorArray<T> extends Array<T> {
    override [Symbol.iterator](): ArrayIterator<T> {
      throw new Error('iterator should not be called');
    }
  }
  const findings = new UnsafeIteratorArray(finding('warning', 'nullclaw/zeta', 'Zeta'));
  const checks = new UnsafeIteratorArray({
    id: 'iterator-check',
    title: 'Iterator check',
    area: 'workflow',
    status: 'warning',
    findings
  } as const);
  const repositories = new UnsafeIteratorArray(repository('ok', 90, findings));

  assert.equal(checkStatus(findings), 'warning');
  assert.deepEqual(countFindings(findings), { critical: 0, warning: 1, info: 0 });
  assert.equal(scoreFindings(findings), 85);
  assert.deepEqual(
    collectCheckFindings(checks).map((item) => item.title),
    ['Zeta']
  );
  assert.deepEqual(
    collectAuditFindings(repositories).map((item) => item.title),
    ['Zeta']
  );
  assert.equal(buildAuditTotals(repositories).warning, 1);
});

test('collectAuditFindings returns a bounded sorted report list', () => {
  const collected = collectAuditFindings(
    [
      repository('ok', 100, [
        finding('info', 'nullclaw/zeta', 'Info'),
        finding('critical', 'nullclaw/zeta', 'Beta'),
        finding('warning', 'nullclaw/alpha', 'Warning')
      ]),
      repository('ok', 100, [finding('critical', 'nullclaw/alpha', 'Alpha')])
    ],
    3
  );

  assert.deepEqual(
    collected.map((item) => `${item.severity}:${item.repo}:${item.title}`),
    [
      'critical:nullclaw/alpha:Alpha',
      'critical:nullclaw/zeta:Beta',
      'warning:nullclaw/alpha:Warning'
    ]
  );
  assert.deepEqual(collectAuditFindings([repository('ok', 100, [finding('critical')])], 0), []);
});

test('collectAuditFindings caps noisy audit reports', () => {
  const findings = Array.from({ length: MAX_AUDIT_REPORT_FINDINGS + 2 }, (_, index) =>
    finding('warning', 'nullclaw/noisy', `Finding ${String(index).padStart(4, '0')}`)
  );
  const collected = collectAuditFindings([repository('ok', 100, findings)]);
  const explicitlyOversized = collectAuditFindings(
    [repository('ok', 100, findings)],
    MAX_AUDIT_REPORT_FINDINGS + 500
  );

  assert.equal(collected.length, MAX_AUDIT_REPORT_FINDINGS);
  assert.equal(explicitlyOversized.length, MAX_AUDIT_REPORT_FINDINGS);
  assert.equal(collected.at(-1)?.title, `Finding ${String(MAX_AUDIT_REPORT_FINDINGS - 1).padStart(4, '0')}`);
});

test('collectAuditFindings isolates report findings from repository findings', () => {
  const sourceFinding = finding('warning', 'nullclaw/nullbuilder', 'Repository warning');
  const collected = collectAuditFindings([repository('ok', 100, [sourceFinding])]);

  assert.notEqual(collected[0], sourceFinding);
  collected[0].detail = 'changed detail';

  assert.equal(sourceFinding.detail, 'detail');
});

test('buildAuditTotals summarizes loaded errored and average score', () => {
  const critical = finding('critical');
  const warning = finding('warning');
  const info = finding('info');

  assert.deepEqual(
    buildAuditTotals([
      repository('ok', 80, [critical, warning]),
      repository('ok', 70, [info]),
      repository('error', 0)
    ]),
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

  assert.equal(buildAuditTotals([repository('error', 0)]).averageScore, 0);
});

test('buildAuditTotals clamps unsafe repository scores before averaging', () => {
  assert.equal(
    buildAuditTotals([repository('ok', 150), repository('ok', -25), repository('ok', Number.NaN)]).averageScore,
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

function repository(status: 'ok' | 'error', score: number, findings: AuditFinding[] = []): AuditRepositoryResult {
  return {
    repo: status === 'ok' ? ('nullclaw/nullbuilder' as const) : ('nullclaw/broken' as const),
    url: 'https://github.example.test/nullclaw/nullbuilder',
    defaultBranch: status === 'ok' ? 'main' : 'unknown',
    status,
    score,
    checks: [],
    findings
  };
}
