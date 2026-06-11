import { strict as assert } from 'node:assert';
import { afterEach, test } from 'node:test';
import {
  DEFAULT_IGNORED_REPOSITORIES,
  DEFAULT_REPOSITORIES,
  findConfiguredRepoSlug,
  normalizeOwner,
  normalizeRepoSlug,
  parseRepositoryList,
  repoSlugParts
} from './repositories';

const originalArrayIterator = Array.prototype[Symbol.iterator];
const originalArrayJoin = Array.prototype.join;
const originalArrayPush = Array.prototype.push;

afterEach(() => {
  restoreArrayJoin();
  restoreArrayPush();
});

function restoreArrayJoin(): void {
  Object.defineProperty(Array.prototype, 'join', {
    configurable: true,
    writable: true,
    value: originalArrayJoin
  });
}

function restoreArrayPush(): void {
  Object.defineProperty(Array.prototype, 'push', {
    configurable: true,
    writable: true,
    value: originalArrayPush
  });
}

function withGuardedArrayJoin<T>(callback: () => T): { result: T; joinCalls: number } {
  let joinCalls = 0;
  Object.defineProperty(Array.prototype, 'join', {
    configurable: true,
    writable: true,
    value() {
      joinCalls += 1;
      throw new Error('Array.prototype.join should not be called');
    }
  });

  try {
    return {
      result: callback(),
      joinCalls
    };
  } finally {
    restoreArrayJoin();
  }
}

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
    restoreArrayPush();
  }
}

test('default repository lists cannot be mutated by callers', () => {
  assert.throws(() => {
    (DEFAULT_REPOSITORIES as unknown as string[]).push('unexpected');
  }, TypeError);

  assert.throws(() => {
    (DEFAULT_IGNORED_REPOSITORIES as unknown as string[])[0] = 'unexpected';
  }, TypeError);

  assert.equal(DEFAULT_REPOSITORIES[0], 'nullbuilder');
  assert.equal(DEFAULT_IGNORED_REPOSITORIES[0], 'sentry-zig');
});

test('normalizeOwner rejects invalid owners', () => {
  assert.equal(normalizeOwner('NullClaw'), 'NullClaw');
  assert.throws(() => normalizeOwner('-bad'), /^Error: Invalid repository owner\.$/);
  assert.throws(() => normalizeOwner('bad/owner'), /^Error: Invalid repository owner\.$/);
  assert.throws(
    () => normalizeOwner('a'.repeat(129)),
    (error: unknown) =>
      error instanceof Error &&
      error.message === 'Repository owner is too large.' &&
      !error.message.includes('aaaa')
  );
});

test('normalizeOwner rejects malformed runtime values without throwing type errors', () => {
  for (const value of [null, undefined, 17, true, { owner: 'nullclaw' }]) {
    assert.throws(
      () => normalizeOwner(value),
      (error: unknown) => error instanceof Error && error.message === 'Invalid repository owner.'
    );
  }
});

test('normalizeRepoSlug validates default owner for unqualified repositories', () => {
  assert.equal(normalizeRepoSlug('nullbuilder', 'nullclaw'), 'nullclaw/nullbuilder');
  assert.throws(() => normalizeRepoSlug('nullbuilder', 'bad_owner!'), /^Error: Invalid repository owner\.$/);
  assert.throws(
    () => normalizeRepoSlug('nullbuilder', 17),
    (error: unknown) => error instanceof Error && error.message === 'Invalid repository owner.'
  );
});

test('normalizeRepoSlug rejects unsafe repository name edges', () => {
  assert.throws(() => normalizeRepoSlug('.hidden', 'nullclaw'), /^Error: Invalid repository name\.$/);
  assert.throws(() => normalizeRepoSlug('trailing.', 'nullclaw'), /^Error: Invalid repository name\.$/);
  assert.throws(() => normalizeRepoSlug('-leading-dash', 'nullclaw'), /^Error: Invalid repository name\.$/);
  assert.throws(() => normalizeRepoSlug('double..dot', 'nullclaw'), /^Error: Invalid repository name\.$/);
  assert.throws(() => normalizeRepoSlug('nullbuilder.git', 'nullclaw'), /^Error: Invalid repository name\.$/);
});

test('normalizeRepoSlug rejects malformed runtime values without throwing type errors', () => {
  for (const value of [null, undefined, 17, true, { repo: 'nullbuilder' }]) {
    assert.throws(
      () => normalizeRepoSlug(value, 'nullclaw'),
      (error: unknown) => error instanceof Error && error.message === 'Invalid repository slug.'
    );
  }
});

test('parseRepositoryList deduplicates case-insensitively', () => {
  assert.deepEqual(parseRepositoryList('nullclaw/nullbuilder NullClaw/NullBuilder nullhub'), [
    'nullclaw/nullbuilder',
    'nullclaw/nullhub'
  ]);
});

test('repository list helpers avoid runtime iterators', () => {
  const generatorIteratorOwner = iteratorOwner(
    (function* generatorFixture() {
      yield 'value';
    })()
  );
  const originalGeneratorIteratorDescriptor = Object.getOwnPropertyDescriptor(generatorIteratorOwner, Symbol.iterator);
  const repos = parseRepositoryList('NullClaw/NullBuilder nullclaw/nullhub', 'nullclaw');

  Array.prototype[Symbol.iterator] = function arrayIteratorShouldNotBeCalled(): ArrayIterator<unknown> {
    throw new Error('Array.prototype iterator should not be called.');
  };
  Object.defineProperty(generatorIteratorOwner, Symbol.iterator, {
    configurable: true,
    value() {
      throw new Error('Generator iterator should not be called.');
    }
  });

  let parsed: ReturnType<typeof parseRepositoryList> = [];
  let configured: ReturnType<typeof findConfiguredRepoSlug> = null;
  try {
    parsed = parseRepositoryList('nullbuilder, nullhub nullbuilder', 'nullclaw');
    configured = findConfiguredRepoSlug(repos, 'NULLCLAW/NULLHUB', 'nullclaw');
  } finally {
    Array.prototype[Symbol.iterator] = originalArrayIterator;
    if (originalGeneratorIteratorDescriptor) {
      Object.defineProperty(generatorIteratorOwner, Symbol.iterator, originalGeneratorIteratorDescriptor);
    }
  }

  assert.deepEqual(parsed, ['nullclaw/nullbuilder', 'nullclaw/nullhub']);
  assert.equal(configured, 'nullclaw/nullhub');
});

test('parseRepositoryList collects repositories without global array push hooks', () => {
  const { result, pushCalls } = withGuardedArrayPush(() =>
    parseRepositoryList('nullbuilder, nullhub nullbuilder NullClaw/NULLHUB', 'nullclaw')
  );

  assert.equal(pushCalls, 0);
  assert.deepEqual(result, ['nullclaw/nullbuilder', 'nullclaw/nullhub']);
});

test('parseRepositoryList parses fallback repositories without array join hooks', () => {
  class CustomFallback extends Array<string> {
    override join(separator?: string): string {
      void separator;
      throw new Error('fallback join should not be called');
    }
  }

  const fallback = new CustomFallback('NullClaw/NullBuilder', 'nullhub nullwatch');
  const { result, joinCalls } = withGuardedArrayJoin(() => parseRepositoryList(' ', 'nullclaw', fallback));

  assert.equal(joinCalls, 0);
  assert.deepEqual(result, ['NullClaw/NullBuilder', 'nullclaw/nullhub', 'nullclaw/nullwatch']);
});

test('findConfiguredRepoSlug normalizes candidates against configured repositories', () => {
  const repos = parseRepositoryList('NullClaw/NullBuilder nullclaw/nullhub', 'nullclaw');

  assert.equal(findConfiguredRepoSlug(repos, 'nullbuilder', 'nullclaw'), 'NullClaw/NullBuilder');
  assert.equal(findConfiguredRepoSlug(repos, 'NULLCLAW/NULLHUB', 'nullclaw'), 'nullclaw/nullhub');
  assert.equal(findConfiguredRepoSlug(repos, 'unconfigured', 'nullclaw'), null);
  assert.equal(findConfiguredRepoSlug(repos, 'bad\nrepo', 'nullclaw'), null);
  assert.equal(findConfiguredRepoSlug(repos, 42, 'nullclaw'), null);
});

test('repoSlugParts extracts owner and name from normalized repository slugs', () => {
  assert.deepEqual(repoSlugParts(normalizeRepoSlug('NullClaw/NullBuilder')), {
    owner: 'NullClaw',
    name: 'NullBuilder'
  });
});

test('repoSlugParts rejects impossible malformed slugs without echoing input', () => {
  for (const repo of ['missing-slash', '/missing-owner', 'missing-name/', 'too/many/parts']) {
    assert.throws(
      () => repoSlugParts(repo as `${string}/${string}`),
      (error: unknown) =>
        error instanceof Error && error.message === 'Invalid repository slug.' && !error.message.includes(repo)
    );
  }
});

test('parseRepositoryList bounds configured repository input', () => {
  const tooManyRepos = Array.from({ length: 1001 }, (_, index) => `repo${index}`).join(',');
  assert.throws(
    () => parseRepositoryList(tooManyRepos, 'nullclaw'),
    (error: unknown) => error instanceof Error && error.message === 'Too many repositories configured.'
  );

  const oversizedList = 'a'.repeat(256 * 1024 + 1);
  assert.throws(
    () => parseRepositoryList(oversizedList, 'nullclaw'),
    (error: unknown) =>
      error instanceof Error &&
      error.message === 'Repository list is too large.' &&
      !error.message.includes(oversizedList.slice(0, 32))
  );

  const oversizedWhitespaceList = ' '.repeat(256 * 1024 + 1);
  assert.throws(
    () => parseRepositoryList(oversizedWhitespaceList, 'nullclaw'),
    (error: unknown) =>
      error instanceof Error &&
      error.message === 'Repository list is too large.' &&
      !error.message.includes(oversizedWhitespaceList.slice(0, 32))
  );

  const oversizedSlug = 'a'.repeat(513);
  assert.throws(
    () => normalizeRepoSlug(oversizedSlug, 'nullclaw'),
    (error: unknown) =>
      error instanceof Error &&
      error.message === 'Repository slug is too large.' &&
      !error.message.includes(oversizedSlug.slice(0, 32))
  );

  const oversizedFallback = ['a'.repeat(256 * 1024 + 1)];
  assert.throws(
    () => parseRepositoryList(undefined, 'nullclaw', oversizedFallback),
    (error: unknown) =>
      error instanceof Error &&
      error.message === 'Repository list is too large.' &&
      !error.message.includes(oversizedFallback[0].slice(0, 32))
  );
});

test('parseRepositoryList rejects malformed runtime values without throwing type errors', () => {
  for (const value of [null, 17, true, { repositories: 'nullbuilder' }]) {
    assert.throws(
      () => parseRepositoryList(value, 'nullclaw'),
      (error: unknown) => error instanceof Error && error.message === 'Invalid repository list.'
    );
  }
});

test('parseRepositoryList rejects hostile fallback values without leaking details', () => {
  const arrayLike = { 0: 'nullbuilder', length: 1 } as unknown as string[];
  const hostileLength = new Proxy(['nullbuilder'], {
    get(target, property, receiver) {
      if (property === 'length') {
        throw new Error('private length detail');
      }
      return Reflect.get(target, property, receiver);
    }
  });
  const hostileEntry = new Proxy(['nullbuilder', 'nullhub'], {
    get(target, property, receiver) {
      if (property === '1') {
        throw new Error('private entry detail');
      }
      return Reflect.get(target, property, receiver);
    }
  });

  for (const fallback of [arrayLike, hostileLength, hostileEntry]) {
    assert.throws(
      () => parseRepositoryList(undefined, 'nullclaw', fallback),
      (error: unknown) =>
        error instanceof Error &&
        error.message === 'Invalid repository list.' &&
        !error.message.includes('private')
    );
  }
});

test('repository validators do not echo unsafe input in errors', () => {
  assert.throws(
    () => normalizeOwner('bad\nowner'),
    (error: unknown) => error instanceof Error && error.message === 'Invalid repository owner.'
  );
  assert.throws(
    () => normalizeRepoSlug('nullclaw/bad\x1b[31mrepo'),
    (error: unknown) => error instanceof Error && error.message === 'Invalid repository name.'
  );
  assert.throws(
    () => normalizeRepoSlug('nullclaw/nullbuilder/extra'),
    (error: unknown) => error instanceof Error && error.message === 'Invalid repository slug.'
  );
});

function iteratorOwner(value: object): { [Symbol.iterator]: () => Iterator<unknown> } {
  let prototype = Object.getPrototypeOf(value) as object | null;
  while (prototype) {
    const descriptor = Object.getOwnPropertyDescriptor(prototype, Symbol.iterator);
    if (descriptor?.value) {
      return prototype as { [Symbol.iterator]: () => Iterator<unknown> };
    }
    prototype = Object.getPrototypeOf(prototype) as object | null;
  }

  throw new Error('Iterator prototype not found.');
}
