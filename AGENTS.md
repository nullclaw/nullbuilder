# AGENTS.md — NullBuilder Engineering Protocol

Default working protocol for coding agents in this repository. Scope: entire repository.

## 1) Project Snapshot

NullBuilder hosts the **shared CI infrastructure for every null-stack repo**:
reusable GitHub Actions workflows (`zig-ci.yml`, `zig-release.yml`,
`zig-nightly.yml`) plus the release/build tooling they drive. There is no
runtime product here — the "blast radius" of this repo is the whole org's CI.

## 2) Architecture Facts (why this protocol exists)

- Consumer repos invoke these workflows with
  `uses: nullclaw/nullbuilder/.github/workflows/zig-ci.yml@v1`.
  **`v1` is currently a branch, not a tag** (`refs/heads/v1` → `2b9c2f2`; the
  repository has no tags at all). So `@v1` resolves to a *moving* ref: consumers
  follow whatever that branch points at, and every push to `v1` changes every
  consumer's CI at once. A change to `zig-ci.yml` on `main` still reaches no one
  until `v1` moves.
- Promotion procedure for the existing `v1` branch: land and validate the change
  on `main` (§3), then advance the `v1` branch to the validated commit. Treat
  `v1` as a **moving version ref**, not an immutable release — it has no tag
  object behind it. Consumers that need a frozen workflow must pin a **commit
  SHA** (`uses: ...@<sha>`) or a uniquely named tag.
  Do not "fix" this by creating a tag also named `v1`: GitHub gives tags
  precedence over branches with the same name, so a same-named tag would
  silently change what every existing `@v1` consumer resolves to.
- `zig_version` is **optional and inconsistently pinned**: `nullhub` passes
  `zig_version: "0.16.0"` explicitly, while `nullclaw`, `nullboiler` and
  `nullwatch` omit it and inherit the `zig-ci.yml` default (`"0.16.0"`).
  Bumping the default therefore moves those three consumers automatically and
  must be coordinated with their documentation (install guides pin matching
  versions); `nullhub` must be updated separately because it will not follow.
- Dependabot keeps action versions current (#13); its PRs are routine but the
  merged result affects all consumers — review with the matrix in mind.

## 3) Engineering Principles

- Changes here are org-wide by default: one concern per PR, and the PR
  description must name the affected consumer repos.
- Validate workflow edits on a scratch branch/consumer before merging to main.

## 4) Validation

- **What CI actually runs** (`.github/workflows/ci.yml`, job `Test actions`):
  exactly two helper tests —
  `zig test .github/actions/nightly-decide/nightly_decide.zig` and
  `zig test .github/actions/package-artifact/package_artifact.zig`.
  It does **not** lint YAML and does not execute the reusable workflows, so a
  green `Test actions` job says nothing about whether `zig-ci.yml` is valid.
- **Workflow validation is therefore an explicit manual step.** Before merging a
  workflow change, run a YAML/workflow linter locally, e.g.
  `actionlint .github/workflows/*.yml` (or `yamllint .github/workflows/`), and
  fix everything it reports. Nothing in CI will catch it for you.
- For `zig-ci` changes: run at least one consumer repo's PR through the updated
  workflow before advancing `v1` (§2).
