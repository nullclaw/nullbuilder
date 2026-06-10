import { normalizeRepoSlug, type RepoSlug } from '../repositories';
import { readObjectRecord } from '../record-safety';
import { readSafeTextInput } from '../text-safety';
import type { NullbuilderConfig } from './config';
import { buildAuditTotals, collectAuditFindings, collectCheckFindings, scoreFindings } from './audit-summary';
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
import { decodeGitHubContent } from './audit-workflows';
import { mapWithConcurrency } from './concurrency';
import { sanitizeGitBranchName } from './git-refs';
import { discoverRepositories, GitHubApiError, githubGet, publicErrorMessage } from './github';
import {
  githubActionsUrl,
  githubRepositoryWebUrl,
  githubRepositoryUrlContext,
  safeGitHubWebUrl,
  type GitHubWebUrlContext
} from './github-web-urls';
import { encodeGitHubPath } from './github-url-encoding';

const MAX_WORKFLOW_FILE_NAME_LENGTH = 255;
const MAX_WORKFLOW_FILE_PATH_LENGTH = 512;
export const MAX_WORKFLOW_FILES_PER_REPOSITORY = 50;

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
  const findings = collectAuditFindings(repositories);
  const totals = buildAuditTotals(repositories);

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
    const urlContext = githubRepositoryUrlContext(config.webBaseUrl, normalizedRepo, repository.html_url);
    const defaultBranch = safeDefaultBranch(repository.default_branch);
    const displayDefaultBranch = defaultBranch ?? 'unknown';
    const safeRepository = {
      ...repository,
      default_branch: displayDefaultBranch,
      html_url: urlContext.repositoryUrl
    };
    const branchProtectionProbe: Promise<Probe<GitHubBranchProtection>> =
      defaultBranch === null
        ? Promise.resolve({ status: 'error', error: 'Invalid default branch.' })
        : probeGitHub<GitHubBranchProtection>(
            config,
            `/repos/${normalizedRepo}/branches/${encodeURIComponent(defaultBranch)}/protection`
          );
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
      loadWorkflowFiles(config, normalizedRepo, workflowDirectory, urlContext),
      branchProtectionProbe,
      probeGitHub<GitHubContentFile>(config, `/repos/${normalizedRepo}/contents/.github/dependabot.yml`),
      probeGitHub<GitHubContentFile>(config, `/repos/${normalizedRepo}/contents/SECURITY.md`),
      probeGitHub<GitHubContentFile>(config, `/repos/${normalizedRepo}/contents/.github/SECURITY.md`),
      probeGitHub<GitHubContentFile>(config, `/repos/${normalizedRepo}/contents/CODEOWNERS`),
      probeGitHub<GitHubContentFile>(config, `/repos/${normalizedRepo}/contents/.github/CODEOWNERS`)
    ]);
    const context: AuditContext = {
      repo: normalizedRepo,
      repository: safeRepository,
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
    const findings = collectCheckFindings(checks);

    return {
      repo: normalizedRepo,
      url: urlContext.repositoryUrl,
      defaultBranch: displayDefaultBranch,
      status: 'ok',
      score: scoreFindings(findings),
      checks,
      findings
    };
  } catch (error) {
    const normalizedRepo = normalizeRepoSlug(repo, config.owner);

    return {
      repo: normalizedRepo,
      url: githubRepositoryWebUrl(config.webBaseUrl, normalizedRepo),
      defaultBranch: 'unknown',
      status: 'error',
      score: 0,
      checks: [],
      findings: [],
      error: publicErrorMessage(error)
    };
  }
}

function safeDefaultBranch(value: string): string | null {
  try {
    return sanitizeGitBranchName(value, 'default branch');
  } catch {
    return null;
  }
}

async function loadWorkflowFiles(
  config: NullbuilderConfig,
  repo: RepoSlug,
  workflowDirectory: Probe<GitHubContentItem[]>,
  urlContext: GitHubWebUrlContext
): Promise<WorkflowFile[]> {
  if (!isPresent(workflowDirectory) || !Array.isArray(workflowDirectory.data)) {
    return [];
  }

  const workflowItems = collectWorkflowDirectoryItems(workflowDirectory.data);

  const loadedWorkflowFiles = await mapWithConcurrency(
    workflowItems,
    Math.min(config.concurrency, 4),
    async (item) => {
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
        url: safeGitHubWebUrl(
          item.html_url,
          githubActionsUrl(urlContext),
          urlContext.repositoryOrigin,
          urlContext.repositoryPathPrefix
        ),
        content: decodeGitHubContent(file.data)
      };
    }
  );

  const workflowFiles: WorkflowFile[] = [];
  for (const file of loadedWorkflowFiles) {
    if (file !== null) {
      workflowFiles.push(file);
    }
  }

  return workflowFiles;
}

type SafeWorkflowDirectoryItem = Pick<GitHubContentItem, 'name' | 'path' | 'html_url'>;

function collectWorkflowDirectoryItems(items: unknown[]): SafeWorkflowDirectoryItem[] {
  const workflowItems: SafeWorkflowDirectoryItem[] = [];

  for (const item of items) {
    const safeItem = safeWorkflowDirectoryItem(item);
    if (!safeItem) {
      continue;
    }

    workflowItems.push(safeItem);
    if (workflowItems.length >= MAX_WORKFLOW_FILES_PER_REPOSITORY) {
      break;
    }
  }

  return workflowItems;
}

function safeWorkflowDirectoryItem(item: unknown): SafeWorkflowDirectoryItem | null {
  const contentItem = readObjectRecord(item);
  if (!contentItem) {
    return null;
  }

  if (contentItem.type !== 'file') {
    return null;
  }

  if (typeof contentItem.name !== 'string' || typeof contentItem.path !== 'string') {
    return null;
  }

  const name = readSafeTextInput(contentItem.name, { maxLength: MAX_WORKFLOW_FILE_NAME_LENGTH });
  const path = readSafeTextInput(contentItem.path, { maxLength: MAX_WORKFLOW_FILE_PATH_LENGTH });
  if (!name || !path || !/^[^/\\]+\.ya?ml$/i.test(name)) {
    return null;
  }

  if (path !== `.github/workflows/${name}`) {
    return null;
  }

  return {
    name,
    path,
    html_url: typeof contentItem.html_url === 'string' ? contentItem.html_url : ''
  };
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
