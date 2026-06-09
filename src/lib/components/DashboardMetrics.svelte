<script lang="ts">
  import { AlertTriangle, CircleDot, GitPullRequest, ShieldCheck, Star, XCircle } from '@lucide/svelte';

  type DashboardTotals = {
    loadedRepositories: number;
    erroredRepositories: number;
    repositories: number;
    issues: number;
    pullRequests: number;
    stars: number;
    failingRuns: number;
  };

  let {
    auditAverageScore,
    totals
  }: {
    auditAverageScore: number;
    totals: DashboardTotals;
  } = $props();
</script>

<section class="metrics" aria-label="Dashboard totals">
  <div class="metric">
    <CircleDot size={18} />
    <span>Loaded</span>
    <strong>{totals.loadedRepositories}</strong>
  </div>
  <div class="metric">
    <AlertTriangle size={18} />
    <span>Errors</span>
    <strong>{totals.erroredRepositories}</strong>
  </div>
  <div class="metric">
    <CircleDot size={18} />
    <span>Total</span>
    <strong>{totals.repositories}</strong>
  </div>
  <div class="metric">
    <CircleDot size={18} />
    <span>Issues</span>
    <strong>{totals.issues}</strong>
  </div>
  <div class="metric">
    <GitPullRequest size={18} />
    <span>PRs</span>
    <strong>{totals.pullRequests}</strong>
  </div>
  <div class="metric">
    <Star size={18} />
    <span>Stars</span>
    <strong>{totals.stars}</strong>
  </div>
  <div class="metric">
    <XCircle size={18} />
    <span>Failing</span>
    <strong>{totals.failingRuns}</strong>
  </div>
  <div class="metric">
    <ShieldCheck size={18} />
    <span>Audit</span>
    <strong>{auditAverageScore}</strong>
  </div>
</section>

<style>
  .metrics {
    display: grid;
    grid-template-columns: repeat(8, minmax(0, 1fr));
    gap: 10px;
    margin-bottom: 18px;
  }

  .metric {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    border: 1px solid #ded8c9;
    border-radius: 8px;
    background: #fffdfa;
    padding: 14px;
  }

  .metric span {
    color: #6f6b60;
    font-weight: 700;
  }

  .metric strong {
    font-size: 1.45rem;
  }

  @media (max-width: 1100px) {
    .metrics {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
  }

  @media (max-width: 720px) {
    .metrics {
      grid-template-columns: 1fr;
    }
  }
</style>
