import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import type { RepoSlug } from '../repositories';
import type { AuditCheckResult } from './audit-types';
import {
  evaluateAuditChecks,
  type AuditContext,
  type GitHubContentFile,
  type GitHubContentItem,
  type GitHubBranchProtection,
  type Probe
} from './audit-rules';

const originalArrayIterator = Array.prototype[Symbol.iterator];

test('evaluateAuditChecks reports missing repository security controls', () => {
  const checks = evaluateAuditChecks(
    auditContext({
      repository: repository({ archived: true }),
      workflowDirectory: { status: 'missing' },
      branchProtection: { status: 'missing' },
      dependabot: { status: 'missing' },
      securityPolicy: { status: 'missing' },
      githubSecurityPolicy: { status: 'missing' },
      codeowners: { status: 'missing' },
      githubCodeowners: { status: 'missing' }
    })
  );

  assert.deepEqual(
    checks.map(({ id }) => id),
    [
      'repository-active',
      'security-policy',
      'dependabot',
      'codeowners',
      'branch-protection',
      'nullbuilder-workflows',
      'workflow-dangerous-triggers',
      'workflow-permissions',
      'workflow-pinning',
      'nullbuilder-workflow-ref'
    ]
  );
  assert.equal(check(checks, 'repository-active').status, 'warning');
  assert.equal(check(checks, 'security-policy').status, 'warning');
  assert.equal(check(checks, 'dependabot').status, 'warning');
  assert.equal(check(checks, 'codeowners').status, 'info');
  assert.equal(check(checks, 'branch-protection').status, 'warning');
  assert.equal(check(checks, 'nullbuilder-workflows').status, 'warning');
});

test('evaluateAuditChecks flags risky workflow triggers permissions and refs', () => {
  const checks = evaluateAuditChecks(
    auditContext({
      workflowDirectory: present<GitHubContentItem[]>([
        {
          name: 'ci.yml',
          path: '.github/workflows/ci.yml',
          type: 'file',
          html_url: 'https://github.example.test/nullclaw/nullbuilder/blob/main/.github/workflows/ci.yml'
        }
      ]),
      workflowFiles: [
        {
          name: 'ci.yml',
          path: '.github/workflows/ci.yml',
          url: 'https://github.example.test/nullclaw/nullbuilder/blob/main/.github/workflows/ci.yml',
          content: `
on: pull_request_target
permissions: write-all
jobs:
  ci:
    uses: nullclaw/nullbuilder/.github/workflows/zig-ci.yml@main
  nightly:
    uses: nullclaw/nullbuilder/.github/workflows/zig-nightly.yml@v1
  release:
    uses: nullclaw/nullbuilder/.github/workflows/zig-release.yml@v1
  test:
    runs-on: self-hosted
    steps:
      - uses: actions/checkout@v4
`
        }
      ]
    })
  );

  assert.equal(check(checks, 'nullbuilder-workflows').status, 'ok');
  assert.equal(check(checks, 'workflow-dangerous-triggers').status, 'critical');
  assert.equal(check(checks, 'workflow-permissions').status, 'critical');
  assert.equal(check(checks, 'workflow-pinning').status, 'warning');
  assert.equal(check(checks, 'nullbuilder-workflow-ref').status, 'warning');

  const findingTitles = checks.flatMap((item) => item.findings.map((finding) => finding.title));
  assert.ok(findingTitles.includes('Workflow uses pull_request_target'));
  assert.ok(findingTitles.includes('Workflow grants write-all permissions'));
  assert.ok(findingTitles.includes('Workflow action is not pinned to a commit SHA'));
  assert.ok(findingTitles.includes('Reusable workflow uses a mutable ref'));
});

test('evaluateAuditChecks avoids array iterators while scanning static rules', () => {
  const checks = withGuardedArrayIterator(() => evaluateAuditChecks(auditContext()));

  assert.deepEqual(
    checks.map(({ id }) => id),
    [
      'repository-active',
      'security-policy',
      'dependabot',
      'codeowners',
      'branch-protection',
      'nullbuilder-workflows',
      'workflow-dangerous-triggers',
      'workflow-permissions',
      'workflow-pinning',
      'nullbuilder-workflow-ref'
    ]
  );
});

function auditContext(overrides: Partial<AuditContext> = {}): AuditContext {
  return {
    repo: 'nullclaw/nullbuilder' as RepoSlug,
    repository: repository(),
    workflowDirectory: present<GitHubContentItem[]>([]),
    workflowFiles: [],
    branchProtection: present<GitHubBranchProtection>({
      required_status_checks: {},
      required_pull_request_reviews: {}
    }),
    dependabot: present(file('.github/dependabot.yml')),
    securityPolicy: present(file('SECURITY.md')),
    githubSecurityPolicy: { status: 'missing' },
    codeowners: present(file('CODEOWNERS')),
    githubCodeowners: { status: 'missing' },
    ...overrides
  };
}

function repository(overrides: Partial<AuditContext['repository']> = {}): AuditContext['repository'] {
  return {
    full_name: 'nullclaw/nullbuilder',
    html_url: 'https://github.example.test/nullclaw/nullbuilder',
    default_branch: 'main',
    private: false,
    archived: false,
    ...overrides
  };
}

function file(path: string): GitHubContentFile {
  return {
    name: path.split('/').at(-1) ?? path,
    path,
    type: 'file',
    html_url: `https://github.example.test/nullclaw/nullbuilder/blob/main/${path}`,
    encoding: 'base64',
    content: ''
  };
}

function present<T>(data: T): Probe<T> {
  return { status: 'present', data };
}

function check(checks: readonly AuditCheckResult[], id: string): AuditCheckResult {
  const result = checks.find((item) => item.id === id);
  assert.ok(result, `expected audit check ${id}`);
  return result;
}

function withGuardedArrayIterator<T>(callback: () => T): T {
  Array.prototype[Symbol.iterator] = function arrayIteratorShouldNotBeCalled(): ArrayIterator<unknown> {
    throw new Error('Array.prototype[Symbol.iterator] should not be called');
  };

  try {
    return callback();
  } finally {
    Array.prototype[Symbol.iterator] = originalArrayIterator;
  }
}
