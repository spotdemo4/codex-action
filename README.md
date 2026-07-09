# codex-action

[![check](https://trev.zip/llc/codex-action/actions/workflows/check.yaml/badge.svg?branch=main&logo=forgejo&logoColor=%23bac2de&label=check&labelColor=%23313244)](https://trev.zip/llc/codex-action/actions?workflow=check.yaml)
[![vulnerable](https://trev.zip/llc/codex-action/actions/workflows/vulnerable.yaml/badge.svg?branch=main&logo=forgejo&logoColor=%23bac2de&label=vulnerable&labelColor=%23313244)](https://trev.zip/llc/codex-action/actions?workflow=vulnerable.yaml)
[![node](https://img.shields.io/badge/dynamic/json?url=https://trev.zip/llc/codex-action/raw/branch/main/package.json&query=%24.engines.node&logo=nodedotjs&logoColor=%23bac2de&label=version&labelColor=%23313244&color=%23339933)](https://nodejs.org/en/about/previous-releases)

Use Codex in a GitHub/Gitea/Forgejo action

## Examples

### GitHub App

This is the recommended GitHub setup. The action creates a repository-scoped
installation token with the permissions it needs, stores refreshed Codex auth in
`CODEX_ACTION_AUTH`, and commits as `<app-slug>[bot]`.

```yaml
name: codex

on:
  workflow_dispatch:

permissions:
  contents: read

jobs:
  codex:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          persist-credentials: false

      - uses: spotdemo4/codex-action@main
        with:
          auth: ${{ secrets.CODEX_ACTION_AUTH }}
          client-id: ${{ vars.CLIENT_ID }}
          private-key: ${{ secrets.PRIVATE_KEY }}
          prompt: Update the documentation for the latest changes.
```

The GitHub App installation must grant these repository permissions:

- Contents: read and write
- Issues: read and write
- Pull requests: read and write
- Secrets: read and write

### Prompt File

If `prompt` points to a file in the workspace, the action reads that file.
Otherwise, the input value is used as the prompt text.

```yaml
- uses: spotdemo4/codex-action@main
  with:
    auth: ${{ secrets.CODEX_ACTION_AUTH }}
    client-id: ${{ vars.CLIENT_ID }}
    private-key: ${{ secrets.PRIVATE_KEY }}
    prompt: .github/prompts/refactor.md
```

### Pull Requests

On pull request events, Codex can leave a PR comment and optionally toggle
automerge.

```yaml
name: codex-pr

on:
  pull_request:

jobs:
  codex:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          persist-credentials: false

      - uses: spotdemo4/codex-action@main
        with:
          auth: ${{ secrets.CODEX_ACTION_AUTH }}
          client-id: ${{ vars.CLIENT_ID }}
          private-key: ${{ secrets.PRIVATE_KEY }}
          automerge: true
          prompt: Review this pull request and fix straightforward issues.
```

### Gitea or Forgejo

On Gitea and Forgejo, pass a token with repository contents, pull request, issue
comment, and Actions secret access.

```yaml
name: codex

on:
  workflow_dispatch:

jobs:
  codex:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          persist-credentials: false

      - uses: spotdemo4/codex-action@main
        with:
          auth: ${{ secrets.CODEX_ACTION_AUTH }}
          token: ${{ secrets.CODEX_ACTION_TOKEN }}
          prompt: Make the requested repository update.
```
