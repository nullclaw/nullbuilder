<script lang="ts">
  import {
    AlertTriangle,
    CheckCircle2,
    Play,
    Tags
  } from '@lucide/svelte';
  import AuthGate from '$lib/components/AuthGate.svelte';
  import DashboardAudit from '$lib/components/DashboardAudit.svelte';
  import DashboardMetrics from '$lib/components/DashboardMetrics.svelte';
  import DashboardRepositories from '$lib/components/DashboardRepositories.svelte';
  import DashboardTopbar from '$lib/components/DashboardTopbar.svelte';
  import DashboardWorkLists from '$lib/components/DashboardWorkLists.svelte';
  import {
    DASHBOARD_SECTIONS,
    authStateLabel,
    buildPrResultMessage,
    dashboardOwner,
    hasDashboardReadErrors,
    releaseResultMessage
  } from '$lib/dashboard-view';
  import type { ActionData, PageData } from './$types';

  let { data, form }: { data: PageData; form?: ActionData } = $props();

  const dashboard = $derived(data.dashboard);
  const audit = $derived(data.audit);
  const owner = $derived(dashboardOwner(dashboard));
  const repositories = $derived(dashboard?.repositories ?? []);
  const issues = $derived(dashboard?.issues ?? []);
  const pullRequests = $derived(dashboard?.pullRequests ?? []);
  const hasErrors = $derived(hasDashboardReadErrors(repositories, audit));
  const tokenState = $derived(authStateLabel(data.authenticated, data.authRequired));
</script>

<svelte:head>
  <title>nullbuilder Command Center</title>
  <meta
    name="description"
    content="Repository issue, pull request, workflow, star, and build tag dashboard for nullbuilder-managed Zig projects."
  />
</svelte:head>

<main class="shell">
  <DashboardTopbar authenticated={data.authenticated} hasToken={Boolean(dashboard?.hasToken)} {owner} {tokenState} />

  {#if !dashboard}
    <AuthGate authConfigured={data.authConfigured} authError={form?.authError} />
  {:else}
  {#if hasErrors}
    <section class="notice">
      <AlertTriangle size={18} />
      <span>Some repositories could not be loaded. Check names, token scopes, or API rate limits.</span>
    </section>
  {/if}

  <DashboardMetrics auditAverageScore={audit?.totals.averageScore ?? 0} totals={dashboard.totals} />

  <nav class="section-tabs" aria-label="Sections">
    {#each DASHBOARD_SECTIONS as section}
      <a href="#{section.id}">{section.label}</a>
    {/each}
  </nav>

  <DashboardRepositories {repositories} />

  <DashboardAudit {audit} />

  <DashboardWorkLists {hasErrors} {issues} {pullRequests} />

  <section id="build-pr" class="build-panel">
    <div class="section-heading">
      <h2>Build PR</h2>
      {#if data.authenticated}
        <form method="POST" action="?/logout" class="inline-form">
          <input name="csrfToken" type="hidden" value={data.csrfToken ?? ''} />
          <button class="secondary-button" type="submit">
            <span>Lock</span>
          </button>
        </form>
      {:else}
        <Tags size={18} />
      {/if}
    </div>

    {#if form?.buildError}
      <div class="form-message error">
        <AlertTriangle size={16} />
        <span>{form.buildError}</span>
      </div>
    {/if}

    {#if form?.buildResult}
      <div class="form-message success">
        <CheckCircle2 size={16} />
        <span>
          {buildPrResultMessage(form.buildResult)}
        </span>
        <a href={form.buildResult.tagUrl} target="_blank" rel="noreferrer">Open</a>
        <a href={form.buildResult.workflowUrl} target="_blank" rel="noreferrer">Runs</a>
      </div>
    {/if}

    {#if !data.webMutationsAvailable}
      <div class="form-message warning">
        <AlertTriangle size={16} />
        <span>
          Build PR from the UI requires authentication and NULLBUILDER_ENABLE_MUTATIONS=true.
        </span>
      </div>
    {/if}

    <form method="POST" action="?/buildPr" class="build-form">
      <input name="csrfToken" type="hidden" value={data.csrfToken ?? ''} />

      <label>
        <span>Repository</span>
        <select name="repo" required>
          {#each repositories as repo}
            <option value={repo.slug}>{repo.slug}</option>
          {/each}
        </select>
      </label>

      <label>
        <span>PR</span>
        <input name="prNumber" inputmode="numeric" min="1" placeholder="17" required type="number" />
      </label>

      <label>
        <span>Tag</span>
        <input name="tagName" placeholder="build-pr-17" />
      </label>

      <label class="checkbox">
        <input name="confirm" type="checkbox" />
        <span>confirm</span>
      </label>

      <label class="checkbox">
        <input name="force" type="checkbox" />
        <span>force</span>
      </label>

      <button disabled={!data.webMutationsAvailable} type="submit">
        <Play size={17} />
        <span>Run</span>
      </button>
    </form>
  </section>

  <section id="release-tag" class="build-panel">
    <div class="section-heading">
      <h2>Release Tag</h2>
      <Tags size={18} />
    </div>

    {#if form?.releaseError}
      <div class="form-message error">
        <AlertTriangle size={16} />
        <span>{form.releaseError}</span>
      </div>
    {/if}

    {#if form?.releaseResult}
      <div class="form-message success">
        <CheckCircle2 size={16} />
        <span>
          {releaseResultMessage(form.releaseResult)}
        </span>
        <a href={form.releaseResult.tagUrl} target="_blank" rel="noreferrer">Open</a>
        <a href={form.releaseResult.workflowUrl} target="_blank" rel="noreferrer">Runs</a>
      </div>
    {/if}

    {#if !data.webMutationsAvailable}
      <div class="form-message warning">
        <AlertTriangle size={16} />
        <span>
          Release tags from the UI require authentication and NULLBUILDER_ENABLE_MUTATIONS=true.
        </span>
      </div>
    {/if}

    <form method="POST" action="?/releaseTag" class="build-form release-form">
      <input name="csrfToken" type="hidden" value={data.csrfToken ?? ''} />

      <label>
        <span>Repository</span>
        <select name="repo" required>
          {#each repositories as repo}
            <option value={repo.slug}>{repo.slug}</option>
          {/each}
        </select>
      </label>

      <label>
        <span>Tag</span>
        <input name="tagName" placeholder="v1.2.3" required />
      </label>

      <label>
        <span>Ref</span>
        <input name="targetRef" placeholder="default branch" />
      </label>

      <label class="checkbox">
        <input name="confirm" type="checkbox" />
        <span>confirm</span>
      </label>

      <label class="checkbox">
        <input name="force" type="checkbox" />
        <span>force</span>
      </label>

      <button disabled={!data.webMutationsAvailable} type="submit">
        <Play size={17} />
        <span>Run</span>
      </button>
    </form>
  </section>
  {/if}
</main>

<style>
  :global(body) {
    margin: 0;
    background: #f7f5ef;
    color: #24231f;
    font-family:
      Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  }

  :global(a) {
    color: inherit;
  }

  .shell {
    width: min(1440px, calc(100vw - 32px));
    margin: 0 auto;
    padding: 28px 0 48px;
  }

  h2 {
    margin: 0;
  }

  .section-tabs,
  .form-message,
  button,
  .checkbox {
    display: flex;
    align-items: center;
  }

  button {
    gap: 8px;
    border: 1px solid #1f1e1a;
    border-radius: 7px;
    background: #24231f;
    color: #fffaf0;
    font: inherit;
    font-weight: 800;
    min-height: 40px;
    padding: 0 14px;
    text-decoration: none;
  }

  button {
    cursor: pointer;
  }

  button:disabled {
    cursor: not-allowed;
    opacity: 0.55;
  }

  .inline-form {
    margin: 0;
  }

  .secondary-button {
    border-color: #cfc7b5;
    background: #fff;
    color: #24231f;
  }

  .notice {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-bottom: 18px;
    border-left: 4px solid #c95f3f;
    background: #fff;
    padding: 12px 14px;
  }

  .section-tabs {
    position: sticky;
    top: 0;
    z-index: 2;
    gap: 4px;
    margin-bottom: 18px;
    border-bottom: 1px solid #d9d2bf;
    background: #f7f5ef;
    padding: 8px 0;
  }

  .section-tabs a {
    border-radius: 6px;
    padding: 9px 13px;
    color: #4b493f;
    font-size: 0.9rem;
    font-weight: 800;
    text-decoration: none;
  }

  .section-tabs a:hover {
    background: #ece6d7;
  }

  .build-panel {
    border: 1px solid #ded8c9;
    border-radius: 8px;
    background: #fffdfa;
  }

  .build-panel {
    margin-bottom: 18px;
    overflow: hidden;
  }

  .section-heading {
    display: flex;
    align-items: center;
    justify-content: space-between;
    border-bottom: 1px solid #e2dac8;
    padding: 14px 16px;
  }

  .section-heading h2 {
    font-size: 1rem;
  }

  .section-heading span {
    color: #6f6b60;
    font-weight: 800;
  }

  .build-panel {
    padding-bottom: 16px;
  }

  .form-message {
    gap: 8px;
    margin: 12px 16px 0;
    border-radius: 7px;
    padding: 10px 12px;
    font-weight: 800;
  }

  .form-message a {
    margin-left: auto;
  }

  .form-message.error {
    background: #fff1ed;
    color: #943f28;
  }

  .form-message.success {
    background: #f0faef;
    color: #236d3a;
  }

  .form-message.warning {
    background: #fff8df;
    color: #765508;
  }

  .build-form {
    display: grid;
    grid-template-columns: minmax(180px, 1.4fr) minmax(90px, 0.5fr) minmax(180px, 1fr) auto auto auto;
    gap: 12px;
    align-items: end;
    padding: 16px;
  }

  .release-form {
    grid-template-columns: minmax(180px, 1.2fr) minmax(150px, 0.8fr) minmax(180px, 1fr) auto auto auto;
  }

  label {
    display: grid;
    gap: 6px;
    color: #4c493f;
    font-size: 0.82rem;
    font-weight: 800;
  }

  input,
  select {
    box-sizing: border-box;
    width: 100%;
    min-height: 40px;
    border: 1px solid #cfc7b5;
    border-radius: 7px;
    background: #fff;
    color: #24231f;
    font: inherit;
    padding: 0 10px;
  }

  .checkbox {
    gap: 7px;
    min-height: 40px;
  }

  .checkbox input {
    width: 16px;
    min-height: 16px;
  }

  @media (max-width: 1100px) {
    .build-form {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
  }

  @media (max-width: 720px) {
    .shell {
      width: min(100vw - 20px, 720px);
      padding-top: 18px;
    }

    .build-form {
      grid-template-columns: 1fr;
    }

    .section-tabs {
      overflow-x: auto;
    }
  }
</style>
