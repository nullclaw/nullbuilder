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
        'https://github.example.test/nullclaw/nullbuilder/blob/main/.github/workflows/release.yml',
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
  assert.equal(finding.url, 'https://github.example.test/nullclaw/nullbuilder/blob/main/.github/workflows/release.yml');
});

test('evaluateAuditRule falls back to repository URLs for findings', () => {
  const rule: AuditRule = {
    id: 'security-policy',
    title: 'Security policy exists',
    area: 'security',
    evaluate: (_context, finding) => [
      finding('warning', 'Missing security policy', 'Add SECURITY.md so reports have a stable intake path.')
    ]
  };

  const result = evaluateAuditRule(rule, auditContext());

  assert.equal(result.findings[0].url, 'https://github.example.test/nullclaw/nullbuilder');
});

test('evaluateAuditRule rejects unsafe repository fallback URLs', () => {
  const rule: AuditRule = {
    id: 'unsafe-repository-url',
    title: 'Repository URL fallback is safe',
    area: 'security',
    evaluate: (_context, finding) => [
      finding('warning', 'Unsafe fallback', 'Do not emit unsafe repository URLs.'),
      finding('warning', 'Unsafe custom URL', 'Do not fall back to unsafe repository URLs.', 'javascript:alert(1)')
    ]
  };
  const context = auditContext();
  context.repository.html_url = 'javascript:alert(1)';

  const result = evaluateAuditRule(rule, context);

  assert.equal(result.findings[0].url, '');
  assert.equal(result.findings[1].url, '');
});

test('evaluateAuditRule constrains custom finding URLs to the repository', () => {
  const rule: AuditRule = {
    id: 'workflow-url',
    title: 'Workflow URL is safe',
    area: 'workflow',
    evaluate: (_context, finding) => [
      finding('warning', 'Cross-origin URL', 'Do not link outside the repository.', 'https://evil.example.test/steal'),
      finding(
        'warning',
        'Control-bearing URL',
        'Do not link unsafe URLs.',
        'https://github.example.test/nullclaw/nullbuilder/actions\x1b[31m'
      ),
      finding(
        'warning',
        'Same-repository URL',
        'Keep safe repository links.',
        'https://github.example.test/nullclaw/nullbuilder/actions/runs/1'
      )
    ]
  };

  const result = evaluateAuditRule(rule, auditContext());

  assert.equal(result.findings[0].url, 'https://github.example.test/nullclaw/nullbuilder');
  assert.equal(result.findings[1].url, 'https://github.example.test/nullclaw/nullbuilder');
  assert.equal(result.findings[2].url, 'https://github.example.test/nullclaw/nullbuilder/actions/runs/1');
});

test('evaluateAuditRule parses repository URLs with captured URL constructor', () => {
  const originalUrl = globalThis.URL;
  Object.defineProperty(globalThis, 'URL', {
    configurable: true,
    writable: true,
    value: class URLShouldNotBeCalled {
      constructor() {
        throw new Error('global URL constructor should not be called');
      }
    }
  });

  try {
    const rule: AuditRule = {
      id: 'workflow-url',
      title: 'Workflow URL is safe',
      area: 'workflow',
      evaluate: (_context, finding) => [
        finding(
          'warning',
          'Same-repository URL',
          'Keep safe repository links.',
          'https://github.example.test/nullclaw/nullbuilder/actions/runs/1'
        )
      ]
    };

    const result = evaluateAuditRule(rule, auditContext());

    assert.equal(result.findings[0].url, 'https://github.example.test/nullclaw/nullbuilder/actions/runs/1');
  } finally {
    Object.defineProperty(globalThis, 'URL', {
      configurable: true,
      writable: true,
      value: originalUrl
    });
  }
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
