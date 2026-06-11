import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  DASHBOARD_SECTIONS,
  MAX_VISIBLE_AUDIT_FINDINGS,
  auditFindingHref,
  auditRepositoryHref,
  authGateCopy,
  authStateLabel,
  buildAuditRepositoryUrls,
  buildPrResultMessage,
  dashboardOwner,
  dashboardExternalHref,
  hasDashboardReadErrors,
  releaseResultMessage,
  visibleAuditFindings
} from './dashboard-view';

const originalArrayPush = Array.prototype.push;
const originalArrayIsArray = Array.isArray;
const originalMathMin = Math.min;
const originalNumber = Number;

test('dashboardOwner falls back to the default owner', () => {
  assert.equal(dashboardOwner({ owner: 'octo' }), 'octo');
  assert.equal(dashboardOwner(null), 'nullclaw');
});

test('authGateCopy keeps authentication panel copy centralized', () => {
  assert.deepEqual(authGateCopy(true), {
    title: 'Authentication Required',
    description: 'Enter the configured web token to unlock the dashboard.'
  });
  assert.deepEqual(authGateCopy(false), {
    title: 'Web Token Required',
    description: 'Set NULLBUILDER_WEB_TOKEN before exposing token-backed dashboard data.'
  });
});

test('authStateLabel keeps token state display logic explicit', () => {
  assert.equal(authStateLabel(true, true), 'Authenticated');
  assert.equal(authStateLabel(false, true), 'Locked token');
  assert.equal(authStateLabel(false, false), 'Anonymous API');
});

test('hasDashboardReadErrors includes repository and audit failures', () => {
  assert.equal(hasDashboardReadErrors([{ error: 'failed' }], null), true);
  assert.equal(hasDashboardReadErrors([], { hasReadErrors: true }), true);
  assert.equal(hasDashboardReadErrors([{ error: '' }], { hasReadErrors: false }), false);
});

test('visibleAuditFindings bounds and validates the display limit', () => {
  assert.deepEqual(visibleAuditFindings([1, 2, 3], 2), [1, 2]);
  assert.deepEqual(visibleAuditFindings([1, 2, 3], 0), []);
  assert.deepEqual(visibleAuditFindings([1, 2, 3], Number.NaN), []);
});

test('visibleAuditFindings caps oversized limits before slicing', () => {
  const findings = Array.from({ length: MAX_VISIBLE_AUDIT_FINDINGS + 1 }, (_, index) => index);
  Object.defineProperty(findings, MAX_VISIBLE_AUDIT_FINDINGS, {
    get() {
      throw new Error('read past visible findings cap');
    }
  });

  const visible = visibleAuditFindings(findings, Number.MAX_SAFE_INTEGER);

  assert.equal(visible.length, MAX_VISIBLE_AUDIT_FINDINGS);
  assert.deepEqual(visible, Array.from({ length: MAX_VISIBLE_AUDIT_FINDINGS }, (_, index) => index));
});

test('visibleAuditFindings avoids user-controlled array slice methods', () => {
  class UnsafeSliceArray<T> extends Array<T> {
    override slice(): T[] {
      throw new Error('slice should not be called');
    }
  }
  const findings = new UnsafeSliceArray(1, 2, 3);

  assert.deepEqual(visibleAuditFindings(findings, 2), [1, 2]);
});

test('visibleAuditFindings avoids global array push hooks', () => {
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
    assert.deepEqual(visibleAuditFindings([1, 2, 3], 2), [1, 2]);
    assert.equal(pushCalls, 0);
  } finally {
    Object.defineProperty(Array.prototype, 'push', {
      configurable: true,
      writable: true,
      value: originalArrayPush
    });
  }
});

test('visibleAuditFindings reuses captured bounded array helpers', () => {
  let visible: readonly number[] = [];

  try {
    globalThis.Number = new Proxy(originalNumber, {
      get(target, property, receiver) {
        if (property === 'isSafeInteger') {
          throw new Error('Number.isSafeInteger should not be read');
        }
        return Reflect.get(target, property, receiver) as unknown;
      },
      apply(): never {
        throw new Error('Number constructor should not be called');
      },
      construct(): never {
        throw new Error('Number constructor should not be called');
      }
    }) as NumberConstructor;
    Array.isArray = function isArrayShouldNotBeCalled(_arg: unknown): _arg is unknown[] {
      throw new Error('Array.isArray should not be called');
    };
    Math.min = function minShouldNotBeCalled(): never {
      throw new Error('Math.min should not be called');
    };

    visible = visibleAuditFindings([1, 2, 3], 2);
  } finally {
    globalThis.Number = originalNumber;
    Array.isArray = originalArrayIsArray;
    Math.min = originalMathMin;
  }

  assert.deepEqual(visible, [1, 2]);
});

test('dashboard view helpers avoid user-controlled array traversal methods', () => {
  class UnsafeTraversalArray<T> extends Array<T> {
    override [Symbol.iterator](): ArrayIterator<T> {
      throw new Error('iterator should not be called');
    }

    override some(
      _predicate: (value: T, index: number, array: T[]) => unknown,
      _thisArg?: unknown
    ): boolean {
      throw new Error('some should not be called');
    }
  }

  const repositories = new UnsafeTraversalArray({ error: '' }, { error: 'failed' });
  const auditLinks = new UnsafeTraversalArray(
    { repo: 'nullclaw/nullbuilder', url: 'https://github.example.test/nullclaw/nullbuilder' },
    { repo: 'nullclaw/unsafe', url: 'javascript:alert(1)' }
  );

  assert.equal(hasDashboardReadErrors(repositories, null), true);
  assert.equal(
    buildAuditRepositoryUrls(auditLinks).get('nullclaw/nullbuilder'),
    'https://github.example.test/nullclaw/nullbuilder'
  );
});

test('audit href helpers prefer safe finding URLs before repository fallbacks', () => {
  const repositoryUrls = buildAuditRepositoryUrls([
    { repo: 'nullclaw/nullbuilder', url: 'https://github.example.test/nullclaw/nullbuilder' },
    { repo: 'nullclaw/unsafe', url: 'javascript:alert(1)' }
  ]);

  assert.equal(
    auditFindingHref(
      {
        repo: 'nullclaw/nullbuilder',
        url: 'https://github.example.test/nullclaw/nullbuilder/actions'
      },
      repositoryUrls
    ),
    'https://github.example.test/nullclaw/nullbuilder/actions'
  );
  assert.equal(
    auditFindingHref({ repo: 'nullclaw/nullbuilder', url: '' }, repositoryUrls),
    'https://github.example.test/nullclaw/nullbuilder'
  );
  assert.equal(auditFindingHref({ repo: 'nullclaw/unsafe' }, repositoryUrls), '#audit');
  assert.equal(auditRepositoryHref('javascript:alert(1)'), '#audit');
});

test('audit href helpers reject control-bearing and credentialed URLs', () => {
  const repositoryUrls = buildAuditRepositoryUrls([
    { repo: 'nullclaw/control', url: 'https://github.example.test/nullclaw/control%0aoutput=true' },
    { repo: 'nullclaw/creds', url: 'https://user:pass@github.example.test/nullclaw/creds' },
    { repo: 'nullclaw/runtime', url: 42 },
    { repo: 'nullclaw/plaintext', url: 'http://github.example.test/nullclaw/plaintext' },
    { repo: 'nullclaw/safe', url: 'http://localhost/nullclaw/safe' }
  ]);

  assert.equal(repositoryUrls.has('nullclaw/control'), false);
  assert.equal(repositoryUrls.has('nullclaw/creds'), false);
  assert.equal(repositoryUrls.has('nullclaw/runtime'), false);
  assert.equal(repositoryUrls.has('nullclaw/plaintext'), false);
  assert.equal(repositoryUrls.get('nullclaw/safe'), 'http://localhost/nullclaw/safe');
  assert.equal(
    auditFindingHref(
      { repo: 'nullclaw/safe', url: 'https://github.example.test/nullclaw/safe\nbad' },
      repositoryUrls
    ),
    'http://localhost/nullclaw/safe'
  );
});

test('dashboardExternalHref applies a safe fallback before the local fallback', () => {
  assert.equal(
    dashboardExternalHref('javascript:alert(1)', 'https://github.example.test/nullclaw/nullbuilder'),
    'https://github.example.test/nullclaw/nullbuilder'
  );
  assert.equal(dashboardExternalHref('javascript:alert(1)', '#audit'), '#audit');
  assert.equal(dashboardExternalHref('javascript:alert(1)', 'https://user:pass@github.example.test/repo'), '#');
  assert.equal(
    dashboardExternalHref('https://github.example.test/nullclaw/nullbuilder'),
    'https://github.example.test/nullclaw/nullbuilder'
  );
});

test('dashboardExternalHref rejects browser-normalized path ambiguities', () => {
  assert.equal(dashboardExternalHref('https://github.example.test/nullclaw//nullbuilder', '#audit'), '#audit');
  assert.equal(dashboardExternalHref('https://github.example.test/nullclaw/%2e%2e/secret', '#audit'), '#audit');
});

test('mutation result messages share dry-run move and create wording', () => {
  assert.equal(
    buildPrResultMessage({
      dryRun: true,
      forced: false,
      repo: 'nullclaw/nullbuilder',
      tagName: 'build-pr-7-de0fac2',
      prNumber: 7
    }),
    'Previewed build-pr-7-de0fac2 for nullclaw/nullbuilder #7'
  );

  assert.equal(
    buildPrResultMessage({
      dryRun: false,
      forced: true,
      repo: 'nullclaw/nullbuilder',
      tagName: 'build-pr-7-de0fac2',
      prNumber: 7
    }),
    'Moved build-pr-7-de0fac2 for nullclaw/nullbuilder #7'
  );

  assert.equal(
    releaseResultMessage({
      dryRun: false,
      forced: false,
      repo: 'nullclaw/nullbuilder',
      tagName: 'v1.2.3',
      targetSha: 'de0fac2e4500dabe0009e67214ff5f5447ce83dd'
    }),
    'Created v1.2.3 for nullclaw/nullbuilder at de0fac2'
  );
});

test('DASHBOARD_SECTIONS defines stable in-page navigation ids', () => {
  assert.deepEqual(
    DASHBOARD_SECTIONS.map((section) => section.id),
    ['repos', 'audit', 'issues', 'prs', 'build-pr', 'release-tag']
  );
});

test('DASHBOARD_SECTIONS cannot be mutated by callers', () => {
  assert.throws(() => {
    (DASHBOARD_SECTIONS as unknown as Array<{ id: string; label: string }>).push({
      id: 'unsafe',
      label: 'Unsafe'
    });
  }, TypeError);

  assert.throws(() => {
    (DASHBOARD_SECTIONS[0] as { id: string; label: string }).label = 'Unsafe';
  }, TypeError);

  assert.deepEqual(
    DASHBOARD_SECTIONS.map((section) => [section.id, section.label]),
    [
      ['repos', 'Overview'],
      ['audit', 'Audit'],
      ['issues', 'Issues'],
      ['prs', 'PRs'],
      ['build-pr', 'Build PR'],
      ['release-tag', 'Release Tag']
    ]
  );
});
