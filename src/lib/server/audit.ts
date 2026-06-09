import { normalizeRepoSlug, type RepoSlug } from '../repositories';
import type { NullbuilderConfig } from './config';
import { buildAuditTotals, scoreFindings, sortFindings } from './audit-summary';
import type { AuditReport, AuditRepositoryResult } from './audit-types';
import {
  evaluateAuditChecks,
  isPresent,
  type AuditContext,
  type GitHubBranchProtection,
  type GitHubContentFile,
  type GitHubContentItem,
  type GitHubRepositoryResponse,
  type Probe,
  type WorkflowFile
} from './audit-rules';
import { decodeGitHubContent, encodeGitHubPath } from './audit-workflows';
import { mapWithConcurrency } from './concurrency';
import { discoverRepositories, GitHubApiError, githubGet, publicErrorMessage } from './github';

export type {
  AuditArea,
  AuditCheckResult,
  AuditFinding,
  AuditReport,
  AuditRepositoryResult,
  AuditSeverity,
  AuditStatus
} from './audit-types';

export async function getAuditReport(config: NullbuilderConfig): Promise<AuditReport> {
  const repoList = config.discoverRepos ? await discoverRepositories(config) : config.repos;
  const repositories = await mapWithConcurrency(repoList, config.concurrency, (repo) => auditRepository(config, repo));
  const findings = repositories.flatMap((repo) => repo.findings).sort(sortFindings);
  const totals = buildAuditTotals(repositories, findings);

  return {
    generatedAt: new Date().toISOString(),
    hasToken: Boolean(config.token),
    owner: config.owner,
    repos: repoList,
    repositories,
    findings,
    hasReadErrors: totals.erroredRepositories > 0,
    totals
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
    const checks = evaluateAuditChecks(context);
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
