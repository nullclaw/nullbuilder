# nullbuilder

Shared GitHub Actions workflows for NullClaw Zig projects.

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
