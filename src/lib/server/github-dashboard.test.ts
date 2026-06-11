import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import type { RepoSlug } from '../repositories';
import { readConfig } from './config';
import {
  buildDashboard,
  makeErrorRepository,
  mapRepositorySummary,
  workflowRunClassifierEntries,
  MAX_DASHBOARD_TEXT_FIELD_LENGTH,
  MAX_DASHBOARD_URL_LENGTH,
  MAX_DASHBOARD_WORK_LIST_ITEMS,
  MAX_LABELS_PER_WORK_ITEM,
  MAX_LABELS_TO_SCAN,
  MAX_LABEL_NAME_LENGTH,
  MAX_REPOSITORY_WORK_ITEMS,
  MAX_REPOSITORY_WORK_ITEMS_TO_SCAN,
  MAX_TIMESTAMP_TEXT_LENGTH,
  MAX_WORKFLOW_RUNS_PER_REPOSITORY,
  MAX_WORK_ITEM_TITLE_LENGTH,
  type GitHubIssueResponse,
  type GitHubPullResponse,
  type GitHubRepositoryResponse,
  type GitHubWorkflowRunResponse,
  type RepositorySummary
} from './github-dashboard';
import { GitHubApiError } from './github-client';

const REPO = 'nullclaw/nullbuilder' as RepoSlug;
const originalArrayPush = Array.prototype.push;

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
      private: 'true' as unknown as boolean,
      archived: 1 as unknown as boolean,
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
        draft: 'false' as unknown as boolean,
        comments: Number.MAX_SAFE_INTEGER + 1
      })
    ],
    [
      workflowRun({
        id: Number.MAX_SAFE_INTEGER + 1
      })
    ],
    { current: null, last7Days: null, last30Days: null }
  );

  assert.equal(summary.isPrivate, false);
  assert.equal(summary.archived, false);
  assert.equal(summary.stars, null);
  assert.equal(summary.forks, null);
  assert.equal(summary.issues[0].comments, 0);
  assert.equal(summary.pullRequests[0].comments, 0);
  assert.equal(summary.pullRequests[0].draft, false);
  assert.equal(summary.latestRuns.ci?.id, null);
});

test('mapRepositorySummary tolerates malformed nested GitHub payloads', () => {
  const summary = mapRepositorySummary(
    REPO,
    githubRepository({
      html_url: 42 as unknown as string,
      name: 7 as unknown as string,
      owner: null as unknown as GitHubRepositoryResponse['owner']
    }),
    [
      null as unknown as GitHubIssueResponse,
      issue({
        title: 7 as unknown as string,
        html_url: 42 as unknown as string,
        user: 7 as unknown as GitHubIssueResponse['user'],
        labels: [null, 42, [], {}, { name: 123, color: 123 }, ' bug '] as unknown as GitHubIssueResponse['labels'],
        created_at: 42 as unknown as string
      })
    ],
    [
      null as unknown as GitHubPullResponse,
      pull({
        html_url: 42 as unknown as string,
        user: false as unknown as GitHubPullResponse['user'],
        labels: { name: 'bug' } as unknown as GitHubPullResponse['labels'],
        base: null as unknown as GitHubPullResponse['base'],
        head: { ref: 42 as unknown as string, sha: null as unknown as string }
      })
    ],
    [
      null as unknown as GitHubWorkflowRunResponse,
      workflowRun({
        status: 123 as unknown as string,
        conclusion: undefined as unknown as GitHubWorkflowRunResponse['conclusion'],
        html_url: 42 as unknown as string,
        head_branch: 123 as unknown as string,
        event: false as unknown as string,
        created_at: 42 as unknown as string
      })
    ],
    { current: null, last7Days: null, last30Days: null }
  );

  assert.equal(summary.owner, 'nullclaw');
  assert.equal(summary.name, 'nullbuilder');
  assert.equal(summary.url, 'https://github.com/nullclaw/nullbuilder');
  assert.equal(summary.openIssues, 1);
  assert.equal(summary.openPulls, 1);
  assert.equal(summary.issues[0].title, 'Untitled issue');
  assert.equal(summary.issues[0].url, 'https://github.com/nullclaw/nullbuilder/issues/1');
  assert.deepEqual(summary.issues[0].labels, [
    { name: 'label', color: 'd0d7de' },
    { name: 'label', color: 'd0d7de' },
    { name: 'bug', color: 'd0d7de' }
  ]);
  assert.equal(summary.issues[0].author, 'unknown');
  assert.equal(summary.issues[0].createdAt, '');
  assert.equal(summary.pullRequests[0].url, 'https://github.com/nullclaw/nullbuilder/pull/1');
  assert.equal(summary.pullRequests[0].labels.length, 0);
  assert.equal(summary.pullRequests[0].baseBranch, 'unknown');
  assert.equal(summary.pullRequests[0].headBranch, 'unknown');
  assert.equal(summary.pullRequests[0].headSha, 'unknown');
  assert.equal(summary.latestRuns.ci?.status, 'unknown');
  assert.equal(summary.latestRuns.ci?.conclusion, null);
  assert.equal(summary.latestRuns.ci?.url, 'https://github.com/nullclaw/nullbuilder/actions');
  assert.equal(summary.latestRuns.ci?.branch, 'unknown');
  assert.equal(summary.latestRuns.ci?.event, 'unknown');
  assert.equal(summary.latestRuns.ci?.createdAt, '');
});

test('mapRepositorySummary canonicalizes workflow run labels before dashboard output', () => {
  const summary = mapRepositorySummary(
    REPO,
    githubRepository(),
    [],
    [],
    [
      workflowRun({
        name: 'CI',
        path: '.github/workflows/ci.yml',
        status: 'deploying-secret',
        conclusion: 'private-secret'
      }),
      workflowRun({
        id: 2,
        name: 'Nightly',
        path: '.github/workflows/nightly.yml',
        status: 'completed',
        conclusion: 'private-secret'
      }),
      workflowRun({
        id: 3,
        name: 'Release',
        path: '.github/workflows/release.yml',
        status: 'completed',
        conclusion: 'action_required'
      })
    ],
    { current: null, last7Days: null, last30Days: null }
  );

  assert.equal(summary.latestRuns.ci?.status, 'unknown');
  assert.equal(summary.latestRuns.ci?.conclusion, 'failure');
  assert.equal(summary.latestRuns.nightly?.status, 'completed');
  assert.equal(summary.latestRuns.nightly?.conclusion, 'failure');
  assert.equal(summary.latestRuns.release?.conclusion, 'action_required');
  assert.equal(JSON.stringify(summary.latestRuns).includes('deploying-secret'), false);
  assert.equal(JSON.stringify(summary.latestRuns).includes('private-secret'), false);
});

test('mapRepositorySummary bounds and sanitizes labels from GitHub payloads', () => {
  const longLabel = 'x'.repeat(MAX_LABEL_NAME_LENGTH + 10);
  const labels = [
    ' bug ',
    { name: 'unsafe\x1b[31m\nlabel', color: 'ABCDEF' },
    { name: '', color: 'not-a-color' },
    longLabel,
    ...Array.from({ length: MAX_LABELS_PER_WORK_ITEM + 5 }, (_, index) => `label-${index}`)
  ];
  const summary = mapRepositorySummary(
    REPO,
    githubRepository(),
    [issue({ labels })],
    [],
    [],
    { current: null, last7Days: null, last30Days: null }
  );

  assert.equal(summary.issues[0].labels.length, MAX_LABELS_PER_WORK_ITEM);
  assert.deepEqual(summary.issues[0].labels.slice(0, 4), [
    { name: 'bug', color: 'd0d7de' },
    { name: 'unsafe label', color: 'abcdef' },
    { name: 'label', color: 'd0d7de' },
    { name: 'x'.repeat(MAX_LABEL_NAME_LENGTH), color: 'd0d7de' }
  ]);
  assert.equal(summary.issues[0].labels.at(-1)?.name, `label-${MAX_LABELS_PER_WORK_ITEM - 5}`);
});

test('mapRepositorySummary collects labels without global array push hooks', () => {
  const { result: summary, pushCalls } = withGuardedArrayPush(() =>
    mapRepositorySummary(
      REPO,
      githubRepository(),
      [
        issue({
          labels: [' bug ', { name: 'security', color: 'B60205' }]
        })
      ],
      [
        pull({
          labels: [{ name: 'review', color: '0E8A16' }]
        })
      ],
      [],
      { current: null, last7Days: null, last30Days: null }
    )
  );

  assert.equal(pushCalls, 0);
  assert.deepEqual(summary.issues[0].labels, [
    { name: 'bug', color: 'd0d7de' },
    { name: 'security', color: 'b60205' }
  ]);
  assert.deepEqual(summary.pullRequests[0].labels, [{ name: 'review', color: '0e8a16' }]);
});

test('mapRepositorySummary caps label scanning before reading oversized payloads', () => {
  const labels = Array.from({ length: MAX_LABELS_TO_SCAN + 1 }, () => null);
  Object.defineProperty(labels, MAX_LABELS_TO_SCAN, {
    get() {
      throw new Error('label scan exceeded limit');
    }
  });
  const summary = mapRepositorySummary(
    REPO,
    githubRepository(),
    [issue({ labels: labels as unknown as GitHubIssueResponse['labels'] })],
    [],
    [],
    { current: null, last7Days: null, last30Days: null }
  );

  assert.equal(summary.issues[0].labels.length, 0);
});

test('mapRepositorySummary bounds and sanitizes display strings from GitHub payloads', () => {
  const longTitle = 'x'.repeat(MAX_WORK_ITEM_TITLE_LENGTH + 10);
  const longSha = 'a'.repeat(MAX_DASHBOARD_TEXT_FIELD_LENGTH + 10);
  const longTimestamp = `${'2026-06-09T00:00:00Z'.padEnd(MAX_TIMESTAMP_TEXT_LENGTH + 10, 'x')}\nignored`;
  const summary = mapRepositorySummary(
    REPO,
    githubRepository({
      name: ' repo\x1b[31m\nname ',
      full_name: ' nullclaw\x1b[31m/nullbuilder\n ',
      description: '\x1b[31m\n\t',
      default_branch: ' main\nbranch ',
      language: ' Zig\x1b[2K ',
      pushed_at: longTimestamp,
      updated_at: longTimestamp,
      owner: { login: ' owner\nlogin ' }
    }),
    [
      issue({
        title: longTitle,
        user: { login: '\x1b[31m\n' },
        created_at: longTimestamp,
        updated_at: longTimestamp
      })
    ],
    [
      pull({
        title: '\x1b[31m\n',
        base: { ref: ' base\nbranch ' },
        head: { ref: ' feature\x1b[31mbranch ', sha: longSha, repo: { full_name: REPO } }
      })
    ],
    [
      workflowRun({
        name: ' CI\nworkflow ',
        path: '.github/workflows/ci.yml\nextra',
        display_title: '\x1b[31m\n',
        status: 'completed',
        conclusion: 'failure\nlater',
        head_branch: ' main\nbranch ',
        event: 'workflow_dispatch\nnow',
        created_at: longTimestamp,
        updated_at: longTimestamp
      })
    ],
    { current: null, last7Days: null, last30Days: null }
  );

  assert.equal(summary.owner, 'owner login');
  assert.equal(summary.name, 'repo name');
  assert.equal(summary.fullName, 'nullclaw/nullbuilder');
  assert.equal(summary.description, '');
  assert.equal(summary.defaultBranch, 'main branch');
  assert.equal(summary.language, 'Zig');
  assert.equal(summary.issues[0].title, 'x'.repeat(MAX_WORK_ITEM_TITLE_LENGTH));
  assert.equal(summary.issues[0].author, 'unknown');
  assert.equal(summary.pullRequests[0].title, 'Untitled PR');
  assert.equal(summary.pullRequests[0].baseBranch, 'base branch');
  assert.equal(summary.pullRequests[0].headBranch, 'featurebranch');
  assert.equal(summary.pullRequests[0].headSha.length, MAX_DASHBOARD_TEXT_FIELD_LENGTH);
  assert.equal(summary.latestRuns.ci?.name, 'CI workflow');
  assert.equal(summary.latestRuns.ci?.displayTitle, 'Workflow');
  assert.equal(summary.latestRuns.ci?.conclusion, 'failure');
  assert.equal(summary.latestRuns.ci?.branch, 'main branch');
  assert.equal(summary.latestRuns.ci?.event, 'workflow_dispatch now');
  assert.equal(summary.updatedAt, '');
  assert.equal(summary.issues[0].createdAt, '');
  assert.equal(summary.issues[0].updatedAt, '');
  assert.equal(summary.latestRuns.ci?.createdAt, '');
  assert.equal(summary.latestRuns.ci?.updatedAt, '');
});

test('mapRepositorySummary accepts only strict UTC timestamps from GitHub payloads', () => {
  const summary = mapRepositorySummary(
    REPO,
    githubRepository({
      pushed_at: '2026-06-08',
      updated_at: '2026-06-09T00:00:00+00:00'
    }),
    [
      issue({
        created_at: '2026-02-29T00:00:00Z',
        updated_at: '2026-06-09T00:00:00Z'
      })
    ],
    [
      pull({
        created_at: '2026-06-08T00:00:00Z',
        updated_at: '2026-06-09T00:00:00'
      })
    ],
    [
      workflowRun({
        created_at: '2026-06-08T00:00:00.123Z',
        updated_at: '2026-06-09 00:00:00'
      })
    ],
    { current: null, last7Days: null, last30Days: null }
  );

  assert.equal(summary.pushedAt, '');
  assert.equal(summary.updatedAt, '');
  assert.equal(summary.issues[0].createdAt, '');
  assert.equal(summary.issues[0].updatedAt, '2026-06-09T00:00:00Z');
  assert.equal(summary.pullRequests[0].createdAt, '2026-06-08T00:00:00Z');
  assert.equal(summary.pullRequests[0].updatedAt, '');
  assert.equal(summary.latestRuns.ci?.createdAt, '2026-06-08T00:00:00.123Z');
  assert.equal(summary.latestRuns.ci?.updatedAt, '');
});

test('mapRepositorySummary validates dashboard URLs from GitHub payloads', () => {
  const webBaseUrl = 'https://github.example.test';
  const repositoryUrl = `${webBaseUrl}/${REPO}`;
  const summary = mapRepositorySummary(
    REPO,
    githubRepository({
      html_url: 'https://evil.example/nullclaw/nullbuilder'
    }),
    [
      issue({
        number: 7,
        html_url: 'https://evil.example/nullclaw/nullbuilder/issues/7'
      }),
      issue({
        number: 8,
        html_url: 'https://user:pass@github.example.test/nullclaw/nullbuilder/issues/7'
      }),
      issue({
        number: 10,
        html_url: `${webBaseUrl}/other/repo/issues/10`
      })
    ],
    [
      pull({
        number: 9,
        html_url: `${repositoryUrl}/pull/9/${'x'.repeat(MAX_DASHBOARD_URL_LENGTH)}`
      })
    ],
    [
      workflowRun({
        html_url: `${webBaseUrl}/other/repo/actions/runs/1`
      }),
      workflowRun({
        id: 2,
        name: 'Nightly',
        path: '.github/workflows/nightly.yml',
        html_url: `${repositoryUrl}/actions/runs/2?check=true#summary`
      })
    ],
    { current: null, last7Days: null, last30Days: null },
    `${webBaseUrl}/`
  );

  assert.equal(summary.url, repositoryUrl);
  assert.deepEqual(
    summary.issues.map((item) => item.url),
    [`${repositoryUrl}/issues/7`, `${repositoryUrl}/issues/8`, `${repositoryUrl}/issues/10`]
  );
  assert.equal(summary.pullRequests[0].url, `${repositoryUrl}/pull/9`);
  assert.equal(summary.latestRuns.ci?.url, `${repositoryUrl}/actions`);
  assert.equal(summary.latestRuns.nightly?.url, `${repositoryUrl}/actions/runs/2?check=true#summary`);
});

test('mapRepositorySummary bounds workflow run scanning to one GitHub page', () => {
  const workflowRuns = [
    workflowRun({
      name: 'Unit Tests',
      path: '.github/workflows/build.yml',
      display_title: 'Unit Tests'
    }),
    ...Array.from({ length: MAX_WORKFLOW_RUNS_PER_REPOSITORY - 1 }, (_, index) =>
      workflowRun({
        id: index + 10,
        name: 'Docs',
        path: `.github/workflows/docs-${index}.yml`,
        display_title: 'Docs'
      })
    ),
    workflowRun({
      id: 999,
      name: 'Nightly',
      path: '.github/workflows/nightly.yml',
      display_title: 'Nightly'
    })
  ];

  const summary = mapRepositorySummary(
    REPO,
    githubRepository(),
    [],
    [],
    workflowRuns,
    { current: null, last7Days: null, last30Days: null }
  );

  assert.equal(summary.latestRuns.ci?.name, 'Unit Tests');
  assert.equal(summary.latestRuns.nightly, null);
  assert.equal(summary.latestRuns.release, null);
});

test('mapRepositorySummary selects newest matching workflow runs within the bounded page', () => {
  const summary = mapRepositorySummary(
    REPO,
    githubRepository(),
    [],
    [],
    [
      workflowRun({
        id: 1,
        name: 'CI',
        path: '.github/workflows/ci.yml',
        display_title: 'Older CI',
        updated_at: '2026-06-08T00:00:00Z'
      }),
      workflowRun({
        id: 2,
        name: 'Nightly',
        path: '.github/workflows/nightly.yml',
        display_title: 'Older Nightly',
        created_at: '2026-06-07T00:00:00Z',
        updated_at: 'not-a-date'
      }),
      workflowRun({
        id: 3,
        name: 'CI',
        path: '.github/workflows/ci.yml',
        display_title: 'Newer CI',
        updated_at: '2026-06-10T00:00:00Z'
      }),
      workflowRun({
        id: 4,
        name: 'Nightly',
        path: '.github/workflows/nightly.yml',
        display_title: 'Newer Nightly',
        created_at: '2026-06-09T00:00:00Z',
        updated_at: 'not-a-date'
      }),
      workflowRun({
        id: 5,
        name: 'Release',
        path: '.github/workflows/release.yml',
        display_title: 'First Release',
        updated_at: '2026-06-09T00:00:00Z'
      }),
      workflowRun({
        id: 6,
        name: 'Release',
        path: '.github/workflows/release.yml',
        display_title: 'Tie Release',
        updated_at: '2026-06-09T00:00:00Z'
      })
    ],
    { current: null, last7Days: null, last30Days: null }
  );

  assert.equal(summary.latestRuns.ci?.id, 3);
  assert.equal(summary.latestRuns.ci?.displayTitle, 'Newer CI');
  assert.equal(summary.latestRuns.nightly?.id, 4);
  assert.equal(summary.latestRuns.nightly?.displayTitle, 'Newer Nightly');
  assert.equal(summary.latestRuns.release?.id, 5);
  assert.equal(summary.latestRuns.release?.displayTitle, 'First Release');
});

test('workflow run classifier registry cannot be mutated by callers', () => {
  const entries = workflowRunClassifierEntries();

  assert.deepEqual(
    entries.map((entry) => [entry.slot, entry.nameKeywords.join(','), entry.pathKeywords.join(',')]),
    [
      ['ci', 'ci,test', 'ci.yml,zig-ci.yml'],
      ['nightly', 'nightly', 'nightly.yml,zig-nightly.yml'],
      ['release', 'release', 'release.yml,zig-release.yml']
    ]
  );

  assert.throws(() => {
    (entries as unknown as Array<(typeof entries)[number]>).push({
      slot: 'ci',
      nameKeywords: ['unsafe'],
      pathKeywords: ['unsafe.yml']
    });
  }, TypeError);

  assert.throws(() => {
    (entries[0] as { slot: string }).slot = 'release';
  }, TypeError);

  assert.throws(() => {
    (entries[0].nameKeywords as unknown as string[]).push('unsafe');
  }, TypeError);

  assert.throws(() => {
    (entries[0].pathKeywords as unknown as string[]).push('unsafe.yml');
  }, TypeError);

  const summary = mapRepositorySummary(
    REPO,
    githubRepository(),
    [],
    [],
    [
      workflowRun({
        id: 10,
        name: 'Unit Tests',
        path: '.github/workflows/build.yml',
        display_title: 'Test Suite',
        updated_at: '2026-06-10T00:00:00Z'
      }),
      workflowRun({
        id: 11,
        name: 'Docs',
        path: '.github/workflows/zig-nightly.yml',
        display_title: 'Nightly',
        updated_at: '2026-06-09T00:00:00Z'
      }),
      workflowRun({
        id: 12,
        name: 'Deploy',
        path: '.github/workflows/zig-release.yml',
        display_title: 'Release',
        updated_at: '2026-06-08T00:00:00Z'
      })
    ],
    { current: null, last7Days: null, last30Days: null }
  );

  assert.equal(summary.latestRuns.ci?.id, 10);
  assert.equal(summary.latestRuns.nightly?.id, 11);
  assert.equal(summary.latestRuns.release?.id, 12);
});

test('mapRepositorySummary matches workflow path keywords as full path segments only', () => {
  const spoofedOnly = mapRepositorySummary(
    REPO,
    githubRepository(),
    [],
    [],
    [
      workflowRun({
        id: 1,
        name: 'Docs',
        path: '.github/workflows/not-ci.yml',
        display_title: 'Not CI',
        updated_at: '2026-06-10T00:00:00Z'
      }),
      workflowRun({
        id: 2,
        name: 'Docs',
        path: '.github/workflows/ci.yml.bak',
        display_title: 'Backup CI',
        updated_at: '2026-06-09T00:00:00Z'
      })
    ],
    { current: null, last7Days: null, last30Days: null }
  );

  assert.equal(spoofedOnly.latestRuns.ci, null);

  const realPath = mapRepositorySummary(
    REPO,
    githubRepository(),
    [],
    [],
    [
      workflowRun({
        id: 3,
        name: 'Docs',
        path: '.github/workflows/ci.yml',
        display_title: 'Real CI',
        updated_at: '2026-06-08T00:00:00Z'
      })
    ],
    { current: null, last7Days: null, last30Days: null }
  );

  assert.equal(realPath.latestRuns.ci?.id, 3);
  assert.equal(realPath.latestRuns.ci?.displayTitle, 'Real CI');
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

test('mapRepositorySummary caps per-repository work rows without changing counts', () => {
  const issues = Array.from({ length: MAX_REPOSITORY_WORK_ITEMS + 2 }, (_, index) =>
    issue({
      number: index + 1,
      updated_at: new Date(Date.UTC(2026, 5, 9, 0, index)).toISOString()
    })
  );
  const pulls = Array.from({ length: MAX_REPOSITORY_WORK_ITEMS + 2 }, (_, index) =>
    pull({
      number: index + 1,
      updated_at: new Date(Date.UTC(2026, 5, 9, 0, index)).toISOString()
    })
  );
  const summary = mapRepositorySummary(
    REPO,
    githubRepository(),
    issues,
    pulls,
    [],
    { current: null, last7Days: null, last30Days: null }
  );

  assert.equal(summary.openIssues, MAX_REPOSITORY_WORK_ITEMS + 2);
  assert.equal(summary.openPulls, MAX_REPOSITORY_WORK_ITEMS + 2);
  assert.equal(summary.issues.length, MAX_REPOSITORY_WORK_ITEMS);
  assert.equal(summary.pullRequests.length, MAX_REPOSITORY_WORK_ITEMS);
  assert.deepEqual(summary.issues.slice(0, 3).map((item) => item.number), [
    MAX_REPOSITORY_WORK_ITEMS + 2,
    MAX_REPOSITORY_WORK_ITEMS + 1,
    MAX_REPOSITORY_WORK_ITEMS
  ]);
  assert.equal(summary.issues.at(-1)?.number, 3);
});

test('mapRepositorySummary caps work item scanning before reading oversized payloads', () => {
  const issues = Array.from({ length: MAX_REPOSITORY_WORK_ITEMS_TO_SCAN + 1 }, (_, index) =>
    issue({
      number: index + 1,
      updated_at: new Date(Date.UTC(2026, 5, 9, 0, index % 60)).toISOString()
    })
  );
  const pulls = Array.from({ length: MAX_REPOSITORY_WORK_ITEMS_TO_SCAN + 1 }, (_, index) =>
    pull({
      number: index + 1,
      updated_at: new Date(Date.UTC(2026, 5, 9, 0, index % 60)).toISOString()
    })
  );
  Object.defineProperty(issues, MAX_REPOSITORY_WORK_ITEMS_TO_SCAN, {
    get() {
      throw new Error('issue scan exceeded limit');
    }
  });
  Object.defineProperty(pulls, MAX_REPOSITORY_WORK_ITEMS_TO_SCAN, {
    get() {
      throw new Error('pull request scan exceeded limit');
    }
  });

  const summary = mapRepositorySummary(
    REPO,
    githubRepository(),
    issues,
    pulls,
    [],
    { current: null, last7Days: null, last30Days: null }
  );

  assert.equal(summary.openIssues, MAX_REPOSITORY_WORK_ITEMS_TO_SCAN);
  assert.equal(summary.openPulls, MAX_REPOSITORY_WORK_ITEMS_TO_SCAN);
  assert.equal(summary.issues.length, MAX_REPOSITORY_WORK_ITEMS);
  assert.equal(summary.pullRequests.length, MAX_REPOSITORY_WORK_ITEMS);
  assert.equal(summary.issues.some((item) => item.number === MAX_REPOSITORY_WORK_ITEMS_TO_SCAN + 1), false);
  assert.equal(summary.pullRequests.some((item) => item.number === MAX_REPOSITORY_WORK_ITEMS_TO_SCAN + 1), false);
});

test('mapRepositorySummary avoids global array iterators while mapping bounded GitHub payloads', () => {
  const issues = [
    issue({
      number: 7,
      labels: ['bug', { name: 'security', color: 'b60205' }],
      updated_at: '2026-06-09T00:00:00Z'
    })
  ];
  const pulls = [
    pull({
      number: 9,
      updated_at: '2026-06-08T00:00:00Z'
    })
  ];
  const workflowRuns = [
    workflowRun({
      id: 2,
      name: 'CI',
      path: '.github/workflows/ci.yml',
      updated_at: '2026-06-10T00:00:00Z'
    })
  ];
  const originalIterator = Array.prototype[Symbol.iterator];
  let summary: RepositorySummary | undefined;

  Array.prototype[Symbol.iterator] = function iteratorShouldNotBeCalled() {
    throw new Error('Array.prototype iterator should not be called');
  };

  try {
    summary = mapRepositorySummary(
      REPO,
      githubRepository(),
      issues,
      pulls,
      workflowRuns,
      { current: null, last7Days: null, last30Days: null }
    );
  } finally {
    Array.prototype[Symbol.iterator] = originalIterator;
  }

  assert.deepEqual(
    summary?.issues.map((item) => item.number),
    [7]
  );
  assert.deepEqual(
    summary?.pullRequests.map((item) => item.number),
    [9]
  );
  assert.equal(summary?.issues[0].labels.length, 2);
  assert.equal(summary?.latestRuns.ci?.id, 2);
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
        openIssues: 2,
        openPulls: 1,
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

test('buildDashboard avoids user-controlled repository iterators', () => {
  class UnsafeIteratorArray<T> extends Array<T> {
    override [Symbol.iterator](): ArrayIterator<T> {
      throw new Error('iterator should not be called');
    }
  }
  const config = readConfig({
    NULLBUILDER_REPOS: 'nullbuilder'
  });
  const issues = new UnsafeIteratorArray(
    workItem(1, '2026-06-08T00:00:00Z'),
    workItem(2, '2026-06-09T00:00:00Z')
  );
  const pullRequests = new UnsafeIteratorArray(pullRequestSummary(3, '2026-06-09T01:00:00Z'));
  const repositories = new UnsafeIteratorArray(
    repositorySummary({
      openIssues: 2,
      openPulls: 1,
      stars: 12,
      issues,
      pullRequests
    })
  );

  const dashboard = buildDashboard(config, config.repos, repositories, '2026-06-09T02:00:00Z');

  assert.deepEqual(
    dashboard.issues.map((item) => item.number),
    [2, 1]
  );
  assert.deepEqual(
    dashboard.pullRequests.map((item) => item.number),
    [3]
  );
  assert.deepEqual(dashboard.totals, {
    repositories: 1,
    loadedRepositories: 1,
    erroredRepositories: 0,
    issues: 2,
    pullRequests: 1,
    stars: 12,
    failingRuns: 0
  });
});

test('buildDashboard validates generated and error timestamps before emitting', () => {
  const config = readConfig({
    NULLBUILDER_REPOS: 'nullbuilder'
  });
  const dashboard = buildDashboard(
    config,
    config.repos,
    [],
    '2026-06-09T02:00:00Z\nhidden'
  );
  const validDashboard = buildDashboard(
    config,
    config.repos,
    [],
    '2026-06-09T02:00:00.123Z'
  );
  const errorRepo = makeErrorRepository(
    config,
    'nullclaw/nullbuilder' as RepoSlug,
    new Error('hidden'),
    '2026-06-09 02:00:00Z'
  );

  assert.equal(dashboard.generatedAt, '');
  assert.equal(validDashboard.generatedAt, '2026-06-09T02:00:00.123Z');
  assert.equal(errorRepo.updatedAt, '');
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

test('buildDashboard caps aggregated work lists without changing totals', () => {
  const config = readConfig({
    NULLBUILDER_REPOS: 'nullbuilder'
  });
  const issues = Array.from({ length: MAX_DASHBOARD_WORK_LIST_ITEMS + 2 }, (_, index) =>
    workItem(index + 1, '2026-06-09T00:00:00Z')
  );
  const pullRequests = Array.from({ length: MAX_DASHBOARD_WORK_LIST_ITEMS + 2 }, (_, index) =>
    pullRequestSummary(index + 1, '2026-06-09T00:00:00Z')
  );
  const dashboard = buildDashboard(config, config.repos, [
    repositorySummary({
      openIssues: MAX_DASHBOARD_WORK_LIST_ITEMS + 2,
      openPulls: MAX_DASHBOARD_WORK_LIST_ITEMS + 2,
      issues,
      pullRequests
    })
  ]);

  assert.equal(dashboard.issues.length, MAX_DASHBOARD_WORK_LIST_ITEMS);
  assert.equal(dashboard.pullRequests.length, MAX_DASHBOARD_WORK_LIST_ITEMS);
  assert.equal(dashboard.totals.issues, MAX_DASHBOARD_WORK_LIST_ITEMS + 2);
  assert.equal(dashboard.totals.pullRequests, MAX_DASHBOARD_WORK_LIST_ITEMS + 2);
  assert.deepEqual(
    dashboard.issues.map((item) => item.number),
    Array.from({ length: MAX_DASHBOARD_WORK_LIST_ITEMS }, (_, index) => index + 1)
  );
});

test('buildDashboard counts failures only from known latest run slots', () => {
  const config = readConfig({
    NULLBUILDER_REPOS: 'nullbuilder'
  });
  const latestRuns = {
    ci: null,
    nightly: null,
    release: null,
    injected: workflowSummary({ status: 'completed', conclusion: 'failure' })
  } as RepositorySummary['latestRuns'];
  const dashboard = buildDashboard(config, config.repos, [repositorySummary({ latestRuns })]);

  assert.equal(dashboard.totals.failingRuns, 0);
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
