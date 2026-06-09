import { normalizeRepoSlug, type RepoSlug } from '../repositories';
import type { NullbuilderConfig } from './config';
import { mapWithConcurrency } from './concurrency';
import {
  buildDashboard,
  makeErrorRepository,
  mapRepositorySummary,
  type DashboardData,
  type GitHubIssueResponse,
  type GitHubPullResponse,
  type GitHubRepositoryResponse,
  type GitHubWorkflowRunResponse,
  type RepositorySummary
} from './github-dashboard';
import { githubGetPages, githubRequest } from './github-client';
import { getStarGrowth } from './github-star-growth';

export { GitHubApiError, githubGet, githubGetPages, publicErrorMessage, resolveGitHubApiUrl } from './github-client';
export { assertConfiguredRepository, buildPrTag, createReleaseTag } from './github-mutations';
export type { BuildPrResult, ReleaseTagResult } from './github-mutations';
export type {
  DashboardData,
  GitHubLabel,
  IssueSummary,
  PullRequestSummary,
  RepositorySummary,
  StarGrowthSummary,
  WorkflowRunSummary
} from './github-dashboard';

export async function getDashboard(config: NullbuilderConfig): Promise<DashboardData> {
  const repoList = config.discoverRepos ? await discoverRepositories(config) : config.repos;
  const repositories = await mapWithConcurrency(repoList, config.concurrency, (repo) =>
    getRepositorySummary(config, repo)
  );
  return buildDashboard(config, repoList, repositories);
}

export async function discoverRepositories(config: NullbuilderConfig): Promise<RepoSlug[]> {
  type RepositoryListItem = {
    name: string;
    full_name: string;
    language: string | null;
    archived: boolean;
  };

  const configured = new Map(config.repos.map((repo) => [repoKey(repo), repo]));
  const ignored = new Set(config.ignoredRepos.map(repoKey));

  try {
    const repos = await githubGetPages<RepositoryListItem>(
      config,
      `/users/${config.owner}/repos?type=owner&sort=updated&per_page=100`,
      {},
      20
    );

    for (const repo of repos) {
      const slug = normalizeDiscoveredRepoSlug(repo.full_name, config.owner);
      if (!slug || ignored.has(repoKey(slug))) {
        continue;
      }

      const isNullRepo = repo.name.toLowerCase().startsWith('null') || repo.name.toLowerCase() === 'nllclw';
      const isZigRepo = repo.language === 'Zig';
      if (!repo.archived && (isNullRepo || isZigRepo)) {
        configured.set(repoKey(slug), slug);
      }
    }
  } catch {
    return config.repos;
  }

  return [...configured.values()].sort((left, right) => left.localeCompare(right));
}

function normalizeDiscoveredRepoSlug(fullName: string, defaultOwner: string): RepoSlug | null {
  try {
    return normalizeRepoSlug(fullName, defaultOwner);
  } catch {
    return null;
  }
}

function repoKey(repo: RepoSlug): string {
  return repo.toLowerCase();
}

export async function getRepositorySummary(config: NullbuilderConfig, repo: RepoSlug): Promise<RepositorySummary> {
  try {
    const repository = await githubRequest<GitHubRepositoryResponse>(config, `/repos/${repo}`);
    const [issues, pulls, runs, starGrowth] = await Promise.all([
      githubGetPages<GitHubIssueResponse>(config, `/repos/${repo}/issues?state=open&per_page=100`, {}, 20),
      githubGetPages<GitHubPullResponse>(config, `/repos/${repo}/pulls?state=open&per_page=100`, {}, 20),
      githubRequest<{ workflow_runs: GitHubWorkflowRunResponse[] }>(
        config,
        `/repos/${repo}/actions/runs?per_page=100`
      ),
      getStarGrowth(config, repo, repository.stargazers_count)
    ]);

    return mapRepositorySummary(repo, repository, issues, pulls, runs.workflow_runs, starGrowth);
  } catch (error) {
    return makeErrorRepository(config, repo, error);
  }
}
