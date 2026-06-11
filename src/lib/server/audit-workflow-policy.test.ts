import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import type { RepoSlug } from '../repositories';
import type { AuditFinding, AuditSeverity } from './audit-types';
import type { AuditContext, AuditFindingBuilder, WorkflowFile } from './audit-rule-kit';
import {
  dangerousWorkflowTriggerFindings,
  MAX_WORKFLOW_POLICY_FILES,
  mutableNullbuilderWorkflowRefFindings,
  nullbuilderWorkflowFindings,
  nullbuilderWorkflowPolicyEntries,
  workflowPermissionFindings,
  workflowPinningFindings
} from './audit-workflow-policy';

const originalArrayIterator = Array.prototype[Symbol.iterator];
const originalArrayPush = Array.prototype.push;

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

test('nullbuilderWorkflowFindings ignores commented reusable workflow examples', () => {
  const findings = nullbuilderWorkflowFindings(
    auditContext({
      workflowFiles: [
        workflowFile(`
# uses: nullclaw/nullbuilder/.github/workflows/zig-ci.yml@v1
description: nullclaw/nullbuilder/.github/workflows/zig-nightly.yml@v1
jobs:
  docs:
    runs-on: ubuntu-latest
`)
      ]
    }),
    testFinding
  );

  assert.deepEqual(
    findings.map((finding) => finding.title),
    [
      'Missing nullbuilder ci workflow',
      'Missing nullbuilder nightly workflow',
      'Missing nullbuilder release workflow'
    ]
  );
});

test('nullbuilder workflow policy cannot be mutated by callers', () => {
  const entries = nullbuilderWorkflowPolicyEntries();

  assert.throws(() => {
    (entries as unknown as Array<{ id: string; file: string; severity: AuditSeverity }>).push({
      id: 'unsafe',
      file: 'unsafe.yml',
      severity: 'critical'
    });
  }, TypeError);

  assert.throws(() => {
    (entries[0] as { id: string; file: string; severity: AuditSeverity }).file = 'unsafe.yml';
  }, TypeError);

  const findings = nullbuilderWorkflowFindings(auditContext(), testFinding);

  assert.deepEqual(
    findings.map((finding) => finding.title),
    [
      'Missing nullbuilder ci workflow',
      'Missing nullbuilder nightly workflow',
      'Missing nullbuilder release workflow'
    ]
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

test('workflow policy helpers cap workflow file scanning', () => {
  const workflowFiles = Array.from({ length: MAX_WORKFLOW_POLICY_FILES + 1 }, (_, index) =>
    workflowFile(`
permissions: read-all
jobs:
  test_${index}:
    runs-on: ubuntu-latest
`)
  );
  Object.defineProperty(workflowFiles, MAX_WORKFLOW_POLICY_FILES, {
    get() {
      throw new Error('read past workflow policy file cap');
    }
  });
  const context = auditContext({ workflowFiles });

  assert.equal(workflowPermissionFindings(context, testFinding).length, 0);
  assert.equal(dangerousWorkflowTriggerFindings(context, testFinding).length, 0);
  assert.equal(workflowPinningFindings(context, testFinding).length, 0);
  assert.equal(mutableNullbuilderWorkflowRefFindings(context, testFinding).length, 0);
  assert.deepEqual(
    nullbuilderWorkflowFindings(context, testFinding).map((finding) => finding.title),
    [
      'Missing nullbuilder ci workflow',
      'Missing nullbuilder nightly workflow',
      'Missing nullbuilder release workflow'
    ]
  );
});

test('workflow policy helpers avoid array iterators', () => {
  const context = auditContext({
    workflowFiles: [
      workflowFile(`
permissions: read-all
jobs:
  ci:
    uses: nullclaw/nullbuilder/.github/workflows/zig-ci.yml@main
  test:
    steps:
      - uses: actions/setup-node@v4
`)
    ]
  });

  Array.prototype[Symbol.iterator] = function arrayIteratorShouldNotBeCalled(): ArrayIterator<unknown> {
    throw new Error('Array.prototype iterator should not be called.');
  };

  let missing: AuditFinding[] = [];
  let pinning: AuditFinding[] = [];
  let mutable: AuditFinding[] = [];
  try {
    missing = nullbuilderWorkflowFindings(context, testFinding);
    pinning = workflowPinningFindings(context, testFinding);
    mutable = mutableNullbuilderWorkflowRefFindings(context, testFinding);
  } finally {
    Array.prototype[Symbol.iterator] = originalArrayIterator;
  }

  assert.deepEqual(
    missing.map((finding) => finding.title),
    ['Missing nullbuilder nightly workflow', 'Missing nullbuilder release workflow']
  );
  assert.deepEqual(
    pinning.map((finding) => finding.detail),
    [
      '.github/workflows/ci.yml uses actions/setup-node@v4; pin third-party actions to immutable commits for stronger supply-chain guarantees.'
    ]
  );
  assert.deepEqual(
    mutable.map((finding) => finding.detail),
    [
      '.github/workflows/ci.yml references zig-ci.yml@main; use a release tag for predictable cross-repository behavior.'
    ]
  );
});

test('workflow policy helpers collect findings without global array push hooks', () => {
  const context = auditContext({
    workflowFiles: [
      workflowFile(`
on: pull_request_target
permissions: write-all
jobs:
  ci:
    runs-on: self-hosted
    steps:
      - uses: actions/setup-node@v4
  release:
    uses: nullclaw/nullbuilder/.github/workflows/zig-release.yml@main
`)
    ]
  });

  const {
    result: { missing, dangerous, permissions, pinning, mutable },
    pushCalls
  } = withGuardedArrayPush(() => ({
    missing: nullbuilderWorkflowFindings(context, testFinding),
    dangerous: dangerousWorkflowTriggerFindings(context, testFinding),
    permissions: workflowPermissionFindings(context, testFinding),
    pinning: workflowPinningFindings(context, testFinding),
    mutable: mutableNullbuilderWorkflowRefFindings(context, testFinding)
  }));

  assert.equal(pushCalls, 0);
  assert.deepEqual(
    missing.map((finding) => finding.title),
    ['Missing nullbuilder ci workflow', 'Missing nullbuilder nightly workflow']
  );
  assert.deepEqual(dangerous.map((finding) => finding.title), ['Workflow uses pull_request_target']);
  assert.deepEqual(
    permissions.map((finding) => finding.title),
    ['Workflow grants write-all permissions', 'Workflow uses self-hosted runners']
  );
  assert.deepEqual(pinning.map((finding) => finding.title), ['Workflow action is not pinned to a commit SHA']);
  assert.deepEqual(mutable.map((finding) => finding.title), ['Reusable workflow uses a mutable ref']);
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

function withGuardedArrayPush<T>(callback: () => T): { result: T; pushCalls: number } {
  let pushCalls = 0;
  Object.defineProperty(Array.prototype, 'push', {
    configurable: true,
    writable: true,
    value() {
      pushCalls += 1;
      throw new Error('Array.prototype.push should not be called');
    }
  });

  try {
    return {
      result: callback(),
      pushCalls
    };
  } finally {
    Object.defineProperty(Array.prototype, 'push', {
      configurable: true,
      writable: true,
      value: originalArrayPush
    });
  }
}
