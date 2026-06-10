import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import type { RepoSlug } from '../repositories';
import type { AuditFinding, AuditSeverity } from './audit-types';
import type { AuditContext, AuditFindingBuilder, WorkflowFile } from './audit-rule-kit';
import {
  mutableNullbuilderWorkflowRefFindings,
  nullbuilderWorkflowFindings,
  workflowPermissionFindings,
  workflowPinningFindings
} from './audit-workflow-policy';

test('nullbuilderWorkflowFindings reports only missing reusable workflow callers', () => {
  const findings = nullbuilderWorkflowFindings(
    auditContext({
      workflowFiles: [
        workflowFile(`
jobs:
  ci:
    uses: nullclaw/nullbuilder/.github/workflows/zig-ci.yml@v1
`)
      ]
    }),
    testFinding
  );

  assert.deepEqual(
    findings.map((finding) => finding.title),
    ['Missing nullbuilder nightly workflow', 'Missing nullbuilder release workflow']
  );
});

test('workflowPermissionFindings reports implicit permissions and self-hosted runners independently', () => {
  const findings = workflowPermissionFindings(
    auditContext({
      workflowFiles: [
        workflowFile(`
jobs:
  test:
    runs-on: self-hosted
`)
      ]
    }),
    testFinding
  );

  assert.deepEqual(
    findings.map((finding) => [finding.severity, finding.title]),
    [
      ['warning', 'Workflow token permissions are implicit'],
      ['warning', 'Workflow uses self-hosted runners']
    ]
  );
});

test('workflowPinningFindings caps noisy unpinned third-party action findings per file', () => {
  const findings = workflowPinningFindings(
    auditContext({
      workflowFiles: [
        workflowFile(`
steps:
  - uses: actions/checkout@v4
  - uses: actions/setup-node@v4
  - uses: actions/cache@v4
  - uses: docker/login-action@v3
  - uses: softprops/action-gh-release@v2
  - uses: actions/upload-artifact@v4
`)
      ]
    }),
    testFinding
  );

  assert.equal(findings.length, 5);
  assert.ok(findings.every((finding) => finding.title === 'Workflow action is not pinned to a commit SHA'));
});

test('mutableNullbuilderWorkflowRefFindings flags branch-like reusable workflow refs', () => {
  const findings = mutableNullbuilderWorkflowRefFindings(
    auditContext({
      workflowFiles: [
        workflowFile(`
jobs:
  ci:
    uses: nullclaw/nullbuilder/.github/workflows/zig-ci.yml@main
  release:
    uses: nullclaw/nullbuilder/.github/workflows/zig-release.yml@v1
`)
      ]
    }),
    testFinding
  );

  assert.deepEqual(
    findings.map((finding) => finding.detail),
    [
      '.github/workflows/ci.yml references zig-ci.yml@main; use a release tag for predictable cross-repository behavior.'
    ]
  );
});

test('mutableNullbuilderWorkflowRefFindings caps noisy mutable reusable workflow refs per file', () => {
  const content = Array.from(
    { length: 8 },
    (_, index) => `  workflow_${index}:\n    uses: nullclaw/nullbuilder/.github/workflows/zig-ci-${index}.yml@main`
  ).join('\n');

  const findings = mutableNullbuilderWorkflowRefFindings(
    auditContext({
      workflowFiles: [
        workflowFile(`
jobs:
${content}
`)
      ]
    }),
    testFinding
  );

  assert.equal(findings.length, 5);
  assert.deepEqual(
    findings.map((finding) => finding.detail),
    Array.from(
      { length: 5 },
      (_, index) =>
        `.github/workflows/ci.yml references zig-ci-${index}.yml@main; use a release tag for predictable cross-repository behavior.`
    )
  );
});

function auditContext(overrides: Partial<AuditContext> = {}): AuditContext {
  return {
    repo: 'nullclaw/nullbuilder' as RepoSlug,
    repository: {
      full_name: 'nullclaw/nullbuilder',
      html_url: 'https://github.example.test/nullclaw/nullbuilder',
      default_branch: 'main',
      private: false,
      archived: false
    },
    workflowDirectory: { status: 'present', data: [] },
    workflowFiles: [],
    branchProtection: { status: 'missing' },
    dependabot: { status: 'missing' },
    securityPolicy: { status: 'missing' },
    githubSecurityPolicy: { status: 'missing' },
    codeowners: { status: 'missing' },
    githubCodeowners: { status: 'missing' },
    ...overrides
  };
}

function workflowFile(content: string): WorkflowFile {
  return {
    name: 'ci.yml',
    path: '.github/workflows/ci.yml',
    url: 'https://github.example.test/nullclaw/nullbuilder/blob/main/.github/workflows/ci.yml',
    content
  };
}

const testFinding: AuditFindingBuilder = (
  severity: AuditSeverity,
  title: string,
  detail: string,
  url?: string,
  path?: string
): AuditFinding => ({
  id: `${severity}:${title}:${path ?? ''}`,
  ruleId: 'test',
  repo: 'nullclaw/nullbuilder' as RepoSlug,
  severity,
  area: 'workflow',
  title,
  detail,
  url,
  path
});
