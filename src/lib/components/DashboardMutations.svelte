<script lang="ts">
  import { AlertTriangle, CheckCircle2, Play, Tags } from '@lucide/svelte';
  import { buildPrResultMessage, releaseResultMessage } from '$lib/dashboard-view';
  import type { BuildPrResult, ReleaseTagResult } from '$lib/server/github-mutations';
  import type { RepositorySummary } from '$lib/server/github-dashboard';

  type MutationFormState = {
    buildError?: string;
    buildResult?: BuildPrResult;
    releaseError?: string;
    releaseResult?: ReleaseTagResult;
  } | null;

  const BUILD_PR_DISABLED_MESSAGE =
    'Build PR from the UI requires authentication and NULLBUILDER_ENABLE_MUTATIONS=true.';
  const RELEASE_TAG_DISABLED_MESSAGE =
    'Release tags from the UI require authentication and NULLBUILDER_ENABLE_MUTATIONS=true.';

  let {
    authenticated,
    csrfToken,
    form,
    repositories,
    webMutationsAvailable
  }: {
    authenticated: boolean;
    csrfToken: string | null;
    form?: MutationFormState;
    repositories: RepositorySummary[];
    webMutationsAvailable: boolean;
  } = $props();
</script>

<section id="build-pr" class="build-panel">
  <div class="section-heading">
    <h2>Build PR</h2>
    {#if authenticated}
      <form method="POST" action="?/logout" class="inline-form">
        <input name="csrfToken" type="hidden" value={csrfToken ?? ''} />
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
      <a href={form.buildResult.tagUrl} target="_blank" rel="noopener noreferrer">Open</a>
      <a href={form.buildResult.workflowUrl} target="_blank" rel="noopener noreferrer">Runs</a>
    </div>
  {/if}

  {#if !webMutationsAvailable}
    <div class="form-message warning">
      <AlertTriangle size={16} />
      <span>{BUILD_PR_DISABLED_MESSAGE}</span>
    </div>
  {/if}

  <form method="POST" action="?/buildPr" class="build-form">
    <input name="csrfToken" type="hidden" value={csrfToken ?? ''} />

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

    <button disabled={!webMutationsAvailable} type="submit">
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
      <a href={form.releaseResult.tagUrl} target="_blank" rel="noopener noreferrer">Open</a>
      <a href={form.releaseResult.workflowUrl} target="_blank" rel="noopener noreferrer">Runs</a>
    </div>
  {/if}

  {#if !webMutationsAvailable}
    <div class="form-message warning">
      <AlertTriangle size={16} />
      <span>{RELEASE_TAG_DISABLED_MESSAGE}</span>
    </div>
  {/if}

  <form method="POST" action="?/releaseTag" class="build-form release-form">
    <input name="csrfToken" type="hidden" value={csrfToken ?? ''} />

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

    <button disabled={!webMutationsAvailable} type="submit">
      <Play size={17} />
      <span>Run</span>
    </button>
  </form>
</section>

<style>
  .build-panel {
    margin-bottom: 18px;
    overflow: hidden;
    border: 1px solid #ded8c9;
    border-radius: 8px;
    background: #fffdfa;
    padding-bottom: 16px;
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

  .form-message,
  button,
  .checkbox {
    display: flex;
    align-items: center;
  }

  button {
    gap: 8px;
    min-height: 40px;
    border: 1px solid #1f1e1a;
    border-radius: 7px;
    background: #24231f;
    color: #fffaf0;
    padding: 0 14px;
    font: inherit;
    font-weight: 800;
    text-decoration: none;
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
    padding: 0 10px;
    font: inherit;
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
    .build-form {
      grid-template-columns: 1fr;
    }
  }
</style>
