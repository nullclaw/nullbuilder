<script lang="ts">
  import { ArrowRight, CircleDot, GitPullRequest } from '@lucide/svelte';
  import { formatDashboardDate } from '$lib/dashboard-format';
  import type { IssueSummary, PullRequestSummary } from '$lib/server/github-dashboard-types';

  let {
    hasErrors,
    issues,
    pullRequests
  }: {
    hasErrors: boolean;
    issues: IssueSummary[];
    pullRequests: PullRequestSummary[];
  } = $props();
</script>

<section id="issues" class="work-panel">
  <div class="section-heading">
    <h2>Issues</h2>
    <span>{issues.length}</span>
  </div>

  <div class="work-list">
    {#each issues as issue}
      <a class="work-row" href={issue.url} target="_blank" rel="noreferrer">
        <CircleDot size={16} />
        <span class="work-repo">{issue.repo}</span>
        <span class="work-number">#{issue.number}</span>
        <strong>{issue.title}</strong>
        <span class="work-meta">{formatDashboardDate(issue.updatedAt)}</span>
        <ArrowRight size={16} />
      </a>
    {:else}
      <p class="empty">{hasErrors ? 'No issue rows from loaded repositories.' : 'No open issues.'}</p>
    {/each}
  </div>
</section>

<section id="prs" class="work-panel">
  <div class="section-heading">
    <h2>Pull Requests</h2>
    <span>{pullRequests.length}</span>
  </div>

  <div class="work-list">
    {#each pullRequests as pull}
      <a class="work-row" href={pull.url} target="_blank" rel="noreferrer">
        <GitPullRequest size={16} />
        <span class="work-repo">{pull.repo}</span>
        <span class="work-number">#{pull.number}</span>
        <strong>{pull.title}</strong>
        <span class="work-meta">{pull.draft ? 'draft' : pull.headBranch}</span>
        <ArrowRight size={16} />
      </a>
    {:else}
      <p class="empty">{hasErrors ? 'No PR rows from loaded repositories.' : 'No open pull requests.'}</p>
    {/each}
  </div>
</section>

<style>
  .work-panel {
    margin-bottom: 18px;
    overflow: hidden;
    border: 1px solid #ded8c9;
    border-radius: 8px;
    background: #fffdfa;
  }

  .section-heading {
    display: flex;
    align-items: center;
    justify-content: space-between;
    border-bottom: 1px solid #e2dac8;
    padding: 14px 16px;
  }

  .section-heading h2 {
    margin: 0;
    font-size: 1rem;
  }

  .section-heading span {
    color: #6f6b60;
    font-weight: 800;
  }

  .work-list {
    display: grid;
  }

  .work-row {
    display: grid;
    grid-template-columns: 18px minmax(120px, 180px) 58px minmax(0, 1fr) minmax(90px, 150px) 18px;
    gap: 10px;
    align-items: center;
    min-height: 48px;
    border-bottom: 1px solid #eee7d8;
    padding: 0 16px;
    text-decoration: none;
  }

  .work-row:last-child {
    border-bottom: 0;
  }

  .work-row:hover {
    background: #faf3e4;
  }

  .work-row strong,
  .work-row span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .work-row strong {
    font-size: 0.92rem;
  }

  .work-row span {
    color: #6f6b60;
    font-size: 0.84rem;
    font-weight: 700;
  }

  .work-number {
    color: #3f7364;
  }

  .empty {
    margin: 0;
    padding: 16px;
    color: #6f6b60;
  }

  @media (max-width: 720px) {
    .work-row {
      grid-template-columns: 18px 64px minmax(0, 1fr) 18px;
      min-height: 62px;
    }

    .work-repo,
    .work-meta {
      display: none;
    }
  }
</style>
