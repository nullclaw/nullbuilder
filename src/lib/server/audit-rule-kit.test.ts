import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import type { RepoSlug } from '../repositories';
import {
  evaluateAuditRule,
  isPresent,
  type AuditContext,
  type AuditRule,
  type Probe
} from './audit-rule-kit';

test('evaluateAuditRule binds findings to rule metadata', () => {
  const rule: AuditRule = {
    id: 'release-guard',
    title: 'Release guard exists',
    area: 'release',
    evaluate: (_context, finding) => [
      finding(
        'critical',
        'Mutable release workflow',
        'Pin reusable release workflows to immutable tags.',
        'https://example.test/workflow',
        '.github/workflows/release.yml'
      )
    ]
  };

  const result = evaluateAuditRule(rule, auditContext());
  const finding = result.findings[0];

  assert.equal(result.id, 'release-guard');
  assert.equal(result.title, 'Release guard exists');
  assert.equal(result.area, 'release');
  assert.equal(result.status, 'critical');
  assert.equal(finding.ruleId, 'release-guard');
  assert.equal(finding.area, 'release');
  assert.equal(
    finding.id,
    'nullclaw/nullbuilder:release-guard:critical:Mutable release workflow:.github/workflows/release.yml'
  );
});

test('isPresent narrows probe data', () => {
  const present: Probe<{ value: number }> = { status: 'present', data: { value: 7 } };
  const missing: Probe<{ value: number }> = { status: 'missing' };

  assert.equal(isPresent(present), true);
  assert.equal(present.data.value, 7);
  assert.equal(isPresent(missing), false);
});

function auditContext(): AuditContext {
  return {
    repo: 'nullclaw/nullbuilder' as RepoSlug,
    repository: {
      full_name: 'nullclaw/nullbuilder',
      html_url: 'https://github.example.test/nullclaw/nullbuilder',
      default_branch: 'main',
      private: false,
      archived: false
    },
    workflowDirectory: { status: 'missing' },
    workflowFiles: [],
    branchProtection: { status: 'missing' },
    dependabot: { status: 'missing' },
    securityPolicy: { status: 'missing' },
    githubSecurityPolicy: { status: 'missing' },
    codeowners: { status: 'missing' },
    githubCodeowners: { status: 'missing' }
  };
}
