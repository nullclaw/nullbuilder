<script lang="ts">
  import {
    AlertTriangle,
    CheckCircle2,
    CircleDot,
    ExternalLink,
    GitBranch,
    GitPullRequest,
    RefreshCw,
    Star,
    Tags
  } from '@lucide/svelte';
  import {
    formatDashboardDate,
    formatGrowth,
    formatNullableNumber,
    workflowRunClass,
    workflowRunLabel
  } from '$lib/dashboard-format';
  import type { RepositorySummary } from '$lib/server/github-dashboard';

  let { repositories }: { repositories: RepositorySummary[] } = $props();
</script>

<section id="repos" class="repo-grid" aria-label="Repositories">
  {#each repositories as repo}
    <article class:error={repo.error} class="repo-card">
      <header>
        <div>
          <h2>{repo.name}</h2>
          <p>{repo.description || repo.fullName}</p>
        </div>
        <a
          class="repo-link"
          href={repo.url}
          target="_blank"
          rel="noopener noreferrer"
          aria-label="Open {repo.fullName}"
        >
          <ExternalLink size={17} />
        </a>
      </header>

      {#if repo.error}
        <div class="repo-error">
          <AlertTriangle size={16} />
          <span>{repo.error}</span>
        </div>
      {:else}
        <div class="repo-stats">
          <span><CircleDot size={15} /> {formatNullableNumber(repo.openIssues)}</span>
          <span><GitPullRequest size={15} /> {formatNullableNumber(repo.openPulls)}</span>
          <span><Star size={15} /> {formatNullableNumber(repo.stars)}</span>
          <span><GitBranch size={15} /> {repo.defaultBranch}</span>
        </div>

        <div class="run-grid">
          <a
            class={workflowRunClass(repo.latestRuns.ci)}
            href={repo.latestRuns.ci?.url ?? repo.url}
            target="_blank"
            rel="noopener noreferrer"
          >
            <CheckCircle2 size={15} />
            <span>CI</span>
            <strong>{workflowRunLabel(repo.latestRuns.ci)}</strong>
          </a>
          <a
            class={workflowRunClass(repo.latestRuns.nightly)}
            href={repo.latestRuns.nightly?.url ?? repo.url}
            target="_blank"
            rel="noopener noreferrer"
          >
            <RefreshCw size={15} />
            <span>Nightly</span>
            <strong>{workflowRunLabel(repo.latestRuns.nightly)}</strong>
          </a>
          <a
            class={workflowRunClass(repo.latestRuns.release)}
            href={repo.latestRuns.release?.url ?? repo.url}
            target="_blank"
            rel="noopener noreferrer"
          >
            <Tags size={15} />
            <span>Release</span>
            <strong>{workflowRunLabel(repo.latestRuns.release)}</strong>
          </a>
        </div>

        <footer>
          <span>{formatGrowth(repo.starGrowth.last7Days)} stars 7d</span>
          <span>{formatGrowth(repo.starGrowth.last30Days)} stars 30d</span>
          <span>pushed {formatDashboardDate(repo.pushedAt)}</span>
        </footer>
      {/if}
    </article>
  {/each}
</section>

<style>
  .repo-grid {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 12px;
    margin-bottom: 24px;
  }

  .repo-card {
    min-height: 244px;
    border: 1px solid #ded8c9;
    border-radius: 8px;
    background: #fffdfa;
    padding: 16px;
  }

  .repo-card.error {
    border-color: #d4947f;
    background: #fff8f4;
  }

  .repo-card header {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 34px;
    gap: 12px;
    min-height: 58px;
  }

  .repo-card h2 {
    margin: 0;
    overflow-wrap: anywhere;
    font-size: 1.12rem;
  }

  .repo-card p {
    margin: 4px 0 0;
    color: #6f6b60;
    font-size: 0.9rem;
    line-height: 1.35;
  }

  .repo-link,
  .repo-stats,
  .repo-stats span {
    display: flex;
    align-items: center;
  }

  .repo-link {
    justify-content: center;
    width: 34px;
    height: 34px;
    border: 1px solid #d7cfbd;
    border-radius: 7px;
    text-decoration: none;
  }

  .repo-error {
    display: flex;
    gap: 9px;
    margin-top: 18px;
    color: #9a3f28;
    font-size: 0.9rem;
    line-height: 1.35;
  }

  .repo-stats {
    flex-wrap: wrap;
    gap: 8px;
    margin: 14px 0;
  }

  .repo-stats span {
    gap: 6px;
    border: 1px solid #ddd5c2;
    border-radius: 999px;
    padding: 6px 9px;
    color: #48453b;
    font-size: 0.84rem;
    font-weight: 800;
  }

  .run-grid {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 8px;
  }

  .run-grid a {
    display: grid;
    grid-template-columns: 16px minmax(0, 1fr);
    gap: 5px 7px;
    min-height: 56px;
    border: 1px solid #d9d2bf;
    border-radius: 7px;
    padding: 9px;
    text-decoration: none;
  }

  .run-grid span,
  .run-grid strong {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .run-grid span {
    font-size: 0.78rem;
    font-weight: 800;
  }

  .run-grid strong {
    grid-column: 1 / -1;
    font-size: 0.86rem;
  }

  .run-grid .success {
    border-color: #9bc7a5;
    background: #f2fbf2;
    color: #236d3a;
  }

  .run-grid .failed {
    border-color: #d88d76;
    background: #fff3ee;
    color: #943f28;
  }

  .run-grid .running {
    border-color: #d9b766;
    background: #fff8df;
    color: #765508;
  }

  .run-grid .muted {
    color: #787366;
  }

  .repo-card footer {
    display: flex;
    flex-wrap: wrap;
    gap: 8px 12px;
    margin-top: 14px;
    color: #6f6b60;
    font-size: 0.82rem;
    font-weight: 700;
  }

  @media (max-width: 1100px) {
    .repo-grid {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
  }

  @media (max-width: 720px) {
    .repo-grid,
    .run-grid {
      grid-template-columns: 1fr;
    }
  }
</style>
