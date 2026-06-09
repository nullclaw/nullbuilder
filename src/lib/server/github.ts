import type { RepoSlug } from '../repositories';
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
  type RepositorySummary,
  type StarGrowthSummary
} from './github-dashboard';
import { githubGetPages, githubRequest } from './github-client';

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

type GitHubStargazerResponse = {
  starred_at?: string;
};

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

  const configured = new Map(config.repos.map((repo) => [repo.toLowerCase(), repo]));
  const ignored = new Set(config.ignoredRepos.map((repo) => repo.toLowerCase()));

  try {
    const repos = await githubGetPages<RepositoryListItem>(
      config,
      `/users/${config.owner}/repos?type=owner&sort=updated&per_page=100`,
      {},
      20
    );

    for (const repo of repos) {
      if (ignored.has(repo.full_name.toLowerCase())) {
        continue;
      }

      const isNullRepo = repo.name.toLowerCase().startsWith('null') || repo.name.toLowerCase() === 'nllclw';
      const isZigRepo = repo.language === 'Zig';
      if (!repo.archived && (isNullRepo || isZigRepo)) {
        configured.set(repo.full_name.toLowerCase(), repo.full_name as RepoSlug);
      }
    }
  } catch {
    return config.repos;
  }

  return [...configured.values()].sort((left, right) => left.localeCompare(right));
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

async function getStarGrowth(
  config: NullbuilderConfig,
  repo: RepoSlug,
  currentStars: number
): Promise<StarGrowthSummary> {
  if (currentStars === 0) {
    return {
      current: 0,
      last7Days: 0,
      last30Days: 0
    };
  }

  try {
    const now = Date.now();
    const day = 24 * 60 * 60 * 1000;
    const lastPage = Math.max(1, Math.ceil(currentStars / 100));
    let last7Days = 0;
    let last30Days = 0;

    for (let page = lastPage, pagesRead = 0; page >= 1 && pagesRead < 10; page -= 1, pagesRead += 1) {
      const stargazers = await githubRequest<GitHubStargazerResponse[]>(
        config,
        `/repos/${repo}/stargazers?per_page=100&page=${page}`,
        {
          accept: 'application/vnd.github.star+json'
        }
      );
      let pageHasRecentStars = false;

      for (const star of stargazers) {
        if (!star.starred_at) {
          continue;
        }

        const age = now - Date.parse(star.starred_at);
        if (age <= 30 * day) {
          pageHasRecentStars = true;
          last30Days += 1;
        }
        if (age <= 7 * day) {
          last7Days += 1;
        }
      }

      if (!pageHasRecentStars) {
        break;
      }
    }

    return {
      current: currentStars,
      last7Days,
      last30Days
    };
  } catch {
    return {
      current: currentStars,
      last7Days: null,
      last30Days: null
    };
  }
}
