<script lang="ts">
  import {
    AlertTriangle,
    ArrowRight,
    CheckCircle2,
    CircleDot,
    ExternalLink,
    GitBranch,
    GitPullRequest,
    Play,
    RefreshCw,
    ShieldCheck,
    Star,
    Tags,
    XCircle
  } from '@lucide/svelte';
  import {
    DASHBOARD_SECTIONS,
    authStateLabel,
    buildPrResultMessage,
    dashboardOwner,
    hasDashboardReadErrors,
    releaseResultMessage,
    visibleAuditFindings
  } from '$lib/dashboard-view';
  import {
    formatDashboardDate,
    formatGrowth,
    formatNullableNumber,
    workflowRunClass,
    workflowRunLabel
  } from '$lib/dashboard-format';
  import type { ActionData, PageData } from './$types';

  let { data, form }: { data: PageData; form?: ActionData } = $props();

  const dashboard = $derived(data.dashboard);
  const audit = $derived(data.audit);
  const owner = $derived(dashboardOwner(dashboard));
  const repositories = $derived(dashboard?.repositories ?? []);
  const issues = $derived(dashboard?.issues ?? []);
  const pullRequests = $derived(dashboard?.pullRequests ?? []);
  const auditRepositories = $derived(audit?.repositories ?? []);
  const auditFindings = $derived(audit?.findings ?? []);
  const visibleFindings = $derived(visibleAuditFindings(auditFindings));
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
  <header class="topbar">
    <div>
      <p class="eyebrow">nullbuilder</p>
      <h1>Command Center</h1>
    </div>
    <div class="top-actions">
      <span class:ok={data.authenticated || dashboard?.hasToken} class="token-state">
        {tokenState}
      </span>
      <a class="icon-button" href="https://github.com/{owner}" target="_blank" rel="noreferrer">
        <ExternalLink size={17} />
        <span>GitHub</span>
      </a>
    </div>
  </header>

  {#if !dashboard}
    <section class="auth-panel">
      <div>
        <h2>{data.authConfigured ? 'Authentication Required' : 'Web Token Required'}</h2>
        <p>
          {data.authConfigured
            ? 'Enter the configured web token to unlock the dashboard.'
            : 'Set NULLBUILDER_WEB_TOKEN before exposing token-backed dashboard data.'}
        </p>
      </div>

      {#if form?.authError}
        <div class="form-message error">
          <AlertTriangle size={16} />
          <span>{form.authError}</span>
        </div>
      {/if}

      {#if data.authConfigured}
        <form method="POST" action="?/login" class="login-form">
          <label>
            <span>Web token</span>
            <input name="webToken" autocomplete="current-password" required type="password" />
          </label>
          <button type="submit">
            <Play size={17} />
            <span>Unlock</span>
          </button>
        </form>
      {/if}
    </section>
  {:else}
  {#if hasErrors}
    <section class="notice">
      <AlertTriangle size={18} />
      <span>Some repositories could not be loaded. Check names, token scopes, or API rate limits.</span>
    </section>
  {/if}

  <section class="metrics" aria-label="Dashboard totals">
    <div class="metric">
      <CircleDot size={18} />
      <span>Loaded</span>
      <strong>{dashboard.totals.loadedRepositories}</strong>
    </div>
    <div class="metric">
      <AlertTriangle size={18} />
      <span>Errors</span>
      <strong>{dashboard.totals.erroredRepositories}</strong>
    </div>
    <div class="metric">
      <CircleDot size={18} />
      <span>Total</span>
      <strong>{dashboard.totals.repositories}</strong>
    </div>
    <div class="metric">
      <CircleDot size={18} />
      <span>Issues</span>
      <strong>{dashboard.totals.issues}</strong>
    </div>
    <div class="metric">
      <GitPullRequest size={18} />
      <span>PRs</span>
      <strong>{dashboard.totals.pullRequests}</strong>
    </div>
    <div class="metric">
      <Star size={18} />
      <span>Stars</span>
      <strong>{dashboard.totals.stars}</strong>
    </div>
    <div class="metric">
      <XCircle size={18} />
      <span>Failing</span>
      <strong>{dashboard.totals.failingRuns}</strong>
    </div>
    <div class="metric">
      <ShieldCheck size={18} />
      <span>Audit</span>
      <strong>{audit?.totals.averageScore ?? 0}</strong>
    </div>
  </section>

  <nav class="section-tabs" aria-label="Sections">
    {#each DASHBOARD_SECTIONS as section}
      <a href="#{section.id}">{section.label}</a>
    {/each}
  </nav>

  <section id="repos" class="repo-grid" aria-label="Repositories">
    {#each repositories as repo}
      <article class:error={repo.error} class="repo-card">
        <header>
          <div>
            <h2>{repo.name}</h2>
            <p>{repo.description || repo.fullName}</p>
          </div>
          <a class="repo-link" href={repo.url} target="_blank" rel="noreferrer" aria-label="Open {repo.fullName}">
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
            <a class={workflowRunClass(repo.latestRuns.ci)} href={repo.latestRuns.ci?.url ?? repo.url} target="_blank" rel="noreferrer">
              <CheckCircle2 size={15} />
              <span>CI</span>
              <strong>{workflowRunLabel(repo.latestRuns.ci)}</strong>
            </a>
            <a
              class={workflowRunClass(repo.latestRuns.nightly)}
              href={repo.latestRuns.nightly?.url ?? repo.url}
              target="_blank"
              rel="noreferrer"
            >
              <RefreshCw size={15} />
              <span>Nightly</span>
              <strong>{workflowRunLabel(repo.latestRuns.nightly)}</strong>
            </a>
            <a
              class={workflowRunClass(repo.latestRuns.release)}
              href={repo.latestRuns.release?.url ?? repo.url}
              target="_blank"
              rel="noreferrer"
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

  <section id="audit" class="panel">
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
        {#each auditRepositories as repo}
          <a class:error={repo.status === 'error'} class="audit-row" href={repo.url} target="_blank" rel="noreferrer">
            <ShieldCheck size={16} />
            <span class="audit-repo">{repo.repo}</span>
            <strong>{repo.score}</strong>
            <span>{repo.status === 'error' ? 'error' : repo.findings[0]?.severity ?? 'ok'}</span>
            <span>{repo.error ?? repo.findings[0]?.title ?? 'ok'}</span>
            <ArrowRight size={16} />
          </a>
        {/each}
      </div>

      <div class="audit-findings">
        {#each visibleFindings as finding}
          <a class="audit-finding {finding.severity}" href={finding.url ?? `https://github.com/${finding.repo}`} target="_blank" rel="noreferrer">
            <AlertTriangle size={16} />
            <span>{finding.severity}</span>
            <strong>{finding.repo}</strong>
            <span>{finding.title}</span>
            <small>{finding.path ?? finding.area}</small>
          </a>
        {:else}
          <p class="empty">No audit findings.</p>
        {/each}
      </div>
    {:else}
      <p class="empty">Audit unavailable.</p>
    {/if}
  </section>

  <section id="issues" class="panel">
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
          <span>{formatDashboardDate(issue.updatedAt)}</span>
          <ArrowRight size={16} />
        </a>
      {:else}
        <p class="empty">{hasErrors ? 'No issue rows from loaded repositories.' : 'No open issues.'}</p>
      {/each}
    </div>
  </section>

  <section id="prs" class="panel">
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
          <span>{pull.draft ? 'draft' : pull.headBranch}</span>
          <ArrowRight size={16} />
        </a>
      {:else}
        <p class="empty">{hasErrors ? 'No PR rows from loaded repositories.' : 'No open pull requests.'}</p>
      {/each}
    </div>
  </section>

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

  .topbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 18px;
    margin-bottom: 22px;
  }

  .eyebrow {
    margin: 0 0 4px;
    color: #6d6a5f;
    font-size: 0.78rem;
    font-weight: 700;
    text-transform: uppercase;
  }

  h1,
  h2,
  p {
    margin: 0;
  }

  h1 {
    font-size: clamp(2rem, 3vw, 3.2rem);
    line-height: 1;
  }

  .top-actions,
  .icon-button,
  .repo-stats,
  .repo-stats span,
  .section-tabs,
  .metric,
  .repo-link,
  .form-message,
  button,
  .checkbox {
    display: flex;
    align-items: center;
  }

  .top-actions {
    gap: 10px;
  }

  .token-state {
    border: 1px solid #cfc8b4;
    border-radius: 999px;
    padding: 8px 12px;
    color: #756f61;
    font-size: 0.88rem;
    font-weight: 700;
  }

  .token-state.ok {
    border-color: #8fc7a3;
    color: #277245;
  }

  .icon-button,
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

  .auth-panel {
    display: grid;
    gap: 16px;
    border: 1px solid #ded8c9;
    border-radius: 8px;
    background: #fffdfa;
    padding: 18px;
  }

  .auth-panel h2 {
    font-size: 1rem;
  }

  .auth-panel p {
    margin-top: 6px;
    color: #6f6b60;
  }

  .login-form {
    display: grid;
    grid-template-columns: minmax(220px, 360px) auto;
    gap: 12px;
    align-items: end;
  }

  .metrics {
    display: grid;
    grid-template-columns: repeat(8, minmax(0, 1fr));
    gap: 10px;
    margin-bottom: 18px;
  }

  .metric {
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

  .repo-grid {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 12px;
    margin-bottom: 24px;
  }

  .repo-card,
  .panel,
  .build-panel {
    border: 1px solid #ded8c9;
    border-radius: 8px;
    background: #fffdfa;
  }

  .repo-card {
    min-height: 244px;
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
    overflow-wrap: anywhere;
    font-size: 1.12rem;
  }

  .repo-card p {
    margin-top: 4px;
    color: #6f6b60;
    font-size: 0.9rem;
    line-height: 1.35;
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

  .panel,
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

  .work-number {
    color: #3f7364;
  }

  .empty {
    padding: 16px;
    color: #6f6b60;
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
    .repo-grid,
    .audit-summary,
    .metrics {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }

    .build-form,
    .login-form {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
  }

  @media (max-width: 720px) {
    .shell {
      width: min(100vw - 20px, 720px);
      padding-top: 18px;
    }

    .topbar,
    .top-actions {
      align-items: stretch;
      flex-direction: column;
    }

    .metrics,
    .repo-grid,
    .audit-summary,
    .build-form,
    .login-form {
      grid-template-columns: 1fr;
    }

    .section-tabs {
      overflow-x: auto;
    }

    .run-grid {
      grid-template-columns: 1fr;
    }

    .work-row {
      grid-template-columns: 18px 64px minmax(0, 1fr) 18px;
      min-height: 62px;
    }

    .audit-row,
    .audit-finding {
      grid-template-columns: 18px minmax(0, 1fr) 48px 18px;
      min-height: 62px;
    }

    .work-row .work-repo,
    .work-row > span:last-of-type,
    .audit-row > span:nth-of-type(2),
    .audit-row > span:nth-of-type(3),
    .audit-finding > span:first-of-type,
    .audit-finding > small {
      display: none;
    }
  }
</style>
