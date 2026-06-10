import type { RepoSlug } from '../repositories';
import { readSafeTextInput } from '../text-safety';
import type { NullbuilderConfig } from './config';
import { githubRequest } from './github-client';
import type { StarGrowthSummary } from './github-dashboard-types';
import { safeNonNegativeInteger } from './number-safety';

const STAR_PAGE_SIZE = 100;
const MAX_STAR_PAGES_TO_SCAN = 10;
const MAX_STARGAZER_TIMESTAMP_LENGTH = 64;
const DAY_MS = 24 * 60 * 60 * 1000;

type GitHubStargazerResponse = {
  starred_at?: string;
};

export async function getStarGrowth(
  config: NullbuilderConfig,
  repo: RepoSlug,
  currentStars: number,
  now = Date.now()
): Promise<StarGrowthSummary> {
  const current = safeCurrentStars(currentStars);
  if (current === null) {
    return {
      current: null,
      last7Days: null,
      last30Days: null
    };
  }

  if (current === 0) {
    return {
      current: 0,
      last7Days: 0,
      last30Days: 0
    };
  }

  try {
    return await fetchStarGrowth(config, repo, current, now);
  } catch {
    return {
      current,
      last7Days: null,
      last30Days: null
    };
  }
}

async function fetchStarGrowth(
  config: NullbuilderConfig,
  repo: RepoSlug,
  currentStars: number,
  now: number
): Promise<StarGrowthSummary> {
  const lastPage = Math.max(1, Math.ceil(currentStars / STAR_PAGE_SIZE));
  let last7Days = 0;
  let last30Days = 0;

  for (
    let page = lastPage, pagesRead = 0;
    page >= 1 && pagesRead < MAX_STAR_PAGES_TO_SCAN;
    page -= 1, pagesRead += 1
  ) {
    const stargazers = await githubRequest<GitHubStargazerResponse[]>(
      config,
      `/repos/${repo}/stargazers?per_page=${STAR_PAGE_SIZE}&page=${page}`,
      {
        accept: 'application/vnd.github.star+json'
      }
    );
    let pageHasRecentStars = false;

    for (const star of stargazers) {
      const age = starAgeMs(star.starred_at, now);
      if (age === null) {
        continue;
      }

      if (age <= 30 * DAY_MS) {
        pageHasRecentStars = true;
        last30Days += 1;
      }
      if (age <= 7 * DAY_MS) {
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
}

function starAgeMs(starredAt: unknown, now: number): number | null {
  if (typeof starredAt !== 'string') {
    return null;
  }

  const safeStarredAt = readSafeTextInput(starredAt, { maxLength: MAX_STARGAZER_TIMESTAMP_LENGTH, trim: true });
  if (!safeStarredAt) {
    return null;
  }

  const timestamp = Date.parse(safeStarredAt);
  if (!Number.isFinite(timestamp)) {
    return null;
  }

  const age = now - timestamp;
  return age >= 0 ? age : null;
}

function safeCurrentStars(value: number): number | null {
  return safeNonNegativeInteger(value);
}
