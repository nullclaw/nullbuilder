import { strict as assert } from 'node:assert';
import { afterEach, test } from 'node:test';
import { getAuditReport } from './audit';
import { readConfig } from './config';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
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

  assert.equal(repository.url, repositoryUrl);
  assert.equal(triggerFinding?.url, `${repositoryUrl}/actions`);
  assert.equal(report.findings.every((finding) => finding.url?.startsWith(repositoryUrl)), true);
  assert.equal(requests.some((path) => path.includes('unsafe') || path.includes('nested')), false);
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

function mockGitHub(handler: (path: string) => unknown): string[] {
  const requests: string[] = [];

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    requests.push(url.pathname);
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
