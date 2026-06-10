import { strict as assert } from 'node:assert';
import { afterEach, test } from 'node:test';
import { readConfig } from './config';
import { buildPrTag, createReleaseTag } from './github-mutations';

const originalFetch = globalThis.fetch;
const headSha = 'de0fac2e4500dabe0009e67214ff5f5447ce83dd';
const targetSha = '1111111111111111111111111111111111111111';

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test('buildPrTag rejects untrusted PRs before creating tag refs', async () => {
  const config = testConfig();
  const requests = mockGitHub((path, method) => {
    if (method === 'GET' && path === '/repos/nullclaw/nullbuilder') {
      return repositoryResponse();
    }

    if (method === 'GET' && path === '/repos/nullclaw/nullbuilder/pulls/7') {
      return pullResponse({
        draft: true,
        baseRef: 'develop',
        headRepo: 'external/nullbuilder'
      });
    }

    throw new Error(`Unexpected ${method} ${path}`);
  });

  await assert.rejects(
    () =>
      buildPrTag(config, {
        repo: 'nullbuilder',
        prNumber: 7,
        confirm: true
      }),
    /draft PRs are rejected by default; base branch must be main; fork PRs are rejected by default/
  );
  assert.equal(requests.some((request) => request.method !== 'GET'), false);
});

test('buildPrTag returns dry-run metadata without mutating refs', async () => {
  const config = testConfig();
  const requests = mockGitHub((path, method) => {
    if (method === 'GET' && path === '/repos/nullclaw/nullbuilder') {
      return repositoryResponse();
    }

    if (method === 'GET' && path === '/repos/nullclaw/nullbuilder/pulls/7') {
      return pullResponse();
    }

    throw new Error(`Unexpected ${method} ${path}`);
  });

  const result = await buildPrTag(config, {
    repo: 'nullbuilder',
    prNumber: 7
  });

  assert.equal(result.dryRun, true);
  assert.equal(result.created, false);
  assert.equal(result.forced, false);
  assert.equal(result.tagName, 'build-pr-7-de0fac2');
  assert.deepEqual(
    requests.map((request) => request.method),
    ['GET', 'GET']
  );
});

test('buildPrTag rejects unsafe API head SHAs before creating tag refs', async () => {
  const config = testConfig();
  const requests = mockGitHub((path, method) => {
    if (method === 'GET' && path === '/repos/nullclaw/nullbuilder') {
      return repositoryResponse();
    }

    if (method === 'GET' && path === '/repos/nullclaw/nullbuilder/pulls/7') {
      return pullResponse({
        headSha: 'not-a-sha'
      });
    }

    throw new Error(`Unexpected ${method} ${path}`);
  });

  await assert.rejects(
    () =>
      buildPrTag(config, {
        repo: 'nullbuilder',
        prNumber: 7,
        confirm: true
      }),
    /Invalid pull request head SHA/
  );
  assert.deepEqual(
    requests.map((request) => `${request.method} ${request.path}`),
    ['GET /repos/nullclaw/nullbuilder', 'GET /repos/nullclaw/nullbuilder/pulls/7']
  );
});

test('buildPrTag rejects unsafe API default branches before trust messages', async () => {
  const config = testConfig();
  const requests = mockGitHub((path, method) => {
    if (method === 'GET' && path === '/repos/nullclaw/nullbuilder') {
      return repositoryResponse({
        defaultBranch: 'main\ninjected'
      });
    }

    if (method === 'GET' && path === '/repos/nullclaw/nullbuilder/pulls/7') {
      return pullResponse({
        baseRef: 'develop'
      });
    }

    throw new Error(`Unexpected ${method} ${path}`);
  });

  await assert.rejects(
    () =>
      buildPrTag(config, {
        repo: 'nullbuilder',
        prNumber: 7,
        confirm: true
      }),
    (error: unknown) =>
      error instanceof Error && error.message === 'Invalid default branch.' && !error.message.includes('injected')
  );
  assert.deepEqual(
    requests.map((request) => `${request.method} ${request.path}`),
    ['GET /repos/nullclaw/nullbuilder', 'GET /repos/nullclaw/nullbuilder/pulls/7']
  );
});

test('createReleaseTag reports forced tag moves separately from creation', async () => {
  const config = testConfig();
  const requests = mockGitHub((path, method) => {
    if (method === 'GET' && path === '/repos/nullclaw/nullbuilder') {
      return repositoryResponse();
    }

    if (method === 'GET' && path === '/repos/nullclaw/nullbuilder/branches/main') {
      return {
        name: 'main',
        commit: {
          sha: targetSha
        }
      };
    }

    if (method === 'POST' && path === '/repos/nullclaw/nullbuilder/git/refs') {
      return responseJson({ message: 'Reference already exists' }, 422);
    }

    if (method === 'GET' && path === '/repos/nullclaw/nullbuilder/git/ref/tags/v1.2.3') {
      return referenceResponse('refs/tags/v1.2.3');
    }

    if (method === 'PATCH' && path === '/repos/nullclaw/nullbuilder/git/refs/tags/v1.2.3') {
      return referenceResponse('refs/tags/v1.2.3');
    }

    throw new Error(`Unexpected ${method} ${path}`);
  });

  const result = await createReleaseTag(config, {
    repo: 'nullbuilder',
    tagName: 'v1.2.3',
    confirm: true,
    force: true
  });

  assert.equal(result.created, false);
  assert.equal(result.forced, true);
  assert.deepEqual(
    requests.map((request) => `${request.method} ${request.path}`),
    [
      'GET /repos/nullclaw/nullbuilder',
      'GET /repos/nullclaw/nullbuilder/branches/main',
      'POST /repos/nullclaw/nullbuilder/git/refs',
      'GET /repos/nullclaw/nullbuilder/git/ref/tags/v1.2.3',
      'PATCH /repos/nullclaw/nullbuilder/git/refs/tags/v1.2.3'
    ]
  );
});

test('createReleaseTag rejects unsafe API default branches before creating tag refs', async () => {
  const config = testConfig();
  const requests = mockGitHub((path, method) => {
    if (method === 'GET' && path === '/repos/nullclaw/nullbuilder') {
      return repositoryResponse({
        defaultBranch: 'main\ninjected'
      });
    }

    throw new Error(`Unexpected ${method} ${path}`);
  });

  await assert.rejects(
    () =>
      createReleaseTag(config, {
        repo: 'nullbuilder',
        tagName: 'v1.2.3',
        confirm: true
      }),
    (error: unknown) =>
      error instanceof Error && error.message === 'Invalid default branch.' && !error.message.includes('injected')
  );
  assert.deepEqual(
    requests.map((request) => `${request.method} ${request.path}`),
    ['GET /repos/nullclaw/nullbuilder']
  );
});

test('createReleaseTag rejects unsafe API branch SHAs before creating tag refs', async () => {
  const config = testConfig();
  const requests = mockGitHub((path, method) => {
    if (method === 'GET' && path === '/repos/nullclaw/nullbuilder') {
      return repositoryResponse();
    }

    if (method === 'GET' && path === '/repos/nullclaw/nullbuilder/branches/main') {
      return {
        name: 'main',
        commit: {
          sha: 'not-a-sha'
        }
      };
    }

    throw new Error(`Unexpected ${method} ${path}`);
  });

  await assert.rejects(
    () =>
      createReleaseTag(config, {
        repo: 'nullbuilder',
        tagName: 'v1.2.3',
        confirm: true
      }),
    /Invalid branch commit SHA/
  );
  assert.deepEqual(
    requests.map((request) => `${request.method} ${request.path}`),
    ['GET /repos/nullclaw/nullbuilder', 'GET /repos/nullclaw/nullbuilder/branches/main']
  );
});

test('createReleaseTag rejects unsafe target refs before fetching GitHub', async () => {
  const config = testConfig();
  const requests = mockGitHub((path, method) => {
    throw new Error(`Unexpected ${method} ${path}`);
  });

  await assert.rejects(
    () =>
      createReleaseTag(config, {
        repo: 'nullbuilder',
        tagName: 'v1.2.3',
        targetRef: 'refs/heads/main'
      }),
    /Invalid target ref/
  );
  assert.deepEqual(requests, []);
});

test('createReleaseTag resolves slash branch target refs through the branch API', async () => {
  const config = testConfig();
  const requests = mockGitHub((path, method) => {
    if (method === 'GET' && path === '/repos/nullclaw/nullbuilder') {
      return repositoryResponse();
    }

    if (method === 'GET' && path === '/repos/nullclaw/nullbuilder/branches/release%2Fv1.2.3') {
      return {
        name: 'release/v1.2.3',
        commit: {
          sha: targetSha
        }
      };
    }

    throw new Error(`Unexpected ${method} ${path}`);
  });

  const result = await createReleaseTag(config, {
    repo: 'nullbuilder',
    tagName: 'v1.2.3',
    targetRef: ' release/v1.2.3 '
  });

  assert.equal(result.dryRun, true);
  assert.equal(result.targetRef, 'release/v1.2.3');
  assert.deepEqual(
    requests.map((request) => `${request.method} ${request.path}`),
    ['GET /repos/nullclaw/nullbuilder', 'GET /repos/nullclaw/nullbuilder/branches/release%2Fv1.2.3']
  );
});

function testConfig() {
  return readConfig({
    NULLBUILDER_REPOS: 'nullbuilder',
    NULLBUILDER_GITHUB_API_URL: 'https://api.example.test',
    NULLBUILDER_GITHUB_WEB_URL: 'https://github.example.test',
    NULLBUILDER_CACHE_TTL_MS: '0'
  });
}

function mockGitHub(
  handler: (path: string, method: string, init?: RequestInit) => unknown
): Array<{ method: string; path: string }> {
  const requests: Array<{ method: string; path: string }> = [];

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method?.toUpperCase() ?? 'GET';
    requests.push({
      method,
      path: url.pathname
    });

    const response = handler(url.pathname, method, init);
    return response instanceof Response ? response : responseJson(response);
  }) as typeof fetch;

  return requests;
}

function responseJson(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      'Content-Type': 'application/json'
    }
  });
}

function repositoryResponse({ defaultBranch = 'main' }: { defaultBranch?: string } = {}) {
  return {
    name: 'nullbuilder',
    full_name: 'nullclaw/nullbuilder',
    html_url: 'https://github.example.test/nullclaw/nullbuilder',
    description: null,
    default_branch: defaultBranch,
    language: 'Zig',
    private: false,
    archived: false,
    stargazers_count: 1,
    forks_count: 0,
    open_issues_count: 0,
    pushed_at: '2026-06-01T00:00:00Z',
    updated_at: '2026-06-01T00:00:00Z',
    owner: {
      login: 'nullclaw'
    }
  };
}

function pullResponse({
  draft = false,
  baseRef = 'main',
  headRepo = 'nullclaw/nullbuilder',
  headSha: pullHeadSha = headSha
}: {
  draft?: boolean;
  baseRef?: string;
  headRepo?: string;
  headSha?: string;
} = {}) {
  return {
    number: 7,
    title: 'Improve build',
    html_url: 'https://github.example.test/nullclaw/nullbuilder/pull/7',
    draft,
    user: {
      login: 'contributor'
    },
    labels: [],
    comments: 0,
    created_at: '2026-06-01T00:00:00Z',
    updated_at: '2026-06-01T00:00:00Z',
    base: {
      ref: baseRef,
      repo: {
        full_name: 'nullclaw/nullbuilder'
      }
    },
    head: {
      ref: 'feature',
      sha: pullHeadSha,
      repo: {
        full_name: headRepo
      }
    }
  };
}

function referenceResponse(ref: string) {
  return {
    ref,
    object: {
      sha: targetSha
    }
  };
}
