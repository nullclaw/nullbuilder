<script lang="ts">
  import { AlertTriangle, Play } from '@lucide/svelte';
  import { authGateCopy } from '$lib/dashboard-view';

  let {
    authConfigured,
    authError
  }: {
    authConfigured: boolean;
    authError?: string;
  } = $props();

  const copy = $derived(authGateCopy(authConfigured));
</script>

<section class="auth-panel">
  <div>
    <h2>{copy.title}</h2>
    <p>{copy.description}</p>
  </div>

  {#if authError}
    <div class="form-message error">
      <AlertTriangle size={16} />
      <span>{authError}</span>
    </div>
  {/if}

  {#if authConfigured}
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

<style>
  .auth-panel {
    display: grid;
    gap: 16px;
    border: 1px solid #ded8c9;
    border-radius: 8px;
    background: #fffdfa;
    padding: 18px;
  }

  h2,
  p {
    margin: 0;
  }

  h2 {
    font-size: 1rem;
  }

  p {
    margin-top: 6px;
    color: #6f6b60;
  }

  .form-message,
  button {
    display: flex;
    align-items: center;
  }

  .form-message {
    gap: 8px;
    border-radius: 7px;
    padding: 10px 12px;
    font-weight: 800;
  }

  .form-message.error {
    background: #fff1ed;
    color: #943f28;
  }

  .login-form {
    display: grid;
    grid-template-columns: minmax(220px, 360px) auto;
    gap: 12px;
    align-items: end;
  }

  label {
    display: grid;
    gap: 6px;
    color: #4c493f;
    font-size: 0.82rem;
    font-weight: 800;
  }

  input {
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

  button {
    gap: 8px;
    min-height: 40px;
    border: 1px solid #1f1e1a;
    border-radius: 7px;
    background: #24231f;
    color: #fffaf0;
    cursor: pointer;
    font: inherit;
    font-weight: 800;
    padding: 0 14px;
  }

  @media (max-width: 1100px) {
    .login-form {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
  }

  @media (max-width: 720px) {
    .login-form {
      grid-template-columns: 1fr;
    }
  }
</style>
