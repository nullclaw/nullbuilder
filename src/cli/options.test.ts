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

test('parseCommandLine avoids user-controlled argv array methods', () => {
  const argv = ['repos', '--', '--literal'];
  Object.defineProperty(argv, 'slice', {
    value() {
      throw new Error('slice should not be called');
    }
  });
  Object.defineProperty(argv, 'every', {
    value() {
      throw new Error('every should not be called');
    }
  });

  assert.deepEqual(parseCommandLine(argv), {
    kind: 'command',
    command: 'repos',
    options: {
      json: false,
      discover: false,
      confirm: false,
      force: false,
      allowDraft: false,
      allowFork: false,
      allowNonDefaultBase: false,
      positionals: ['--literal']
    }
  });
});

test('parseCommandLine and parseOptions avoid global array push hooks', () => {
  const originalPush = Array.prototype.push;
  let pushCalls = 0;
  let parsedCommand: ReturnType<typeof parseCommandLine> | undefined;
  let parsedOptions: ReturnType<typeof parseOptions> | undefined;

  Object.defineProperty(Array.prototype, 'push', {
    configurable: true,
    writable: true,
    value() {
      pushCalls += 1;
      throw new Error('push should not be called');
    }
  });

  try {
    parsedCommand = parseCommandLine(['repos', '--', '--literal']);
    parsedOptions = parseOptions(['repo-name', '--', '--literal']);
  } finally {
    Object.defineProperty(Array.prototype, 'push', {
      configurable: true,
      writable: true,
      value: originalPush
    });
  }

  assert.equal(pushCalls, 0);
  assert.deepEqual(parsedCommand, {
    kind: 'command',
    command: 'repos',
    options: {
      json: false,
      discover: false,
      confirm: false,
      force: false,
      allowDraft: false,
      allowFork: false,
      allowNonDefaultBase: false,
      positionals: ['--literal']
    }
  });
  assert.deepEqual(parsedOptions, {
    json: false,
    discover: false,
    confirm: false,
    force: false,
    allowDraft: false,
    allowFork: false,
    allowNonDefaultBase: false,
    positionals: ['repo-name', '--literal']
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

test('parseCommandLine bounds argument vectors before parsing', () => {
  const oversized = ['repos', ...Array.from({ length: 128 }, (_, index) => `repo-${index}`)];

  assert.throws(() => parseCommandLine(oversized), (error) => {
    assert(error instanceof Error);
    assert.equal(error.message, 'Too many CLI arguments.');
    assert.doesNotMatch(error.message, /repo-127/);
    return true;
  });
});

test('parseCommandLine rejects malformed runtime argument vectors', () => {
  assert.throws(() => parseCommandLine([null] as unknown as string[]), (error) => {
    assert(error instanceof Error);
    assert.equal(error.message, 'Invalid CLI argument.');
    return true;
  });

  assert.throws(() => parseCommandLine(['']), (error) => {
    assert(error instanceof Error);
    assert.equal(error.message, 'Invalid CLI argument.');
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

test('parseOptions bounds option vectors before scanning values', () => {
  const oversized = Array.from({ length: 129 }, (_, index) => `repo-${index}`);

  assert.throws(() => parseOptions(oversized), (error) => {
    assert(error instanceof Error);
    assert.equal(error.message, 'Too many CLI arguments.');
    assert.doesNotMatch(error.message, /repo-128/);
    return true;
  });
});

test('parseOptions rejects malformed runtime option vectors before scanning', () => {
  assert.throws(() => parseOptions(['--repo', { value: 'nullbuilder' }] as unknown as string[]), (error) => {
    assert(error instanceof Error);
    assert.equal(error.message, 'Invalid CLI argument.');
    assert.doesNotMatch(error.message, /nullbuilder/);
    return true;
  });
});

test('parseOptions rejects duplicate options without overwriting earlier values', () => {
  assert.throws(() => parseOptions(['--repo', 'nullbuilder', '--repo', 'other']), (error) => {
    assert(error instanceof Error);
    assert.equal(error.message, 'Duplicate option.');
    assert.doesNotMatch(error.message, /nullbuilder|other/);
    return true;
  });

  assert.throws(() => parseOptions(['--json', '--json']), /^Error: Duplicate option\.$/);
  assert.throws(() => parseOptions(['--force', '--force']), /^Error: Duplicate option\.$/);
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

test('parseOptions rejects unsafe text option values without echoing raw input', () => {
  assert.throws(() => parseOptions(['--repo', 'x'.repeat(10_000)]), (error) => {
    assert(error instanceof Error);
    assert.equal(error.message, '--repo has invalid value.');
    assert.doesNotMatch(error.message, /xxxxx/);
    return true;
  });

  assert.throws(() => parseOptions(['--tag', 'build-pr\x1b[31m\nsecret']), (error) => {
    assert(error instanceof Error);
    assert.equal(error.message, '--tag has invalid value.');
    assert.doesNotMatch(error.message, /\x1b|\n|secret/);
    return true;
  });

  assert.throws(() => parseOptions(['--ref', 'release/v1\x85hidden']), (error) => {
    assert(error instanceof Error);
    assert.equal(error.message, '--ref has invalid value.');
    assert.doesNotMatch(error.message, /\x85|hidden/);
    return true;
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

test('parseOptions validates positional arguments without echoing raw input', () => {
  assert.throws(() => parseOptions(['']), /^Error: Invalid positional argument\.$/);
  assert.throws(() => parseOptions(['--', '']), /^Error: Invalid positional argument\.$/);

  assert.throws(() => parseOptions(['bad\x1b[31m\nrepo']), (error) => {
    assert(error instanceof Error);
    assert.equal(error.message, 'Invalid positional argument.');
    assert.doesNotMatch(error.message, /\x1b|\n|bad/);
    return true;
  });

  assert.throws(() => parseOptions(['--', 'x'.repeat(10_000)]), (error) => {
    assert(error instanceof Error);
    assert.equal(error.message, 'Invalid positional argument.');
    assert.doesNotMatch(error.message, /xxxxx/);
    return true;
  });

  assert.throws(() => parseOptions(Array.from({ length: 17 }, (_, index) => `repo-${index}`)), (error) => {
    assert(error instanceof Error);
    assert.equal(error.message, 'Too many positional arguments.');
    assert.doesNotMatch(error.message, /repo-16/);
    return true;
  });
});
