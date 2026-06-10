import { strict as assert } from 'node:assert';
import { afterEach, test } from 'node:test';
import { getAuditReport, MAX_WORKFLOW_FILES_PER_REPOSITORY } from './audit';
import { readConfig } from './config';

const originalFetch = globalThis.fetch;
const originalArrayPush = Array.prototype.push;

afterEach(() => {
  globalThis.fetch = originalFetch;
  restoreArrayPush();
});

test('getAuditReport normalizes repository and workflow URLs from GitHub payloads', async () => {
  const config = readConfig({
    NULLBUILDER_REPOS: 'nullbuilder',
    NULLBUILDER_GITHUB_API_URL: 'https://api.example.test',
    NULLBUILDER_GITHUB_WEB_URL: 'https://github.example.test',
    NULLBUILDER_CACHE_TTL_MS: '0'
  });
  const repositoryUrl = 'https://github.example.test/nullclaw/nullbuilder';

  const requests = mockGitHub((path) => {
    if (path === '/repos/nullclaw/nullbuilder') {
      return {
        full_name: 'nullclaw/nullbuilder',
        html_url: 'https://evil.example/nullclaw/nullbuilder',
        default_branch: 'main',
        private: false,
        archived: false
      };
    }

    if (path === '/repos/nullclaw/nullbuilder/contents/.github/workflows') {
      return [
        null,
        'not-a-content-item',
        {
          name: 'partial.yml',
          type: 'file',
          html_url: 'https://github.example.test/nullclaw/nullbuilder/blob/main/.github/workflows/partial.yml'
        },
        {
          name: 'ci.yml',
          path: '.github/workflows/ci.yml',
          type: 'file',
          html_url: 'https://github.example.test/other/repo/blob/main/.github/workflows/ci.yml'
        },
        {
          name: 'unsafe.yml\nsecret',
          path: '.github/workflows/unsafe.yml\nsecret',
          type: 'file',
          html_url: 'https://github.example.test/nullclaw/nullbuilder/blob/main/.github/workflows/unsafe.yml'
        },
        {
          name: 'nested.yml',
          path: '.github/workflows/nested.yml/extra',
          type: 'file',
          html_url: 'https://github.example.test/nullclaw/nullbuilder/blob/main/.github/workflows/nested.yml/extra'
        }
      ];
    }

    if (path === '/repos/nullclaw/nullbuilder/contents/.github/workflows/ci.yml') {
      return contentFile(`
on: pull_request_target
permissions: write-all
jobs:
  ci:
    uses: nullclaw/nullbuilder/.github/workflows/zig-ci.yml@v1
  nightly:
    uses: nullclaw/nullbuilder/.github/workflows/zig-nightly.yml@v1
  release:
    uses: nullclaw/nullbuilder/.github/workflows/zig-release.yml@v1
`);
    }

    if (path === '/repos/nullclaw/nullbuilder/branches/main/protection') {
      return {
        required_status_checks: {},
        required_pull_request_reviews: {}
      };
    }

    if (
      path === '/repos/nullclaw/nullbuilder/contents/.github/dependabot.yml' ||
      path === '/repos/nullclaw/nullbuilder/contents/SECURITY.md' ||
      path === '/repos/nullclaw/nullbuilder/contents/CODEOWNERS'
    ) {
      return contentFile('');
    }

    if (
      path === '/repos/nullclaw/nullbuilder/contents/.github/SECURITY.md' ||
      path === '/repos/nullclaw/nullbuilder/contents/.github/CODEOWNERS'
    ) {
      return responseJson({ message: 'Not Found' }, 404);
    }

    throw new Error(`Unexpected GET ${path}`);
  });

  const report = await getAuditReport(config);
  const repository = report.repositories[0];
  const triggerFinding = report.findings.find((finding) => finding.title === 'Workflow uses pull_request_target');

  assert.equal(repository.status, 'ok');
  assert.equal(repository.url, repositoryUrl);
  assert.equal(triggerFinding?.url, `${repositoryUrl}/actions`);
  assert.equal(report.findings.every((finding) => finding.url?.startsWith(repositoryUrl)), true);
  assert.equal(requests.some((path) => path.includes('unsafe') || path.includes('nested') || path.includes('partial')), false);
  assert.equal(JSON.stringify(report).includes('secret'), false);
});

test('getAuditReport rejects unsafe default branch values before probing branch protection', async () => {
  const config = readConfig({
    NULLBUILDER_REPOS: 'nullbuilder',
    NULLBUILDER_GITHUB_API_URL: 'https://api.example.test',
    NULLBUILDER_GITHUB_WEB_URL: 'https://github.example.test',
    NULLBUILDER_CACHE_TTL_MS: '0'
  });
  const requests = mockGitHub((path) => {
    if (path === '/repos/nullclaw/nullbuilder') {
      return {
        full_name: 'nullclaw/nullbuilder',
        html_url: 'https://github.example.test/nullclaw/nullbuilder',
        default_branch: 'main\ninjected',
        private: false,
        archived: false
      };
    }

    if (path === '/repos/nullclaw/nullbuilder/contents/.github/workflows') {
      return [];
    }

    if (
      path === '/repos/nullclaw/nullbuilder/contents/.github/dependabot.yml' ||
      path === '/repos/nullclaw/nullbuilder/contents/SECURITY.md' ||
      path === '/repos/nullclaw/nullbuilder/contents/.github/SECURITY.md' ||
      path === '/repos/nullclaw/nullbuilder/contents/CODEOWNERS' ||
      path === '/repos/nullclaw/nullbuilder/contents/.github/CODEOWNERS'
    ) {
      return responseJson({ message: 'Not Found' }, 404);
    }

    throw new Error(`Unexpected GET ${path}`);
  });

  const report = await getAuditReport(config);

  assert.equal(report.repositories[0].defaultBranch, 'unknown');
  assert.equal(requests.some((path) => path.includes('/branches/')), false);
  assert.equal(JSON.stringify(report).includes('injected'), false);
});

test('getAuditReport caps workflow file fetches before loading file content', async () => {
  const config = readConfig({
    NULLBUILDER_REPOS: 'nullbuilder',
    NULLBUILDER_GITHUB_API_URL: 'https://api.example.test',
    NULLBUILDER_GITHUB_WEB_URL: 'https://github.example.test',
    NULLBUILDER_CACHE_TTL_MS: '0'
  });
  const workflowItems = Array.from({ length: MAX_WORKFLOW_FILES_PER_REPOSITORY + 10 }, (_, index) => ({
    name: `workflow-${index}.yml`,
    path: `.github/workflows/workflow-${index}.yml`,
    type: 'file',
    html_url: `https://github.example.test/nullclaw/nullbuilder/blob/main/.github/workflows/workflow-${index}.yml`
  }));
  Object.defineProperty(workflowItems, Symbol.iterator, {
    value() {
      throw new Error('workflow directory iterator should not be called');
    }
  });
  const requests = mockGitHub((path) => {
    if (path === '/repos/nullclaw/nullbuilder') {
      return {
        full_name: 'nullclaw/nullbuilder',
        html_url: 'https://github.example.test/nullclaw/nullbuilder',
        default_branch: 'main',
        private: false,
        archived: false
      };
    }

    if (path === '/repos/nullclaw/nullbuilder/contents/.github/workflows') {
      return workflowItems;
    }

    if (path.startsWith('/repos/nullclaw/nullbuilder/contents/.github/workflows/workflow-')) {
      return contentFile('');
    }

    if (
      path === '/repos/nullclaw/nullbuilder/branches/main/protection' ||
      path === '/repos/nullclaw/nullbuilder/contents/.github/dependabot.yml' ||
      path === '/repos/nullclaw/nullbuilder/contents/SECURITY.md' ||
      path === '/repos/nullclaw/nullbuilder/contents/.github/SECURITY.md' ||
      path === '/repos/nullclaw/nullbuilder/contents/CODEOWNERS' ||
      path === '/repos/nullclaw/nullbuilder/contents/.github/CODEOWNERS'
    ) {
      return responseJson({ message: 'Not Found' }, 404);
    }

    throw new Error(`Unexpected GET ${path}`);
  });

  const report = await getAuditReport(config);
  const workflowFetches = requests.filter((path) =>
    path.startsWith('/repos/nullclaw/nullbuilder/contents/.github/workflows/workflow-')
  );

  assert.equal(report.repositories[0].status, 'ok');
  assert.equal(workflowFetches.length, MAX_WORKFLOW_FILES_PER_REPOSITORY);
  assert.equal(
    workflowFetches.some((path) => path.includes(`workflow-${MAX_WORKFLOW_FILES_PER_REPOSITORY}.yml`)),
    false
  );
});

test('getAuditReport collects workflow items and files without global array push hooks', async () => {
  const config = readConfig({
    NULLBUILDER_REPOS: 'nullbuilder',
    NULLBUILDER_GITHUB_API_URL: 'https://api.example.test',
    NULLBUILDER_GITHUB_WEB_URL: 'https://github.example.test',
    NULLBUILDER_CACHE_TTL_MS: '0'
  });
  const requests = mockGitHub((path) => {
    if (path === '/repos/nullclaw/nullbuilder') {
      return {
        full_name: 'nullclaw/nullbuilder',
        html_url: 'https://github.example.test/nullclaw/nullbuilder',
        default_branch: 'main',
        private: false,
        archived: false
      };
    }

    if (path === '/repos/nullclaw/nullbuilder/contents/.github/workflows') {
      return [
        {
          name: 'ci.yml',
          path: '.github/workflows/ci.yml',
          type: 'file',
          html_url: 'https://github.example.test/nullclaw/nullbuilder/blob/main/.github/workflows/ci.yml'
        },
        {
          name: 'notes.txt',
          path: '.github/workflows/notes.txt',
          type: 'file',
          html_url: 'https://github.example.test/nullclaw/nullbuilder/blob/main/.github/workflows/notes.txt'
        },
        {
          name: 'release.yaml',
          path: '.github/workflows/release.yaml',
          type: 'file',
          html_url: 'https://github.example.test/nullclaw/nullbuilder/blob/main/.github/workflows/release.yaml'
        }
      ];
    }

    if (path === '/repos/nullclaw/nullbuilder/contents/.github/workflows/ci.yml') {
      return contentFile(`
permissions: read-all
jobs:
  ci:
    uses: nullclaw/nullbuilder/.github/workflows/zig-ci.yml@v1
`);
    }

    if (path === '/repos/nullclaw/nullbuilder/contents/.github/workflows/release.yaml') {
      return contentFile(`
permissions: read-all
jobs:
  release:
    uses: nullclaw/nullbuilder/.github/workflows/zig-release.yml@v1
`);
    }

    if (path === '/repos/nullclaw/nullbuilder/branches/main/protection') {
      return {
        required_status_checks: {},
        required_pull_request_reviews: {}
      };
    }

    if (
      path === '/repos/nullclaw/nullbuilder/contents/.github/dependabot.yml' ||
      path === '/repos/nullclaw/nullbuilder/contents/SECURITY.md' ||
      path === '/repos/nullclaw/nullbuilder/contents/.github/SECURITY.md' ||
      path === '/repos/nullclaw/nullbuilder/contents/CODEOWNERS' ||
      path === '/repos/nullclaw/nullbuilder/contents/.github/CODEOWNERS'
    ) {
      return responseJson({ message: 'Not Found' }, 404);
    }

    throw new Error(`Unexpected GET ${path}`);
  });

  const { result: report, pushCalls } = await withGuardedArrayPush(() => getAuditReport(config));
  const workflowFetches = requests.filter((path) => path.includes('/contents/.github/workflows/'));

  assert.equal(pushCalls, 0);
  assert.equal(report.repositories[0].status, 'ok');
  assert.deepEqual(workflowFetches, [
    '/repos/nullclaw/nullbuilder/contents/.github/workflows/ci.yml',
    '/repos/nullclaw/nullbuilder/contents/.github/workflows/release.yaml'
  ]);
});

function mockGitHub(handler: (path: string) => unknown): string[] {
  const requests: string[] = [];

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    requests[requests.length] = url.pathname;
    const response = handler(url.pathname);
    return response instanceof Response ? response : responseJson(response);
  }) as typeof fetch;

  return requests;
}

function contentFile(content: string): unknown {
  return {
    name: 'file',
    path: 'file',
    type: 'file',
    html_url: 'https://github.example.test/nullclaw/nullbuilder/blob/main/file',
    encoding: 'base64',
    content: Buffer.from(content, 'utf8').toString('base64')
  };
}

function responseJson(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      'Content-Type': 'application/json'
    }
  });
}

async function withGuardedArrayPush<T>(
  callback: () => Promise<T>
): Promise<{ result: T; pushCalls: number }> {
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
      result: await callback(),
      pushCalls
    };
  } finally {
    restoreArrayPush();
  }
}

function restoreArrayPush(): void {
  Object.defineProperty(Array.prototype, 'push', {
    configurable: true,
    writable: true,
    value: originalArrayPush
  });
}
