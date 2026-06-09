import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import type { AuditFinding, AuditReport } from '../lib/server/audit';
import { readConfig, type NullbuilderConfig } from '../lib/server/config';
import type { BuildPrResult, DashboardData } from '../lib/server/github';
import { HELP } from './options';
import { runCli, type CliDependencies } from './runner';

test('runCli returns help without reading config', async () => {
  const result = await runCli(
    ['--help'],
    testDependencies({
      readConfig: () => unexpectedCall('readConfig')
    })
  );

  assert.deepEqual(result, {
    stdout: [HELP],
    stderr: [],
    exitCode: null
  });
});

test('runCli dispatches build-pr with parsed mutation flags', async () => {
  const capturedConfigs: NullbuilderConfig[] = [];
  const capturedOptions: Array<Parameters<CliDependencies['buildPrTag']>[1]> = [];
  const result = await runCli(
    [
      'build-pr',
      'nullbuilder',
      '--pr',
      '7',
      '--tag',
      'build-pr-7',
      '--json',
      '--confirm',
      '--force',
      '--allow-draft',
      '--allow-fork',
      '--allow-non-default-base'
    ],
    testDependencies({
      buildPrTag: async (config, options) => {
        capturedConfigs.push(config);
        capturedOptions.push(options);
        return buildPrResultFixture();
      }
    })
  );

  assert.equal(capturedConfigs[0]?.owner, 'nullclaw');
  assert.deepEqual(capturedOptions[0], {
    repo: 'nullbuilder',
    prNumber: 7,
    tagName: 'build-pr-7',
    confirm: true,
    force: true,
    allowDraft: true,
    allowFork: true,
    allowNonDefaultBase: true
  });
  assert.deepEqual(JSON.parse(result.stdout[0]), buildPrResultFixture());
  assert.deepEqual(result.stderr, []);
  assert.equal(result.exitCode, null);
});

test('runCli applies repository filters and preserves read-error policy', async () => {
  const capturedConfigs: NullbuilderConfig[] = [];
  const result = await runCli(
    ['repos', '--repo', 'nullbuilder'],
    testDependencies({
      getDashboard: async (config) => {
        capturedConfigs.push(config);
        return dashboardFixture();
      }
    })
  );

  assert.deepEqual(capturedConfigs[0]?.repos, ['nullclaw/nullbuilder']);
  assert.match(result.stdout[0], /nullclaw\/nullbuilder/);
  assert.deepEqual(result.stderr, ['nullclaw/broken: GitHub repository or resource was not found.']);
  assert.equal(result.exitCode, 2);
});

test('runCli returns audit JSON with audit exit policy', async () => {
  const result = await runCli(
    ['audit', '--json'],
    testDependencies({
      getAuditReport: async () => auditReportFixture()
    })
  );

  assert.equal(JSON.parse(result.stdout[0]).totals.critical, 1);
  assert.deepEqual(result.stderr, []);
  assert.equal(result.exitCode, 3);
});

function testDependencies(overrides: Partial<CliDependencies> = {}): CliDependencies {
  return {
    readConfig: () => readConfig({ NULLBUILDER_REPOS: 'nullbuilder' }),
    getDashboard: async () => unexpectedCall('getDashboard'),
    getAuditReport: async () => unexpectedCall('getAuditReport'),
    buildPrTag: async () => unexpectedCall('buildPrTag'),
    createReleaseTag: async () => unexpectedCall('createReleaseTag'),
    ...overrides
  };
}

function unexpectedCall(name: string): never {
  throw new Error(`Unexpected ${name} call.`);
}

function dashboardFixture(overrides: Partial<DashboardData> = {}): DashboardData {
  const repositories: DashboardData['repositories'] = [
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
      openPulls: 0,
      pushedAt: '2026-06-01T00:00:00Z',
      updatedAt: '2026-06-01T00:00:00Z',
      issues: [],
      pullRequests: [],
      starGrowth: {
        current: 10,
        last7Days: 1,
        last30Days: 2
      },
      latestRuns: {
        ci: null,
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
  ];

  return {
    generatedAt: '2026-06-01T00:00:00Z',
    hasToken: true,
    owner: 'nullclaw',
    repos: repositories.map((repo) => repo.slug),
    repositories,
    issues: [],
    pullRequests: [],
    hasReadErrors: true,
    totals: {
      repositories: 2,
      loadedRepositories: 1,
      erroredRepositories: 1,
      issues: 0,
      pullRequests: 0,
      stars: 10,
      failingRuns: 0
    },
    ...overrides
  };
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
