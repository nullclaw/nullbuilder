<script lang="ts">
  import { AlertTriangle, ArrowRight, ShieldCheck } from '@lucide/svelte';
  import { visibleAuditFindings } from '$lib/dashboard-view';
  import type { AuditReport } from '$lib/server/audit-types';

  let { audit }: { audit: AuditReport | null | undefined } = $props();

  const repositories = $derived(audit?.repositories ?? []);
  const findings = $derived(visibleAuditFindings(audit?.findings ?? []));
  const repositoryUrls = $derived(new Map(repositories.map((repo) => [repo.repo, repo.url])));
</script>

<section id="audit" class="audit-panel">
  <div class="section-heading">
    <h2>Audit</h2>
    <span>{audit?.totals.findings ?? 0}</span>
  </div>

  {#if audit}
    <div class="audit-summary" aria-label="Audit totals">
      <span class="audit-pill critical"><strong>{audit.totals.critical}</strong> critical</span>
      <span class="audit-pill warning"><strong>{audit.totals.warning}</strong> warning</span>
      <span class="audit-pill info"><strong>{audit.totals.info}</strong> info</span>
      <span class="audit-pill score"><strong>{audit.totals.averageScore}</strong> average</span>
    </div>

    <div class="audit-table">
      {#each repositories as repo}
        <a class:error={repo.status === 'error'} class="audit-row" href={repo.url} target="_blank" rel="noreferrer">
          <ShieldCheck size={16} />
          <span class="audit-repo">{repo.repo}</span>
          <strong>{repo.score}</strong>
          <span class="audit-state">{repo.status === 'error' ? 'error' : repo.findings[0]?.severity ?? 'ok'}</span>
          <span class="audit-title">{repo.error ?? repo.findings[0]?.title ?? 'ok'}</span>
          <ArrowRight size={16} />
        </a>
      {/each}
    </div>

    <div class="audit-findings">
      {#each findings as finding}
        <a
          class="audit-finding {finding.severity}"
          href={finding.url ?? repositoryUrls.get(finding.repo) ?? '#audit'}
          target="_blank"
          rel="noreferrer"
        >
          <AlertTriangle size={16} />
          <span class="finding-severity">{finding.severity}</span>
          <strong>{finding.repo}</strong>
          <span>{finding.title}</span>
          <small class="finding-path">{finding.path ?? finding.area}</small>
        </a>
      {:else}
        <p class="empty">No audit findings.</p>
      {/each}
    </div>
  {:else}
    <p class="empty">Audit unavailable.</p>
  {/if}
</section>

<style>
  .audit-panel {
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

  .audit-summary {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 10px;
    padding: 14px 16px;
    border-bottom: 1px solid #eee7d8;
  }

  .audit-pill {
    border: 1px solid #ddd5c2;
    border-radius: 7px;
    padding: 10px 12px;
    color: #5d584d;
    font-size: 0.86rem;
    font-weight: 800;
  }

  .audit-pill strong {
    margin-right: 6px;
    color: #24231f;
    font-size: 1.08rem;
  }

  .audit-pill.critical {
    border-color: #d88d76;
    background: #fff3ee;
  }

  .audit-pill.warning {
    border-color: #d9b766;
    background: #fff8df;
  }

  .audit-pill.info {
    border-color: #a8bfd2;
    background: #f2f7fb;
  }

  .audit-pill.score {
    border-color: #9bc7a5;
    background: #f2fbf2;
  }

  .audit-table,
  .audit-findings {
    display: grid;
  }

  .audit-table {
    border-bottom: 1px solid #eee7d8;
  }

  .audit-row,
  .audit-finding {
    display: grid;
    align-items: center;
    gap: 10px;
    min-height: 48px;
    border-bottom: 1px solid #eee7d8;
    padding: 0 16px;
    text-decoration: none;
  }

  .audit-row {
    grid-template-columns: 18px minmax(160px, 1fr) 58px 90px minmax(0, 2fr) 18px;
  }

  .audit-finding {
    grid-template-columns: 18px 82px minmax(130px, 220px) minmax(0, 1fr) minmax(90px, 180px);
  }

  .audit-row:last-child,
  .audit-finding:last-child {
    border-bottom: 0;
  }

  .audit-row:hover,
  .audit-finding:hover {
    background: #faf3e4;
  }

  .audit-row.error {
    color: #943f28;
  }

  .audit-row span,
  .audit-row strong,
  .audit-finding span,
  .audit-finding strong,
  .audit-finding small {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .audit-row strong {
    color: #24231f;
    font-size: 0.95rem;
  }

  .audit-row span,
  .audit-finding span,
  .audit-finding small {
    color: #6f6b60;
    font-size: 0.84rem;
    font-weight: 700;
  }

  .audit-finding.critical {
    color: #943f28;
  }

  .audit-finding.warning {
    color: #765508;
  }

  .audit-finding.info {
    color: #365f7d;
  }

  .empty {
    margin: 0;
    padding: 16px;
    color: #6f6b60;
  }

  @media (max-width: 1100px) {
    .audit-summary {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
  }

  @media (max-width: 720px) {
    .audit-summary {
      grid-template-columns: 1fr;
    }

    .audit-row,
    .audit-finding {
      grid-template-columns: 18px minmax(0, 1fr) 48px 18px;
      min-height: 62px;
    }

    .audit-state,
    .audit-title,
    .finding-severity,
    .finding-path {
      display: none;
    }
  }
</style>
