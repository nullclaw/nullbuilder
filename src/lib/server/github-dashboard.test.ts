import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import type { RepoSlug } from '../repositories';
import { readConfig } from './config';
import {
  buildDashboard,
  makeErrorRepository,
  mapRepositorySummary,
  type GitHubIssueResponse,
  type GitHubPullResponse,
  type GitHubRepositoryResponse,
  type GitHubWorkflowRunResponse,
  type RepositorySummary
} from './github-dashboard';
import { GitHubApiError } from './github-client';

const REPO = 'nullclaw/nullbuilder' as RepoSlug;

test('mapRepositorySummary maps GitHub payloads and filters PR-backed issues', () => {
  const summary = mapRepositorySummary(
    REPO,
    githubRepository({ description: null }),
    [
      issue({
        number: 7,
        user: null,
        labels: [
          'bug',
          { name: 'security', color: 'b60205' },
          { name: 'unsafe', color: 'url(javascript:alert)' },
          {}
        ],
        updated_at: '2026-06-09T12:00:00Z'
      }),
      issue({ number: 8, pull_request: {} })
    ],
    [
      pull({
        number: 9,
        labels: undefined,
        comments: undefined,
        head: { ref: 'feature/refactor', sha: 'abc123', repo: null }
      })
    ],
    [
      workflowRun({
        name: 'CI',
        path: '.github/workflows/build.yml',
        status: 'completed',
        conclusion: 'failure'
      }),
      workflowRun({
        id: 2,
        name: null,
        path: '.github/workflows/zig-nightly.yml',
        display_title: 'Nightly build',
        conclusion: 'success'
      })
    ],
    { current: 10, last7Days: 1, last30Days: 3 }
  );

  assert.equal(summary.description, '');
  assert.equal(summary.openIssues, 1);
  assert.equal(summary.openPulls, 1);
  assert.equal(summary.issues[0].author, 'unknown');
  assert.deepEqual(summary.issues[0].labels, [
    { name: 'bug', color: 'd0d7de' },
    { name: 'security', color: 'b60205' },
    { name: 'unsafe', color: 'd0d7de' },
    { name: 'label', color: 'd0d7de' }
  ]);
  assert.equal(summary.pullRequests[0].comments, 0);
  assert.equal(summary.pullRequests[0].headBranch, 'feature/refactor');
  assert.equal(summary.latestRuns.ci?.conclusion, 'failure');
  assert.equal(summary.latestRuns.nightly?.name, 'Workflow');
});

test('mapRepositorySummary normalizes unsafe GitHub counters', () => {
  const summary = mapRepositorySummary(
    REPO,
    githubRepository({
      stargazers_count: Number.MAX_SAFE_INTEGER + 1,
      forks_count: -1
    }),
    [
      issue({
        comments: 1.5
      })
    ],
    [
      pull({
        comments: Number.MAX_SAFE_INTEGER + 1
      })
    ],
    [],
    { current: null, last7Days: null, last30Days: null }
  );

  assert.equal(summary.stars, null);
  assert.equal(summary.forks, null);
  assert.equal(summary.issues[0].comments, 0);
  assert.equal(summary.pullRequests[0].comments, 0);
});

test('mapRepositorySummary skips invalid issue and pull request numbers', () => {
  const summary = mapRepositorySummary(
    REPO,
    githubRepository(),
    [
      issue({ number: 0, title: 'Zero' }),
      issue({ number: -1, title: 'Negative' }),
      issue({ number: 1.5, title: 'Fractional' }),
      issue({ number: Number.MAX_SAFE_INTEGER + 1, title: 'Unsafe' }),
      issue({ number: 7, title: 'Valid issue' })
    ],
    [
      pull({ number: 0, title: 'Zero' }),
      pull({ number: Number.NaN, title: 'NaN' }),
      pull({ number: 9, title: 'Valid pull' })
    ],
    [],
    { current: null, last7Days: null, last30Days: null }
  );

  assert.equal(summary.openIssues, 1);
  assert.equal(summary.openPulls, 1);
  assert.deepEqual(
    summary.issues.map((item) => item.number),
    [7]
  );
  assert.deepEqual(
    summary.pullRequests.map((item) => item.number),
    [9]
  );
});

test('buildDashboard summarizes loaded error and failing repositories', () => {
  const config = readConfig({
    NULLBUILDER_REPOS: 'nullbuilder,broken',
    NULLBUILDER_GITHUB_TOKEN: 'github-token'
  });
  const errorRepo = makeErrorRepository(
    config,
    'nullclaw/broken' as RepoSlug,
    new GitHubApiError('GitHub 403 Forbidden: leaked detail', 403),
    '2026-06-09T00:00:00Z'
  );
  const dashboard = buildDashboard(
    config,
    config.repos,
    [
      repositorySummary({
        stars: 12,
        issues: [
          workItem(1, '2026-06-08T00:00:00Z'),
          workItem(2, '2026-06-09T00:00:00Z')
        ],
        pullRequests: [pullRequestSummary(3, '2026-06-09T01:00:00Z')],
        latestRuns: {
          ci: workflowSummary({ status: 'completed', conclusion: 'failure' }),
          nightly: null,
          release: null
        }
      }),
      errorRepo
    ],
    '2026-06-09T02:00:00Z'
  );

  assert.equal(dashboard.generatedAt, '2026-06-09T02:00:00Z');
  assert.equal(dashboard.hasToken, true);
  assert.equal(dashboard.hasReadErrors, true);
  assert.deepEqual(dashboard.issues.map((item) => item.number), [2, 1]);
  assert.deepEqual(dashboard.pullRequests.map((item) => item.number), [3]);
  assert.deepEqual(dashboard.totals, {
    repositories: 2,
    loadedRepositories: 1,
    erroredRepositories: 1,
    issues: 2,
    pullRequests: 1,
    stars: 12,
    failingRuns: 1
  });
  assert.equal(errorRepo.error, 'GitHub API authorization or rate-limit error (403).');
});

test('buildDashboard sorts invalid updated timestamps after valid rows', () => {
  const config = readConfig({
    NULLBUILDER_REPOS: 'nullbuilder'
  });
  const dashboard = buildDashboard(config, config.repos, [
    repositorySummary({
      issues: [
        workItem(1, 'not-a-date'),
        workItem(2, '2026-06-09T00:00:00Z'),
        workItem(3, '')
      ]
    })
  ]);

  assert.deepEqual(dashboard.issues.map((item) => item.number), [2, 1, 3]);
});

test('buildDashboard saturates unsafe star totals', () => {
  const config = readConfig({
    NULLBUILDER_REPOS: 'nullbuilder'
  });
  const dashboard = buildDashboard(config, config.repos, [
    repositorySummary({ stars: Number.MAX_SAFE_INTEGER }),
    repositorySummary({ stars: 1 })
  ]);

  assert.equal(dashboard.totals.stars, Number.MAX_SAFE_INTEGER);
});

function githubRepository(overrides: Partial<GitHubRepositoryResponse> = {}): GitHubRepositoryResponse {
  return {
    name: 'nullbuilder',
    full_name: REPO,
    html_url: 'https://github.example.test/nullclaw/nullbuilder',
    description: 'Command center',
    default_branch: 'main',
    language: 'TypeScript',
    private: false,
    archived: false,
    stargazers_count: 10,
    forks_count: 2,
    open_issues_count: 3,
    pushed_at: '2026-06-08T00:00:00Z',
    updated_at: '2026-06-09T00:00:00Z',
    owner: {
      login: 'nullclaw'
    },
    ...overrides
  };
}

function issue(overrides: Partial<GitHubIssueResponse> = {}): GitHubIssueResponse {
  return {
    number: 1,
    title: 'Issue',
    html_url: 'https://github.example.test/nullclaw/nullbuilder/issues/1',
    user: {
      login: 'octocat'
    },
    labels: [],
    comments: 0,
    created_at: '2026-06-08T00:00:00Z',
    updated_at: '2026-06-08T00:00:00Z',
    ...overrides
  };
}

function pull(overrides: Partial<GitHubPullResponse> = {}): GitHubPullResponse {
  return {
    number: 1,
    title: 'PR',
    html_url: 'https://github.example.test/nullclaw/nullbuilder/pull/1',
    draft: false,
    user: {
      login: 'octocat'
    },
    labels: [],
    comments: 0,
    created_at: '2026-06-08T00:00:00Z',
    updated_at: '2026-06-08T00:00:00Z',
    base: {
      ref: 'main'
    },
    head: {
      ref: 'feature',
      sha: 'abcdef',
      repo: {
        full_name: REPO
      }
    },
    ...overrides
  };
}

function workflowRun(overrides: Partial<GitHubWorkflowRunResponse> = {}): GitHubWorkflowRunResponse {
  return {
    id: 1,
    name: 'CI',
    path: '.github/workflows/ci.yml',
    display_title: 'CI',
    status: 'completed',
    conclusion: 'success',
    html_url: 'https://github.example.test/nullclaw/nullbuilder/actions/runs/1',
    head_branch: 'main',
    event: 'push',
    created_at: '2026-06-08T00:00:00Z',
    updated_at: '2026-06-08T00:00:00Z',
    ...overrides
  };
}

function repositorySummary(overrides: Partial<RepositorySummary> = {}): RepositorySummary {
  return {
    slug: REPO,
    owner: 'nullclaw',
    name: 'nullbuilder',
    fullName: REPO,
    url: 'https://github.example.test/nullclaw/nullbuilder',
    description: 'Command center',
    defaultBranch: 'main',
    language: 'TypeScript',
    isPrivate: false,
    archived: false,
    stars: 0,
    forks: 0,
    openIssues: 0,
    openPulls: 0,
    pushedAt: '2026-06-08T00:00:00Z',
    updatedAt: '2026-06-09T00:00:00Z',
    issues: [],
    pullRequests: [],
    starGrowth: {
      current: 0,
      last7Days: 0,
      last30Days: 0
    },
    latestRuns: {
      ci: null,
      nightly: null,
      release: null
    },
    status: 'ok',
    ...overrides
  };
}

function workItem(number: number, updatedAt: string): RepositorySummary['issues'][number] {
  return {
    repo: REPO,
    number,
    title: `Issue ${number}`,
    url: `https://github.example.test/nullclaw/nullbuilder/issues/${number}`,
    author: 'octocat',
    labels: [],
    comments: 0,
    createdAt: '2026-06-08T00:00:00Z',
    updatedAt
  };
}

function pullRequestSummary(number: number, updatedAt: string): RepositorySummary['pullRequests'][number] {
  return {
    ...workItem(number, updatedAt),
    draft: false,
    baseBranch: 'main',
    headBranch: 'feature',
    headSha: 'abcdef'
  };
}

function workflowSummary(
  overrides: Partial<NonNullable<RepositorySummary['latestRuns']['ci']>> = {}
): NonNullable<RepositorySummary['latestRuns']['ci']> {
  return {
    id: 1,
    name: 'CI',
    path: '.github/workflows/ci.yml',
    displayTitle: 'CI',
    status: 'completed',
    conclusion: 'success',
    url: 'https://github.example.test/nullclaw/nullbuilder/actions/runs/1',
    branch: 'main',
    event: 'push',
    createdAt: '2026-06-08T00:00:00Z',
    updatedAt: '2026-06-08T00:00:00Z',
    ...overrides
  };
}
