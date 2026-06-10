import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  decodeGitHubContent,
  findActionUses,
  findNullbuilderWorkflowRefs,
  isMutableRef,
  MAX_WORKFLOW_REFERENCE_MATCHES,
  MAX_WORKFLOW_REFERENCE_TOKEN_LENGTH,
  shouldRequireShaPin
} from './audit-workflows';

test('findActionUses parses bare and quoted action references', () => {
  const uses = findActionUses(`
steps:
  - uses: actions/checkout@v4
  - uses: "docker/login-action@v3"
  - uses: './.github/actions/local@ignored'
`);

  assert.deepEqual(uses, [
    { target: 'actions/checkout', ref: 'v4' },
    { target: 'docker/login-action', ref: 'v3' },
    { target: './.github/actions/local', ref: 'ignored' }
  ]);
});

test('findNullbuilderWorkflowRefs parses reusable workflow refs', () => {
  assert.deepEqual(
    findNullbuilderWorkflowRefs(`
jobs:
  ci:
    uses: 'nullclaw/nullbuilder/.github/workflows/zig-ci.yml@main'
`),
    [{ workflow: 'zig-ci.yml', ref: 'main' }]
  );
});

test('workflow reference parsers bound noisy workflow files', () => {
  const actionContent = Array.from(
    { length: MAX_WORKFLOW_REFERENCE_MATCHES + 20 },
    (_, index) => `  - uses: owner/action-${index}@v1`
  ).join('\n');
  const actions = findActionUses(actionContent);

  assert.equal(actions.length, MAX_WORKFLOW_REFERENCE_MATCHES);
  assert.deepEqual(actions[actions.length - 1], {
    target: `owner/action-${MAX_WORKFLOW_REFERENCE_MATCHES - 1}`,
    ref: 'v1'
  });

  const workflowContent = Array.from(
    { length: MAX_WORKFLOW_REFERENCE_MATCHES + 20 },
    (_, index) => `  uses: nullclaw/nullbuilder/.github/workflows/zig-ci-${index}.yml@main`
  ).join('\n');
  const references = findNullbuilderWorkflowRefs(workflowContent);

  assert.equal(references.length, MAX_WORKFLOW_REFERENCE_MATCHES);
  assert.deepEqual(references[references.length - 1], {
    workflow: `zig-ci-${MAX_WORKFLOW_REFERENCE_MATCHES - 1}.yml`,
    ref: 'main'
  });
});

test('workflow reference parsers sanitize captured tokens before findings', () => {
  const longTarget = `owner/${'a'.repeat(MAX_WORKFLOW_REFERENCE_TOKEN_LENGTH + 20)}`;
  const longRef = 'v'.repeat(MAX_WORKFLOW_REFERENCE_TOKEN_LENGTH + 20);
  const actions = findActionUses(`
steps:
  - uses: ${longTarget}@${longRef}
  - uses: owner/control@main\x1b[31m
`);

  assert.equal(actions[0].target.length, MAX_WORKFLOW_REFERENCE_TOKEN_LENGTH);
  assert.equal(actions[0].ref.length, MAX_WORKFLOW_REFERENCE_TOKEN_LENGTH);
  assert.deepEqual(actions[1], { target: 'owner/control', ref: 'main' });

  const longWorkflow = `${'zig-ci'.repeat(40)}.yml`;
  const references = findNullbuilderWorkflowRefs(`
jobs:
  long:
    uses: nullclaw/nullbuilder/.github/workflows/${longWorkflow}@${longRef}
  control:
    uses: nullclaw/nullbuilder/.github/workflows/zig-release.yml@refs/heads/main\x1b[31m
`);

  assert.equal(references[0].workflow.length, MAX_WORKFLOW_REFERENCE_TOKEN_LENGTH);
  assert.equal(references[0].ref.length, MAX_WORKFLOW_REFERENCE_TOKEN_LENGTH);
  assert.deepEqual(references[1], { workflow: 'zig-release.yml', ref: 'refs/heads/main' });
});

test('shouldRequireShaPin ignores local docker and nullbuilder workflow references', () => {
  assert.equal(shouldRequireShaPin('./.github/actions/setup', 'v1'), false);
  assert.equal(shouldRequireShaPin('docker://alpine', '3.20'), false);
  assert.equal(shouldRequireShaPin('nullclaw/nullbuilder/.github/workflows/zig-ci.yml', 'main'), false);
  assert.equal(shouldRequireShaPin('actions/checkout', 'v4'), true);
  assert.equal(shouldRequireShaPin('actions/checkout', 'de0fac2e4500dabe0009e67214ff5f5447ce83dd'), false);
});

test('isMutableRef detects branch-like refs', () => {
  assert.equal(isMutableRef('main'), true);
  assert.equal(isMutableRef('master'), true);
  assert.equal(isMutableRef('refs/heads/release'), true);
  assert.equal(isMutableRef('v1'), false);
});

test('decodeGitHubContent decodes and bounds base64 content', () => {
  const encoded = Buffer.from('abcdef', 'utf8').toString('base64');

  assert.equal(decodeGitHubContent({ encoding: 'base64', content: encoded }, 3), 'abc');
  assert.equal(decodeGitHubContent({ encoding: 'utf8', content: encoded }), '');
});

test('decodeGitHubContent limits base64 before decoding', () => {
  const encoded = Buffer.from('abcdef', 'utf8').toString('base64');
  const wrapped = `${encoded.slice(0, 4)}\r\n${encoded.slice(4)}`;

  assert.equal(decodeGitHubContent({ encoding: 'base64', content: wrapped }, 4), 'abcd');
  assert.equal(decodeGitHubContent({ encoding: 'base64', content: encoded }, -1), '');
});

test('decodeGitHubContent strips wrapped base64 while applying the byte limit early', () => {
  const content = 'abcdefghijklmnopqrstuvwxyz';
  const encoded = Buffer.from(content, 'utf8').toString('base64');
  const wrapped = encoded.match(/.{1,2}/g)?.join('\r\n') ?? encoded;

  assert.equal(decodeGitHubContent({ encoding: 'base64', content: wrapped }, 9), content.slice(0, 9));
});

test('decodeGitHubContent rejects malformed base64 before audit parsing', () => {
  assert.equal(decodeGitHubContent({ encoding: 'base64', content: 'YWJj$GVm' }), '');
  assert.equal(decodeGitHubContent({ encoding: 'base64', content: 'YWJj=' }), '');
});

test('decodeGitHubContent rejects malformed UTF-8 workflow content', () => {
  assert.equal(decodeGitHubContent({ encoding: 'base64', content: Buffer.from([0xc0, 0x80]).toString('base64') }), '');
});
