import { normalizeRepoSlug, type RepoSlug } from '../repositories';
import type { NullbuilderConfig } from './config';
import { mapWithConcurrency } from './concurrency';
import { GitHubApiError, githubGetPages, githubRequest, publicErrorMessage } from './github-client';
import {
  BUILD_PR_TAG_PREFIX,
  defaultBuildPrTagName,
  sanitizeBuildPrTagName,
  sanitizeReleaseTagName
} from './tags';

export { GitHubApiError, githubGet, githubGetPages, publicErrorMessage, resolveGitHubApiUrl } from './github-client';

export type GitHubLabel = {
  name: string;
  color: string;
};

export type IssueSummary = {
  repo: RepoSlug;
  number: number;
  title: string;
  url: string;
  author: string;
  labels: GitHubLabel[];
  comments: number;
  createdAt: string;
  updatedAt: string;
};

export type PullRequestSummary = IssueSummary & {
  draft: boolean;
  baseBranch: string;
  headBranch: string;
  headSha: string;
};

export type WorkflowRunSummary = {
  id: number;
  name: string;
  path: string;
  displayTitle: string;
  status: string;
  conclusion: string | null;
  url: string;
  branch: string;
  event: string;
  createdAt: string;
  updatedAt: string;
};

export type StarGrowthSummary = {
  current: number | null;
  last7Days: number | null;
  last30Days: number | null;
};

export type RepositorySummary = {
  slug: RepoSlug;
  owner: string;
  name: string;
  fullName: string;
  url: string;
  description: string;
  defaultBranch: string;
  language: string | null;
  isPrivate: boolean;
  archived: boolean;
  stars: number | null;
  forks: number | null;
  openIssues: number | null;
  openPulls: number | null;
  pushedAt: string | null;
  updatedAt: string;
  issues: IssueSummary[];
  pullRequests: PullRequestSummary[];
  starGrowth: StarGrowthSummary;
  latestRuns: {
    ci: WorkflowRunSummary | null;
    nightly: WorkflowRunSummary | null;
    release: WorkflowRunSummary | null;
  };
  status: 'ok' | 'error';
  error?: string;
};

export type DashboardData = {
  generatedAt: string;
  hasToken: boolean;
  owner: string;
  repos: RepoSlug[];
  repositories: RepositorySummary[];
  issues: IssueSummary[];
  pullRequests: PullRequestSummary[];
  hasReadErrors: boolean;
  totals: {
    repositories: number;
    loadedRepositories: number;
    erroredRepositories: number;
    issues: number;
    pullRequests: number;
    stars: number;
    failingRuns: number;
  };
};

export type BuildPrResult = {
  repo: RepoSlug;
  prNumber: number;
  prTitle: string;
  headSha: string;
  headBranch: string;
  tagName: string;
  tagUrl: string;
  workflowUrl: string;
  workflowTagPattern: string;
  dryRun: boolean;
  created: boolean;
  forced: boolean;
};

export type ReleaseTagResult = {
  repo: RepoSlug;
  tagName: string;
  targetRef: string;
  targetSha: string;
  tagUrl: string;
  workflowUrl: string;
  workflowTagPattern: string;
  dryRun: boolean;
  created: boolean;
  forced: boolean;
};

type GitHubRepositoryResponse = {
  name: string;
  full_name: string;
  html_url: string;
  description: string | null;
  default_branch: string;
  language: string | null;
  private: boolean;
  archived: boolean;
  stargazers_count: number;
  forks_count: number;
  open_issues_count: number;
  pushed_at: string | null;
  updated_at: string;
  owner: {
    login: string;
  };
};

type GitHubIssueResponse = {
  number: number;
  title: string;
  html_url: string;
  user: {
    login: string;
  } | null;
  labels: Array<string | { name?: string; color?: string }>;
  comments: number;
  created_at: string;
  updated_at: string;
  pull_request?: unknown;
};

type GitHubPullResponse = {
  number: number;
  title: string;
  html_url: string;
  draft: boolean;
  user: {
    login: string;
  } | null;
  labels?: Array<string | { name?: string; color?: string }>;
  comments?: number;
  created_at: string;
  updated_at: string;
  base: {
    ref: string;
    repo?: {
      full_name: string;
    };
  };
  head: {
    ref: string;
    sha: string;
    repo?: {
      full_name: string;
    } | null;
  };
};

type GitHubWorkflowRunResponse = {
  id: number;
  name: string | null;
  path?: string;
  display_title: string;
  status: string;
  conclusion: string | null;
  html_url: string;
  head_branch: string;
  event: string;
  created_at: string;
  updated_at: string;
};

type GitHubStargazerResponse = {
  starred_at?: string;
};

type GitHubPullDetailResponse = GitHubPullResponse;

type GitHubReferenceResponse = {
  ref: string;
  object: {
    sha: string;
  };
};

type GitHubBranchResponse = {
  name: string;
  commit: {
    sha: string;
  };
};

export async function getDashboard(config: NullbuilderConfig): Promise<DashboardData> {
  const repoList = config.discoverRepos ? await discoverRepositories(config) : config.repos;
  const repositories = await mapWithConcurrency(repoList, config.concurrency, (repo) =>
    getRepositorySummary(config, repo)
  );
  const loadedRepositories = repositories.filter((repo) => repo.status === 'ok');
  const issues = loadedRepositories.flatMap((repo) => repo.issues).sort(sortByUpdatedAt);
  const pullRequests = loadedRepositories.flatMap((repo) => repo.pullRequests).sort(sortByUpdatedAt);
  const failingRuns = loadedRepositories.filter((repo) => {
    const runs = Object.values(repo.latestRuns);
    return runs.some((run) => run?.status === 'completed' && run.conclusion !== 'success');
  }).length;
  const erroredRepositories = repositories.length - loadedRepositories.length;

  return {
    generatedAt: new Date().toISOString(),
    hasToken: Boolean(config.token),
    owner: config.owner,
    repos: repoList,
    repositories,
    issues,
    pullRequests,
    hasReadErrors: erroredRepositories > 0,
    totals: {
      repositories: repositories.length,
      loadedRepositories: loadedRepositories.length,
      erroredRepositories,
      issues: issues.length,
      pullRequests: pullRequests.length,
      stars: loadedRepositories.reduce((total, repo) => total + (repo.stars ?? 0), 0),
      failingRuns
    }
  };
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

    const openIssues = issues.filter((issue) => !issue.pull_request).map((issue) => mapIssue(repo, issue));
    const pullRequests = pulls.map((pull) => mapPullRequest(repo, pull));
    const latestRuns = mapLatestRuns(runs.workflow_runs);

    return {
      slug: repo,
      owner: repository.owner.login,
      name: repository.name,
      fullName: repository.full_name,
      url: repository.html_url,
      description: repository.description ?? '',
      defaultBranch: repository.default_branch,
      language: repository.language,
      isPrivate: repository.private,
      archived: repository.archived,
      stars: repository.stargazers_count,
      forks: repository.forks_count,
      openIssues: openIssues.length,
      openPulls: pullRequests.length,
      pushedAt: repository.pushed_at,
      updatedAt: repository.updated_at,
      issues: openIssues,
      pullRequests,
      starGrowth,
      latestRuns,
      status: 'ok'
    };
  } catch (error) {
    return makeErrorRepository(config, repo, error);
  }
}

export async function buildPrTag(
  config: NullbuilderConfig,
  options: {
    repo: string;
    prNumber: number;
    tagName?: string;
    confirm?: boolean;
    force?: boolean;
    allowDraft?: boolean;
    allowFork?: boolean;
    allowNonDefaultBase?: boolean;
  }
): Promise<BuildPrResult> {
  const repo = assertConfiguredRepository(config, normalizeRepoSlug(options.repo, config.owner));
  const requestedTagName = options.tagName ? sanitizeBuildPrTagName(options.tagName) : undefined;
  const [repository, pull] = await Promise.all([
    githubRequest<GitHubRepositoryResponse>(config, `/repos/${repo}`, {
      useCache: false
    }),
    githubRequest<GitHubPullDetailResponse>(config, `/repos/${repo}/pulls/${options.prNumber}`, {
      useCache: false
    })
  ]);
  assertTrustedPullRequest(repo, repository.default_branch, pull, options);
  const tagName = requestedTagName ?? sanitizeBuildPrTagName(defaultBuildPrTagName(options.prNumber, pull.head.sha));
  const tagUrl = `${config.webBaseUrl}/${repo}/releases/tag/${tagName}`;
  const workflowUrl = `${config.webBaseUrl}/${repo}/actions?query=${encodeURIComponent(`branch:${tagName}`)}`;

  const result: BuildPrResult = {
    repo,
    prNumber: pull.number,
    prTitle: pull.title,
    headSha: pull.head.sha,
    headBranch: pull.head.ref,
    tagName,
    tagUrl,
    workflowUrl,
    workflowTagPattern: `${BUILD_PR_TAG_PREFIX}*`,
    dryRun: !options.confirm,
    created: false,
    forced: false
  };

  if (!options.confirm) {
    return result;
  }

  const tagState = await createOrMoveTagRef(config, repo, tagName, pull.head.sha, Boolean(options.force));

  return {
    ...result,
    dryRun: false,
    created: tagState.created,
    forced: tagState.forced
  };
}

export async function createReleaseTag(
  config: NullbuilderConfig,
  options: {
    repo: string;
    tagName: string;
    targetRef?: string;
    confirm?: boolean;
    force?: boolean;
  }
): Promise<ReleaseTagResult> {
  const repo = assertConfiguredRepository(config, normalizeRepoSlug(options.repo, config.owner));
  const tagName = sanitizeReleaseTagName(options.tagName);
  const repository = await githubRequest<GitHubRepositoryResponse>(config, `/repos/${repo}`, {
    useCache: false
  });
  const targetRef = options.targetRef?.trim() || repository.default_branch;
  const targetSha = await resolveTargetSha(config, repo, targetRef);
  const tagUrl = `${config.webBaseUrl}/${repo}/releases/tag/${tagName}`;
  const workflowUrl = `${config.webBaseUrl}/${repo}/actions?query=${encodeURIComponent(`branch:${tagName}`)}`;

  const result: ReleaseTagResult = {
    repo,
    tagName,
    targetRef,
    targetSha,
    tagUrl,
    workflowUrl,
    workflowTagPattern: 'v*',
    dryRun: !options.confirm,
    created: false,
    forced: false
  };

  if (!options.confirm) {
    return result;
  }

  const tagState = await createOrMoveTagRef(config, repo, tagName, targetSha, Boolean(options.force));

  return {
    ...result,
    dryRun: false,
    created: tagState.created,
    forced: tagState.forced
  };
}

export function assertConfiguredRepository(config: NullbuilderConfig, repo: RepoSlug): RepoSlug {
  const allowed = new Set(config.repos.map((entry) => entry.toLowerCase()));
  if (!allowed.has(repo.toLowerCase())) {
    throw new Error(`Repository ${repo} is not in NULLBUILDER_REPOS.`);
  }

  return repo;
}

function assertTrustedPullRequest(
  repo: RepoSlug,
  defaultBranch: string,
  pull: GitHubPullDetailResponse,
  options: {
    allowDraft?: boolean;
    allowFork?: boolean;
    allowNonDefaultBase?: boolean;
  }
): void {
  const reasons: string[] = [];
  const headRepo = pull.head.repo?.full_name;

  if (pull.draft && !options.allowDraft) {
    reasons.push('draft PRs are rejected by default');
  }

  if (pull.base.ref !== defaultBranch && !options.allowNonDefaultBase) {
    reasons.push(`base branch must be ${defaultBranch}`);
  }

  if ((!headRepo || headRepo.toLowerCase() !== repo.toLowerCase()) && !options.allowFork) {
    reasons.push('fork PRs are rejected by default');
  }

  if (reasons.length > 0) {
    throw new Error(`Pull request is not trusted: ${reasons.join('; ')}.`);
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

function makeErrorRepository(config: NullbuilderConfig, repo: RepoSlug, error: unknown): RepositorySummary {
  const [owner, name] = repo.split('/');

  return {
    slug: repo,
    owner,
    name,
    fullName: repo,
    url: `${config.webBaseUrl}/${repo}`,
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
    updatedAt: new Date().toISOString(),
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
    error: publicErrorMessage(error)
  };
}

function mapIssue(repo: RepoSlug, issue: GitHubIssueResponse): IssueSummary {
  return {
    repo,
    number: issue.number,
    title: issue.title,
    url: issue.html_url,
    author: issue.user?.login ?? 'unknown',
    labels: mapLabels(issue.labels),
    comments: issue.comments,
    createdAt: issue.created_at,
    updatedAt: issue.updated_at
  };
}

function mapPullRequest(repo: RepoSlug, pull: GitHubPullResponse): PullRequestSummary {
  return {
    repo,
    number: pull.number,
    title: pull.title,
    url: pull.html_url,
    author: pull.user?.login ?? 'unknown',
    labels: mapLabels(pull.labels ?? []),
    comments: pull.comments ?? 0,
    createdAt: pull.created_at,
    updatedAt: pull.updated_at,
    draft: pull.draft,
    baseBranch: pull.base.ref,
    headBranch: pull.head.ref,
    headSha: pull.head.sha
  };
}

function mapLabels(labels: Array<string | { name?: string; color?: string }>): GitHubLabel[] {
  return labels.map((label) => {
    if (typeof label === 'string') {
      return {
        name: label,
        color: 'd0d7de'
      };
    }

    return {
      name: label.name ?? 'label',
      color: label.color ?? 'd0d7de'
    };
  });
}

function mapLatestRuns(runs: GitHubWorkflowRunResponse[]): RepositorySummary['latestRuns'] {
  return {
    ci: mapRun(findRun(runs, ['ci', 'test'], ['ci.yml', 'zig-ci.yml'])),
    nightly: mapRun(findRun(runs, ['nightly'], ['nightly.yml', 'zig-nightly.yml'])),
    release: mapRun(findRun(runs, ['release'], ['release.yml', 'zig-release.yml']))
  };
}

function findRun(
  runs: GitHubWorkflowRunResponse[],
  nameKeywords: string[],
  pathKeywords: string[]
): GitHubWorkflowRunResponse | null {
  return (
    runs.find((run) => {
      const name = (run.name ?? '').toLowerCase();
      const path = (run.path ?? '').toLowerCase();
      return (
        nameKeywords.some((keyword) => name.includes(keyword)) ||
        pathKeywords.some((keyword) => path.endsWith(keyword) || path.includes(`/${keyword}`))
      );
    }) ?? null
  );
}

function mapRun(run: GitHubWorkflowRunResponse | null): WorkflowRunSummary | null {
  if (!run) {
    return null;
  }

  return {
    id: run.id,
    name: run.name ?? 'Workflow',
    path: run.path ?? '',
    displayTitle: run.display_title,
    status: run.status,
    conclusion: run.conclusion,
    url: run.html_url,
    branch: run.head_branch,
    event: run.event,
    createdAt: run.created_at,
    updatedAt: run.updated_at
  };
}

function sortByUpdatedAt(left: { updatedAt: string }, right: { updatedAt: string }): number {
  return Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
}

async function resolveTargetSha(config: NullbuilderConfig, repo: RepoSlug, targetRef: string): Promise<string> {
  if (/^[a-f0-9]{40}$/i.test(targetRef)) {
    return targetRef;
  }

  const branch = await githubRequest<GitHubBranchResponse>(
    config,
    `/repos/${repo}/branches/${encodeURIComponent(targetRef)}`,
    {
      useCache: false
    }
  );

  return branch.commit.sha;
}

async function createOrMoveTagRef(
  config: NullbuilderConfig,
  repo: RepoSlug,
  tagName: string,
  sha: string,
  force: boolean
): Promise<{ created: boolean; forced: boolean }> {
  try {
    await githubRequest<GitHubReferenceResponse>(config, `/repos/${repo}/git/refs`, {
      useCache: false,
      method: 'POST',
      body: JSON.stringify({
        ref: `refs/tags/${tagName}`,
        sha
      })
    });
    return {
      created: true,
      forced: false
    };
  } catch (error) {
    if (!force || !isValidationError(error)) {
      throw error;
    }

    await githubRequest<GitHubReferenceResponse>(config, `/repos/${repo}/git/ref/tags/${tagName}`, {
      useCache: false
    });
    await githubRequest<GitHubReferenceResponse>(config, `/repos/${repo}/git/refs/tags/${tagName}`, {
      useCache: false,
      method: 'PATCH',
      body: JSON.stringify({
        sha,
        force: true
      })
    });

    return {
      created: true,
      forced: true
    };
  }
}

function isValidationError(error: unknown): boolean {
  return error instanceof GitHubApiError && error.status === 422;
}
