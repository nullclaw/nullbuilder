# AGENTS.md — NullBuilder Engineering Protocol

Default working protocol for coding agents in this repository. Scope: entire repository.

## 1) Project Snapshot

NullBuilder hosts the **shared CI infrastructure for every null-stack repo**:
reusable GitHub Actions workflows (`zig-ci.yml`, `zig-release.yml`,
`zig-nightly.yml`) plus the release/build tooling they drive. There is no
runtime product here — the "blast radius" of this repo is the whole org's CI.

## 2) Architecture Facts (why this protocol exists)

- Consumer repos invoke these workflows **pinned to a version tag**
  (e.g. `nullclaw/nullbuilder/.github/workflows/zig-ci.yml@v1`). A change to
  `zig-ci.yml` on main changes nothing for consumers until the tag is moved —
  and moving the tag changes every repo's CI at once.
- Therefore: workflow changes land on main first, are validated against at
  least one consumer repo, and only then does the version tag move. Never edit
  a published tag's semantics casually.
- `zig_version` is pinned per consumer (e.g. `"0.16.0"`); bumping the default
  toolchain here must be coordinated with consumer repos' documentation
  (install guides pin matching versions).
- Dependabot keeps action versions current (#13); its PRs are routine but the
  merged result affects all consumers — review with the matrix in mind.

## 3) Engineering Principles

- Changes here are org-wide by default: one concern per PR, and the PR
  description must name the affected consumer repos.
- Validate workflow edits on a scratch branch/consumer before merging to main.

## 4) Validation

- YAML sanity: the CI itself lints these workflows on push.
- For zig-ci changes: run at least one consumer repo's PR through the updated
  workflow before moving any published tag.
