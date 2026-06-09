import { normalizeRepoSlug, type RepoSlug } from '../repositories';
import type { NullbuilderConfig } from './config';
import {
  decodeGitHubContent,
  encodeGitHubPath,
  findActionUses,
  findNullbuilderWorkflowRefs,
  isMutableRef,
  shouldRequireShaPin
} from './audit-workflows';
import { mapWithConcurrency } from './concurrency';
import { discoverRepositories, GitHubApiError, githubGet, publicErrorMessage } from './github';

export type AuditSeverity = 'critical' | 'warning' | 'info';
export type AuditArea = 'repository' | 'security' | 'workflow' | 'release';
export type AuditStatus = 'ok' | AuditSeverity;

export type AuditFinding = {
  id: string;
  ruleId: string;
  repo: RepoSlug;
  severity: AuditSeverity;
  area: AuditArea;
  title: string;
  detail: string;
  url?: string;
  path?: string;
};

export type AuditCheckResult = {
  id: string;
  title: string;
  area: AuditArea;
  status: AuditStatus;
  findings: AuditFinding[];
};

export type AuditRepositoryResult = {
  repo: RepoSlug;
  url: string;
  defaultBranch: string;
  status: 'ok' | 'error';
  score: number;
  checks: AuditCheckResult[];
  findings: AuditFinding[];
  error?: string;
};

export type AuditReport = {
  generatedAt: string;
  hasToken: boolean;
  owner: string;
  repos: RepoSlug[];
  repositories: AuditRepositoryResult[];
  findings: AuditFinding[];
  hasReadErrors: boolean;
  totals: {
    repositories: number;
    loadedRepositories: number;
    erroredRepositories: number;
    critical: number;
    warning: number;
    info: number;
    findings: number;
    averageScore: number;
  };
};

type GitHubRepositoryResponse = {
  full_name: string;
  html_url: string;
  default_branch: string;
  private: boolean;
  archived: boolean;
};

type GitHubContentItem = {
  name: string;
  path: string;
  type: string;
  html_url: string;
};

type GitHubContentFile = GitHubContentItem & {
  content?: string;
  encoding?: string;
};

type GitHubBranchProtection = {
  required_status_checks?: unknown | null;
  required_pull_request_reviews?: unknown | null;
  enforce_admins?: {
    enabled?: boolean;
  } | null;
};

type Probe<T> =
  | { status: 'present'; data: T }
  | { status: 'missing' }
  | { status: 'denied' }
  | { status: 'error'; error: string };

type WorkflowFile = {
  name: string;
  path: string;
  url: string;
  content: string;
};

type AuditContext = {
  repo: RepoSlug;
  repository: GitHubRepositoryResponse;
  workflowDirectory: Probe<GitHubContentItem[]>;
  workflowFiles: WorkflowFile[];
  branchProtection: Probe<GitHubBranchProtection>;
  dependabot: Probe<GitHubContentFile>;
  securityPolicy: Probe<GitHubContentFile>;
  githubSecurityPolicy: Probe<GitHubContentFile>;
  codeowners: Probe<GitHubContentFile>;
  githubCodeowners: Probe<GitHubContentFile>;
};

type AuditRule = {
  id: string;
  title: string;
  area: AuditArea;
  evaluate: (context: AuditContext) => AuditFinding[];
};

const NULLBUILDER_WORKFLOWS = [
  { id: 'ci', file: 'zig-ci.yml', severity: 'warning' as const },
  { id: 'nightly', file: 'zig-nightly.yml', severity: 'info' as const },
  { id: 'release', file: 'zig-release.yml', severity: 'info' as const }
];

const RULES: AuditRule[] = [
  {
    id: 'repository-active',
    title: 'Repository is active',
    area: 'repository',
    evaluate: (context) => {
      if (!context.repository.archived) {
        return [];
      }

      return [
        finding(context, 'repository-active', 'warning', 'Archived repository', 'Archived repositories are skipped by most operational workflows.')
      ];
    }
  },
  {
    id: 'security-policy',
    title: 'Security policy exists',
    area: 'security',
    evaluate: (context) => {
      if (isPresent(context.securityPolicy) || isPresent(context.githubSecurityPolicy)) {
        return [];
      }

      return [
        finding(context, 'security-policy', 'warning', 'Missing security policy', 'Add SECURITY.md so vulnerability reports have a stable intake path.')
      ];
    }
  },
  {
    id: 'dependabot',
    title: 'Dependabot configuration exists',
    area: 'security',
    evaluate: (context) => {
      if (isPresent(context.dependabot)) {
        return [];
      }

      return [
        finding(context, 'dependabot', 'warning', 'Missing Dependabot configuration', 'Add .github/dependabot.yml to keep actions and package dependencies current.')
      ];
    }
  },
  {
    id: 'codeowners',
    title: 'Code owners exist',
    area: 'security',
    evaluate: (context) => {
      if (isPresent(context.codeowners) || isPresent(context.githubCodeowners)) {
        return [];
      }

      return [
        finding(context, 'codeowners', 'info', 'Missing CODEOWNERS', 'Add CODEOWNERS when review ownership should be enforceable instead of implicit.')
      ];
    }
  },
  {
    id: 'branch-protection',
    title: 'Default branch is protected',
    area: 'security',
    evaluate: (context) => {
      if (context.branchProtection.status === 'present') {
        const findings: AuditFinding[] = [];
        const protection = context.branchProtection.data;

        if (!protection.required_status_checks) {
          findings.push(
            finding(
              context,
              'branch-protection',
              'warning',
              'Default branch has no required status checks',
              `Require CI checks before merging into ${context.repository.default_branch}.`
            )
          );
        }

        if (!protection.required_pull_request_reviews) {
          findings.push(
            finding(
              context,
              'branch-protection',
              'info',
              'Default branch has no required reviews',
              `Require pull request reviews before merging into ${context.repository.default_branch} when the repository is collaborative.`
            )
          );
        }

        return findings;
      }

      if (context.branchProtection.status === 'missing') {
        return [
          finding(
            context,
            'branch-protection',
            'warning',
            'Default branch protection was not found',
            `Protect ${context.repository.default_branch} with required checks before broad automation writes to this repository.`
          )
        ];
      }

      return [
        finding(
          context,
          'branch-protection',
          'info',
          'Default branch protection could not be verified',
          'GitHub did not allow reading branch protection with the current token.'
        )
      ];
    }
  },
  {
    id: 'nullbuilder-workflows',
    title: 'Nullbuilder workflows are installed',
    area: 'workflow',
    evaluate: (context) => {
      if (context.workflowDirectory.status !== 'present') {
        return [
          finding(
            context,
            'nullbuilder-workflows',
            'warning',
            'Workflow directory is missing or unreadable',
            'Add .github/workflows entries for reusable nullbuilder CI and release automation.'
          )
        ];
      }

      return NULLBUILDER_WORKFLOWS.flatMap((workflow) => {
        const hasWorkflow = context.workflowFiles.some((file) =>
          file.content.includes(`nullclaw/nullbuilder/.github/workflows/${workflow.file}@`)
        );

        if (hasWorkflow) {
          return [];
        }

        return [
          finding(
            context,
            'nullbuilder-workflows',
            workflow.severity,
            `Missing nullbuilder ${workflow.id} workflow`,
            `Add a reusable workflow caller for ${workflow.file} when this repository should share nullbuilder automation.`
          )
        ];
      });
    }
  },
  {
    id: 'workflow-dangerous-triggers',
    title: 'Workflows avoid dangerous triggers',
    area: 'workflow',
    evaluate: (context) => {
      return context.workflowFiles.flatMap((file) => {
        if (!/\bpull_request_target\b/.test(file.content)) {
          return [];
        }

        return [
          finding(
            context,
            'workflow-dangerous-triggers',
            'critical',
            'Workflow uses pull_request_target',
            `${file.path} can expose write-scoped tokens to untrusted pull request code unless every checkout and script path is locked down.`,
            file.url,
            file.path
          )
        ];
      });
    }
  },
  {
    id: 'workflow-permissions',
    title: 'Workflow token permissions are explicit',
    area: 'workflow',
    evaluate: (context) => {
      return context.workflowFiles.flatMap((file) => {
        const findings: AuditFinding[] = [];

        if (/^\s*permissions:\s*write-all\s*$/m.test(file.content)) {
          findings.push(
            finding(
              context,
              'workflow-permissions',
              'critical',
              'Workflow grants write-all permissions',
              `${file.path} should grant only the token scopes required by each job.`,
              file.url,
              file.path
            )
          );
        } else if (!/^\s*permissions:/m.test(file.content)) {
          findings.push(
            finding(
              context,
              'workflow-permissions',
              'warning',
              'Workflow token permissions are implicit',
              `${file.path} should declare top-level or job-level permissions explicitly.`,
              file.url,
              file.path
            )
          );
        }

        if (/\bself-hosted\b/.test(file.content)) {
          findings.push(
            finding(
              context,
              'workflow-permissions',
              'warning',
              'Workflow uses self-hosted runners',
              `${file.path} should treat self-hosted runners as privileged infrastructure and restrict untrusted events.`,
              file.url,
              file.path
            )
          );
        }

        return findings;
      });
    }
  },
  {
    id: 'workflow-pinning',
    title: 'Third-party workflow actions are pinned',
    area: 'workflow',
    evaluate: (context) => {
      return context.workflowFiles.flatMap((file) => {
        const findings: AuditFinding[] = [];
        const usesLines = findActionUses(file.content);

        for (const action of usesLines) {
          if (!shouldRequireShaPin(action.target, action.ref)) {
            continue;
          }

          findings.push(
            finding(
              context,
              'workflow-pinning',
              'warning',
              'Workflow action is not pinned to a commit SHA',
              `${file.path} uses ${action.target}@${action.ref}; pin third-party actions to immutable commits for stronger supply-chain guarantees.`,
              file.url,
              file.path
            )
          );
        }

        return findings.slice(0, 5);
      });
    }
  },
  {
    id: 'nullbuilder-workflow-ref',
    title: 'Nullbuilder workflow references are stable',
    area: 'release',
    evaluate: (context) => {
      return context.workflowFiles.flatMap((file) => {
        const findings: AuditFinding[] = [];
        const references = findNullbuilderWorkflowRefs(file.content);

        for (const reference of references) {
          if (!isMutableRef(reference.ref)) {
            continue;
          }

          findings.push(
            finding(
              context,
              'nullbuilder-workflow-ref',
              'warning',
              'Reusable workflow uses a mutable ref',
              `${file.path} references ${reference.workflow}@${reference.ref}; use a release tag for predictable cross-repository behavior.`,
              file.url,
              file.path
            )
          );
        }

        return findings;
      });
    }
  }
];

export async function getAuditReport(config: NullbuilderConfig): Promise<AuditReport> {
  const repoList = config.discoverRepos ? await discoverRepositories(config) : config.repos;
  const repositories = await mapWithConcurrency(repoList, config.concurrency, (repo) => auditRepository(config, repo));
  const loadedRepositories = repositories.filter((repo) => repo.status === 'ok');
  const findings = repositories.flatMap((repo) => repo.findings).sort(sortFindings);
  const counts = countFindings(findings);
  const averageScore =
    loadedRepositories.length === 0
      ? 0
      : Math.round(loadedRepositories.reduce((total, repo) => total + repo.score, 0) / loadedRepositories.length);

  return {
    generatedAt: new Date().toISOString(),
    hasToken: Boolean(config.token),
    owner: config.owner,
    repos: repoList,
    repositories,
    findings,
    hasReadErrors: repositories.some((repo) => repo.status === 'error'),
    totals: {
      repositories: repositories.length,
      loadedRepositories: loadedRepositories.length,
      erroredRepositories: repositories.length - loadedRepositories.length,
      critical: counts.critical,
      warning: counts.warning,
      info: counts.info,
      findings: findings.length,
      averageScore
    }
  };
}

async function auditRepository(config: NullbuilderConfig, repo: RepoSlug): Promise<AuditRepositoryResult> {
  try {
    const normalizedRepo = normalizeRepoSlug(repo, config.owner);
    const repository = await githubGet<GitHubRepositoryResponse>(config, `/repos/${normalizedRepo}`);
    const workflowDirectory = await probeGitHub<GitHubContentItem[]>(
      config,
      `/repos/${normalizedRepo}/contents/.github/workflows`
    );
    const [
      workflowFiles,
      branchProtection,
      dependabot,
      securityPolicy,
      githubSecurityPolicy,
      codeowners,
      githubCodeowners
    ] = await Promise.all([
      loadWorkflowFiles(config, normalizedRepo, workflowDirectory),
      probeGitHub<GitHubBranchProtection>(
        config,
        `/repos/${normalizedRepo}/branches/${encodeURIComponent(repository.default_branch)}/protection`
      ),
      probeGitHub<GitHubContentFile>(config, `/repos/${normalizedRepo}/contents/.github/dependabot.yml`),
      probeGitHub<GitHubContentFile>(config, `/repos/${normalizedRepo}/contents/SECURITY.md`),
      probeGitHub<GitHubContentFile>(config, `/repos/${normalizedRepo}/contents/.github/SECURITY.md`),
      probeGitHub<GitHubContentFile>(config, `/repos/${normalizedRepo}/contents/CODEOWNERS`),
      probeGitHub<GitHubContentFile>(config, `/repos/${normalizedRepo}/contents/.github/CODEOWNERS`)
    ]);
    const context: AuditContext = {
      repo: normalizedRepo,
      repository,
      workflowDirectory,
      workflowFiles,
      branchProtection,
      dependabot,
      securityPolicy,
      githubSecurityPolicy,
      codeowners,
      githubCodeowners
    };
    const checks = RULES.map((rule) => {
      const findings = rule.evaluate(context);
      return {
        id: rule.id,
        title: rule.title,
        area: rule.area,
        status: checkStatus(findings),
        findings
      };
    });
    const findings = checks.flatMap((check) => check.findings).sort(sortFindings);

    return {
      repo: normalizedRepo,
      url: repository.html_url,
      defaultBranch: repository.default_branch,
      status: 'ok',
      score: scoreFindings(findings),
      checks,
      findings
    };
  } catch (error) {
    const normalizedRepo = normalizeRepoSlug(repo, config.owner);

    return {
      repo: normalizedRepo,
      url: `${config.webBaseUrl}/${normalizedRepo}`,
      defaultBranch: 'unknown',
      status: 'error',
      score: 0,
      checks: [],
      findings: [],
      error: publicErrorMessage(error)
    };
  }
}

async function loadWorkflowFiles(
  config: NullbuilderConfig,
  repo: RepoSlug,
  workflowDirectory: Probe<GitHubContentItem[]>
): Promise<WorkflowFile[]> {
  if (!isPresent(workflowDirectory) || !Array.isArray(workflowDirectory.data)) {
    return [];
  }

  const workflowItems = workflowDirectory.data.filter(
    (item) => item.type === 'file' && /\.(?:ya?ml)$/i.test(item.name)
  );

  return (
    await mapWithConcurrency(workflowItems.slice(0, 50), Math.min(config.concurrency, 4), async (item) => {
      const file = await probeGitHub<GitHubContentFile>(
        config,
        `/repos/${repo}/contents/${encodeGitHubPath(item.path)}`
      );

      if (!isPresent(file)) {
        return null;
      }

      return {
        name: item.name,
        path: item.path,
        url: item.html_url,
        content: decodeGitHubContent(file.data)
      };
    })
  ).filter((file): file is WorkflowFile => file !== null);
}

async function probeGitHub<T>(config: NullbuilderConfig, path: string): Promise<Probe<T>> {
  try {
    return {
      status: 'present',
      data: await githubGet<T>(config, path)
    };
  } catch (error) {
    if (error instanceof GitHubApiError) {
      if (error.status === 404) {
        return { status: 'missing' };
      }
      if (error.status === 403) {
        return { status: 'denied' };
      }
    }

    return {
      status: 'error',
      error: publicErrorMessage(error)
    };
  }
}

function finding(
  context: AuditContext,
  ruleId: string,
  severity: AuditSeverity,
  title: string,
  detail: string,
  url?: string,
  path?: string
): AuditFinding {
  const pathPart = path ? `:${path}` : '';
  return {
    id: `${context.repo}:${ruleId}:${severity}:${title}${pathPart}`,
    ruleId,
    repo: context.repo,
    severity,
    area: RULES.find((rule) => rule.id === ruleId)?.area ?? 'repository',
    title,
    detail,
    url,
    path
  };
}

function isPresent<T>(probe: Probe<T>): probe is { status: 'present'; data: T } {
  return probe.status === 'present';
}

function checkStatus(findings: AuditFinding[]): AuditStatus {
  if (findings.some((finding) => finding.severity === 'critical')) {
    return 'critical';
  }
  if (findings.some((finding) => finding.severity === 'warning')) {
    return 'warning';
  }
  if (findings.some((finding) => finding.severity === 'info')) {
    return 'info';
  }
  return 'ok';
}

function scoreFindings(findings: AuditFinding[]): number {
  const penalty = findings.reduce((total, finding) => {
    if (finding.severity === 'critical') {
      return total + 35;
    }
    if (finding.severity === 'warning') {
      return total + 15;
    }
    return total + 5;
  }, 0);

  return Math.max(0, 100 - penalty);
}

function countFindings(findings: AuditFinding[]): Record<AuditSeverity, number> {
  return findings.reduce(
    (counts, finding) => {
      counts[finding.severity] += 1;
      return counts;
    },
    { critical: 0, warning: 0, info: 0 }
  );
}

function sortFindings(left: AuditFinding, right: AuditFinding): number {
  const severityOrder: Record<AuditSeverity, number> = {
    critical: 0,
    warning: 1,
    info: 2
  };

  return (
    severityOrder[left.severity] - severityOrder[right.severity] ||
    left.repo.localeCompare(right.repo) ||
    left.title.localeCompare(right.title)
  );
}
