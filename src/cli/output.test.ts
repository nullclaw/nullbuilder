import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import type { AuditFinding, AuditReport } from '../lib/server/audit';
import { GitHubApiError, type BuildPrResult, type DashboardData, type ReleaseTagResult } from '../lib/server/github';
import {
  auditExitCode,
  formatAuditReport,
  formatBuildPrResult,
  formatCliError,
  formatDashboard,
  formatReleaseTagResult,
  formatRepositoryErrors,
  readErrorExitCode,
  selectDashboardJson
} from './output';

test('selectDashboardJson returns command-specific rows and load errors', () => {
  const dashboard = dashboardFixture();

  assert.deepEqual(selectDashboardJson('issues', dashboard), {
    items: dashboard.issues,
    errors: [{ repo: 'nullclaw/broken', error: 'GitHub repository or resource was not found.' }]
  });
  assert.deepEqual(selectDashboardJson('repos', dashboard), {
    items: dashboard.repositories,
    errors: [{ repo: 'nullclaw/broken', error: 'GitHub repository or resource was not found.' }]
  });
});

test('formatDashboard keeps read-error empty states explicit', () => {
  const dashboard = dashboardFixture({
    issues: [],
    hasReadErrors: true
  });

  assert.equal(
    formatDashboard('issues', dashboard),
    'No issue rows from loaded repositories. Some repositories failed to load.'
  );
  assert.match(formatDashboard('repos', dashboard), /nullclaw\/nullbuilder/);
});

test('formatRepositoryErrors and exit code helpers keep CLI policy pure', () => {
  const dashboard = dashboardFixture();

  assert.equal(formatRepositoryErrors(dashboard), 'nullclaw/broken: GitHub repository or resource was not found.');
  assert.equal(readErrorExitCode(dashboard), 2);
  assert.equal(readErrorExitCode(dashboardFixture({ hasReadErrors: false })), null);
  assert.equal(auditExitCode(auditReportFixture({ hasReadErrors: true })), 2);
  assert.equal(auditExitCode(auditReportFixture()), 3);
  assert.equal(auditExitCode(auditReportFixture({ findings: [] })), null);
});

test('formatBuildPrResult and formatReleaseTagResult preserve tag command output', () => {
  assert.equal(
    formatBuildPrResult(buildPrResultFixture({ dryRun: true })),
    [
      'Dry run build-pr-7-de0fac2',
      'repo: nullclaw/nullbuilder',
      'pr: #7 Improve build',
      'head: de0fac2e4500dabe0009e67214ff5f5447ce83dd (feature)',
      'tag: https://github.example.test/nullclaw/nullbuilder/releases/tag/build-pr-7-de0fac2',
      'runs: https://github.example.test/nullclaw/nullbuilder/actions?query=branch%3Abuild-pr-7-de0fac2',
      'pass --confirm to create the tag'
    ].join('\n')
  );

  assert.match(formatReleaseTagResult(releaseTagResultFixture({ forced: true })), /^Moved tag v1\.2\.3\n/);
});

test('formatters sanitize terminal control characters from external text', () => {
  const dashboard = dashboardFixture({
    issues: [
      {
        ...dashboardFixture().issues[0],
        title: 'Fix \x1b[31mred\x1b[0m\nnext\titem'
      }
    ]
  });
  const issues = formatDashboard('issues', dashboard);
  const buildPr = formatBuildPrResult(
    buildPrResultFixture({
      prTitle: 'Improve \x1b]0;title\x07build\rnow',
      headBranch: 'feature\x1b[2Kbranch'
    })
  );

  assert.doesNotMatch(issues, /\x1b/);
  assert.match(issues, /Fix red next item/);
  assert.doesNotMatch(buildPr, /\x1b/);
  assert.match(buildPr, /pr: #7 Improve build now/);
  assert.match(buildPr, /head: de0fac2e4500dabe0009e67214ff5f5447ce83dd \(featurebranch\)/);
});

test('formatAuditReport includes per-repository counts and finding details', () => {
  const output = formatAuditReport(auditReportFixture());

  assert.match(output, /repo\s+state\s+score\s+critical/);
  assert.match(output, /nullclaw\/nullbuilder\s+ok\s+65\s+1/);
  assert.match(output, /\[critical\] nullclaw\/nullbuilder: Mutable workflow ref/);
  assert.match(output, /Pin reusable workflows to immutable SHAs\./);
});

test('formatCliError redacts GitHub authorization details', () => {
  assert.equal(
    formatCliError(new GitHubApiError('GitHub 403 Forbidden: token leaked in upstream message', 403)),
    'GitHub API authorization or rate-limit error (403).'
  );
  assert.equal(formatCliError(new Error('Invalid tag name.')), 'Invalid tag name.');
});

function dashboardFixture(overrides: Partial<DashboardData> = {}): DashboardData {
  const dashboard: DashboardData = {
    generatedAt: '2026-06-01T00:00:00Z',
    hasToken: true,
    owner: 'nullclaw',
    repos: ['nullclaw/nullbuilder', 'nullclaw/broken'],
    repositories: [
      {
        slug: 'nullclaw/nullbuilder',
        owner: 'nullclaw',
        name: 'nullbuilder',
        fullName: 'nullclaw/nullbuilder',
        url: 'https://github.example.test/nullclaw/nullbuilder',
        description: 'Command center',
        defaultBranch: 'main',
        language: 'Zig',
        isPrivate: false,
        archived: false,
        stars: 10,
        forks: 1,
        openIssues: 1,
        openPulls: 1,
        pushedAt: '2026-06-01T00:00:00Z',
        updatedAt: '2026-06-01T00:00:00Z',
        issues: [
          {
            repo: 'nullclaw/nullbuilder',
            number: 3,
            title: 'Fix audit',
            url: 'https://github.example.test/nullclaw/nullbuilder/issues/3',
            author: 'octo',
            labels: [],
            comments: 0,
            createdAt: '2026-06-01T00:00:00Z',
            updatedAt: '2026-06-02T00:00:00Z'
          }
        ],
        pullRequests: [
          {
            repo: 'nullclaw/nullbuilder',
            number: 7,
            title: 'Improve build',
            url: 'https://github.example.test/nullclaw/nullbuilder/pull/7',
            author: 'octo',
            labels: [],
            comments: 0,
            createdAt: '2026-06-01T00:00:00Z',
            updatedAt: '2026-06-02T00:00:00Z',
            draft: false,
            baseBranch: 'main',
            headBranch: 'feature',
            headSha: 'de0fac2e4500dabe0009e67214ff5f5447ce83dd'
          }
        ],
        starGrowth: {
          current: 10,
          last7Days: 1,
          last30Days: 2
        },
        latestRuns: {
          ci: {
            id: 1,
            name: 'CI',
            path: '.github/workflows/ci.yml',
            displayTitle: 'CI',
            status: 'completed',
            conclusion: 'success',
            url: 'https://github.example.test/nullclaw/nullbuilder/actions/runs/1',
            branch: 'main',
            event: 'push',
            createdAt: '2026-06-01T00:00:00Z',
            updatedAt: '2026-06-01T00:00:00Z'
          },
          nightly: null,
          release: null
        },
        status: 'ok'
      },
      {
        slug: 'nullclaw/broken',
        owner: 'nullclaw',
        name: 'broken',
        fullName: 'nullclaw/broken',
        url: 'https://github.example.test/nullclaw/broken',
        description: '',
        defaultBranch: 'unknown',
        language: null,
        isPrivate: false,
        archived: false,
        stars: null,
        forks: null,
        openIssues: null,
        openPulls: null,
        pushedAt: null,
        updatedAt: '2026-06-01T00:00:00Z',
        issues: [],
        pullRequests: [],
        starGrowth: {
          current: null,
          last7Days: null,
          last30Days: null
        },
        latestRuns: {
          ci: null,
          nightly: null,
          release: null
        },
        status: 'error',
        error: 'GitHub repository or resource was not found.'
      }
    ],
    issues: [],
    pullRequests: [],
    hasReadErrors: true,
    totals: {
      repositories: 2,
      loadedRepositories: 1,
      erroredRepositories: 1,
      issues: 1,
      pullRequests: 1,
      stars: 10,
      failingRuns: 0
    },
    ...overrides
  };

  dashboard.issues = overrides.issues ?? dashboard.repositories.flatMap((repo) => repo.issues);
  dashboard.pullRequests = overrides.pullRequests ?? dashboard.repositories.flatMap((repo) => repo.pullRequests);
  return dashboard;
}

function buildPrResultFixture(overrides: Partial<BuildPrResult> = {}): BuildPrResult {
  return {
    repo: 'nullclaw/nullbuilder',
    prNumber: 7,
    prTitle: 'Improve build',
    headSha: 'de0fac2e4500dabe0009e67214ff5f5447ce83dd',
    headBranch: 'feature',
    tagName: 'build-pr-7-de0fac2',
    tagUrl: 'https://github.example.test/nullclaw/nullbuilder/releases/tag/build-pr-7-de0fac2',
    workflowUrl: 'https://github.example.test/nullclaw/nullbuilder/actions?query=branch%3Abuild-pr-7-de0fac2',
    workflowTagPattern: 'build-pr-*',
    dryRun: false,
    created: true,
    forced: false,
    ...overrides
  };
}

function releaseTagResultFixture(overrides: Partial<ReleaseTagResult> = {}): ReleaseTagResult {
  return {
    repo: 'nullclaw/nullbuilder',
    tagName: 'v1.2.3',
    targetRef: 'main',
    targetSha: 'de0fac2e4500dabe0009e67214ff5f5447ce83dd',
    tagUrl: 'https://github.example.test/nullclaw/nullbuilder/releases/tag/v1.2.3',
    workflowUrl: 'https://github.example.test/nullclaw/nullbuilder/actions?query=branch%3Av1.2.3',
    workflowTagPattern: 'v*',
    dryRun: false,
    created: false,
    forced: false,
    ...overrides
  };
}

function auditReportFixture(
  overrides: Partial<AuditReport> & { findings?: AuditFinding[] } = {}
): AuditReport {
  const findings = overrides.findings ?? [
    {
      id: 'nullclaw/nullbuilder:workflow-ref:critical:Mutable workflow ref',
      ruleId: 'workflow-ref',
      repo: 'nullclaw/nullbuilder',
      severity: 'critical',
      area: 'workflow',
      title: 'Mutable workflow ref',
      detail: 'Pin reusable workflows to immutable SHAs.',
      url: 'https://github.example.test/nullclaw/nullbuilder/actions',
      path: '.github/workflows/ci.yml'
    }
  ];

  return {
    generatedAt: '2026-06-01T00:00:00Z',
    hasToken: true,
    owner: 'nullclaw',
    repos: ['nullclaw/nullbuilder'],
    repositories: [
      {
        repo: 'nullclaw/nullbuilder',
        url: 'https://github.example.test/nullclaw/nullbuilder',
        defaultBranch: 'main',
        status: 'ok',
        score: findings.length > 0 ? 65 : 100,
        checks: [],
        findings
      }
    ],
    findings,
    hasReadErrors: false,
    totals: {
      repositories: 1,
      loadedRepositories: 1,
      erroredRepositories: 0,
      critical: findings.filter((finding) => finding.severity === 'critical').length,
      warning: findings.filter((finding) => finding.severity === 'warning').length,
      info: findings.filter((finding) => finding.severity === 'info').length,
      findings: findings.length,
      averageScore: findings.length > 0 ? 65 : 100
    },
    ...overrides
  };
}
