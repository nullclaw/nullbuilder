<script lang="ts">
  import { ExternalLink } from '@lucide/svelte';

  let {
    authenticated,
    hasToken,
    owner,
    tokenState
  }: {
    authenticated: boolean;
    hasToken: boolean;
    owner: string;
    tokenState: string;
  } = $props();
</script>

<header class="topbar">
  <div>
    <p class="eyebrow">nullbuilder</p>
    <h1>Command Center</h1>
  </div>
  <div class="top-actions">
    <span class:ok={authenticated || hasToken} class="token-state">
      {tokenState}
    </span>
    <a class="icon-button" href="https://github.com/{owner}" target="_blank" rel="noreferrer">
      <ExternalLink size={17} />
      <span>GitHub</span>
    </a>
  </div>
</header>

<style>
  .topbar,
  .top-actions,
  .icon-button {
    display: flex;
    align-items: center;
  }

  .topbar {
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
  p {
    margin: 0;
  }

  h1 {
    font-size: clamp(2rem, 3vw, 3.2rem);
    line-height: 1;
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

  .icon-button {
    gap: 8px;
    min-height: 40px;
    border: 1px solid #1f1e1a;
    border-radius: 7px;
    background: #24231f;
    color: #fffaf0;
    font: inherit;
    font-weight: 800;
    padding: 0 14px;
    text-decoration: none;
  }

  @media (max-width: 720px) {
    .topbar,
    .top-actions {
      align-items: stretch;
      flex-direction: column;
    }
  }
</style>
