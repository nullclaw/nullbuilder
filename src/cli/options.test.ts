import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { parseCommandLine, parseOptions } from './options';

test('parseCommandLine treats empty and explicit help as help', () => {
  assert.deepEqual(parseCommandLine([]), { kind: 'help' });
  assert.deepEqual(parseCommandLine(['--help']), { kind: 'help' });
  assert.deepEqual(parseCommandLine(['-h']), { kind: 'help' });
  assert.deepEqual(parseCommandLine(['help']), { kind: 'help' });
});

test('parseCommandLine parses known commands through the command guard', () => {
  assert.deepEqual(parseCommandLine(['repos', '--json']), {
    kind: 'command',
    command: 'repos',
    options: {
      json: true,
      discover: false,
      confirm: false,
      force: false,
      allowDraft: false,
      allowFork: false,
      allowNonDefaultBase: false,
      positionals: []
    }
  });
});

test('parseCommandLine rejects unknown commands', () => {
  assert.throws(() => parseCommandLine(['unknown']), /^Error: Unknown command\.$/);
  assert.throws(() => parseCommandLine(['bad\x1b[31m\ncommand']), (error) => {
    assert(error instanceof Error);
    assert.equal(error.message, 'Unknown command.');
    assert.doesNotMatch(error.message, /\x1b|\n|bad/);
    return true;
  });
});

test('parseOptions rejects unknown options without echoing raw input', () => {
  assert.throws(() => parseOptions(['--unknown']), /^Error: Unknown option\.$/);
  assert.throws(() => parseOptions(['--bad\x1b[31m\noption']), (error) => {
    assert(error instanceof Error);
    assert.equal(error.message, 'Unknown option.');
    assert.doesNotMatch(error.message, /\x1b|\n|bad/);
    return true;
  });
});

test('parseOptions parses build tag flags', () => {
  assert.deepEqual(parseOptions(['repo-name', '--pr', '17', '--tag', 'build-pr-17', '--confirm', '--force']), {
    json: false,
    discover: false,
    pr: 17,
    tag: 'build-pr-17',
    confirm: true,
    force: true,
    allowDraft: false,
    allowFork: false,
    allowNonDefaultBase: false,
    positionals: ['repo-name']
  });
});

test('parseOptions rejects partial numeric PR values', () => {
  assert.throws(() => parseOptions(['--pr', '17abc']), /--pr must be a positive number/);
  assert.throws(() => parseOptions(['--pr', '0']), /--pr must be a positive number/);
  assert.throws(() => parseOptions(['--pr', '1'.repeat(100_000)]), /--pr must be a positive number/);
});

test('parseOptions stops option parsing after delimiter', () => {
  const options = parseOptions(['--repo', 'nullbuilder', '--', '--literal']);

  assert.equal(options.repo, 'nullbuilder');
  assert.deepEqual(options.positionals, ['--literal']);
});
