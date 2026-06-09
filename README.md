# nullbuilder

Shared GitHub Actions workflows for NullClaw Zig projects.

## Command Center

`nullbuilder` also includes a SvelteKit dashboard and CLI for operating the Zig
repositories that use these workflows.

```sh
npm install
npm run dev
```

The dashboard reads GitHub data server-side and shows open issues, pull
requests, current stars, recent star growth, latest CI/nightly/release workflow
runs, repository audit findings, and quick links back to GitHub.

Configure repositories and authentication with environment variables:

```sh
cp .env.example .env
```

```sh
NULLBUILDER_OWNER=nullclaw
NULLBUILDER_REPOS=nullbuilder,nullclaw,nullboiler,nullhub,nullPantry,nllclw,nulldesk,nullwatch,nulltickets,nullcap
NULLBUILDER_IGNORE_REPOS=sentry-zig,nullclaw-channel-whatsmeow-bridge,nullclaw-channel-baileys,nullclaw-channel-imap-connector,wasm3,websocket
NULLBUILDER_WEB_TOKEN=long-random-web-token
NULLBUILDER_ENABLE_MUTATIONS=false
NULLBUILDER_GITHUB_TOKEN=github_pat_...
```

`NULLBUILDER_GITHUB_TOKEN` is optional for public read-only data, but required
for private repositories and write operations such as creating build tags. Set
`NULLBUILDER_DISCOVER_REPOS=true` to add public Zig/null repositories discovered
under `NULLBUILDER_OWNER` to the configured list. Discovery skips
`NULLBUILDER_IGNORE_REPOS` so forks and channel connector repositories do not
crowd the default command center.

If `NULLBUILDER_GITHUB_TOKEN` is present, configure `NULLBUILDER_WEB_TOKEN`
before exposing the dashboard so server-side token-backed data is not
anonymously visible. The web UI only creates build tags when both
`NULLBUILDER_WEB_TOKEN` authentication has succeeded and
`NULLBUILDER_ENABLE_MUTATIONS=true` is set. Use a high-entropy web token; the
app rate-limits failed login attempts in-process and protects write forms with
request tokens.

### CLI

Run locally through npm:

```sh
npm run nb -- repos
npm run nb -- issues
npm run nb -- prs
npm run nb -- runs
npm run nb -- stars
npm run nb -- audit
npm run test
```

Every list command supports `--repo <name>` and `--json`. `audit` checks each
repository for branch protection visibility, SECURITY.md, Dependabot,
CODEOWNERS, nullbuilder workflow callers, dangerous workflow triggers, explicit
workflow token permissions, and mutable or unpinned workflow references.

### Zig TUI

Build and run the terminal command center with Zig:

```sh
zig build tui
zig build test
zig build tui -- release-tag nullclaw --tag v2026.6.9
zig build tui -- build-pr nullclaw --pr 17 --tag build-pr-17-a1b2c3d
```

The TUI reuses the local `nullbuilder` CLI for GitHub reads and write guards,
then renders a compact terminal dashboard with repository status, issues, PRs,
workflow state, and load errors. Set `NULLBUILDER_NODE_CLI` if the Node CLI is
not available at `./bin/nullbuilder.js`.

### Self Build

`nullbuilder` dogfoods its own reusable workflows. The repository CI calls
`./.github/workflows/zig-ci.yml` to run the Svelte/CLI checks and build
`nullbuilder-tui`. Tags matching `v*` or `build-pr-*` call
`./.github/workflows/zig-release.yml` to build release artifacts for the TUI.

### Build PR

`build-pr` resolves a pull request, takes its head SHA, and creates a lightweight
`build-pr-*` Git tag. Target repositories should include a tag-triggered build
workflow that calls `zig-release.yml`. The release workflow uploads build
artifacts for `build-pr-*` tags but only creates GitHub Releases for `v*` tags.
Tag names must start with `build-pr-` and may only contain letters, numbers,
dots, underscores, and dashes. The command is a dry run unless `--confirm` is
passed:

```sh
npm run nb -- build-pr nullclaw --pr 17 --tag build-pr-17-a1b2c3d
npm run nb -- build-pr nullclaw --pr 17 --tag build-pr-17-a1b2c3d --confirm
```

Use `--force` with `--confirm` to move an existing build tag to the current PR
head SHA. By default `build-pr` rejects draft PRs, fork PRs, and PRs whose base
branch is not the repository default branch. The CLI exposes
`--allow-draft`, `--allow-fork`, and `--allow-non-default-base` for deliberate
operator overrides.

### Release Tag

`release-tag` creates a lightweight `v*` Git tag for a configured repository and
is also a dry run unless `--confirm` is passed. By default it tags the
repository default branch; pass `--ref <branch-or-sha>` to target another branch
or a specific commit SHA. Use `--force` with `--confirm` only when deliberately
moving an existing release tag.

```sh
npm run nb -- release-tag nullclaw --tag v2026.6.9
npm run nb -- release-tag nullclaw --tag v2026.6.9 --confirm
npm run nb -- release-tag nullclaw --tag v2026.6.9 --ref release/v2026.6.9
```

Recommended workflow in each target repository:

```yaml
name: Build PR

on:
  push:
    tags:
      - build-pr-*

jobs:
  build:
    uses: nullclaw/nullbuilder/.github/workflows/zig-release.yml@v1
    permissions:
      contents: read
    with:
      binary_name: nullclaw
      artifact_prefix: nullclaw
      build_version: ${{ github.ref_name }}
```

## Workflows

Use `@v1` from project repositories.

### CI

```yaml
jobs:
  ci:
    uses: nullclaw/nullbuilder/.github/workflows/zig-ci.yml@v1
    permissions:
      contents: read
    with:
      binary_name: nullclaw
      artifact_prefix: nullclaw
```

Projects with generated assets can install Node, run setup hooks, customize the
matrix, and attach one E2E command to a single target:

```yaml
jobs:
  zig:
    uses: nullclaw/nullbuilder/.github/workflows/zig-ci.yml@v1
    permissions:
      contents: read
    with:
      binary_name: nullhub
      artifact_prefix: nullhub
      node_version: 22
      node_cache_dependency_path: ui/package-lock.json
      test_command: zig build test -Dembed-ui=false -Dbuild-ui=false --summary all
      pre_build_command: |
        npm --prefix ui ci --no-audit --no-fund
        npm --prefix ui run build
      build_args: -Dbuild-ui=false
      e2e_command: bash tests/test_e2e.sh
      targets_json: >-
        [
          {"os":"ubuntu-latest","target":"linux-x86_64","zig_target":"x86_64-linux-musl"},
          {"os":"ubuntu-latest","target":"linux-aarch64","zig_target":"aarch64-linux-musl"},
          {"os":"macos-latest","target":"macos-aarch64","zig_target":"aarch64-macos"},
          {"os":"windows-latest","target":"windows-x86_64","zig_target":"x86_64-windows"}
        ]
```

### Nightly

```yaml
jobs:
  nightly:
    uses: nullclaw/nullbuilder/.github/workflows/zig-nightly.yml@v1
    permissions:
      actions: read
      contents: read
    with:
      binary_name: nullclaw
      artifact_prefix: nullclaw
      force: ${{ inputs.force || false }}
```

### Release

```yaml
jobs:
  release:
    uses: nullclaw/nullbuilder/.github/workflows/zig-release.yml@v1
    permissions:
      contents: write
      packages: write
    secrets: inherit
    with:
      binary_name: nullclaw
      artifact_prefix: nullclaw
      publish_docker: true
```

Release builds support the same Node/pre-build and target-matrix inputs.
`build_version` can override the value passed to `zig build -Dversion=...`.
Projects that publish generated source archives can enable `source_archive` and
provide a `source_prepare_command`.

Workflow file-name inputs such as `binary_name`, `artifact_prefix`, and
`source_archive_name` are validated as simple basenames. Use letters, numbers,
dots, underscores, and dashes; source archives must end in `.tar.gz`.
