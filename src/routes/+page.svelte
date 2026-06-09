<script lang="ts">
  import { AlertTriangle } from '@lucide/svelte';
  import AuthGate from '$lib/components/AuthGate.svelte';
  import DashboardAudit from '$lib/components/DashboardAudit.svelte';
  import DashboardMetrics from '$lib/components/DashboardMetrics.svelte';
  import DashboardMutations from '$lib/components/DashboardMutations.svelte';
  import DashboardRepositories from '$lib/components/DashboardRepositories.svelte';
  import DashboardTopbar from '$lib/components/DashboardTopbar.svelte';
  import DashboardWorkLists from '$lib/components/DashboardWorkLists.svelte';
  import {
    DASHBOARD_SECTIONS,
    authStateLabel,
    dashboardOwner,
    hasDashboardReadErrors
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

  <DashboardMutations
    authenticated={data.authenticated}
    csrfToken={data.csrfToken}
    {form}
    {repositories}
    webMutationsAvailable={data.webMutationsAvailable}
  />
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

  .section-tabs {
    display: flex;
    align-items: center;
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

  @media (max-width: 720px) {
    .shell {
      width: min(100vw - 20px, 720px);
      padding-top: 18px;
    }

    .section-tabs {
      overflow-x: auto;
    }
  }
</style>
