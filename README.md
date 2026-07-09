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

- Actions: read
- Contents: read and write
- Issues: read and write
- Pull requests: read and write
- Secrets: read and write

### MCP Context

The action exposes the matching platform MCP server to Codex with the same API
token used by the action. This lets Codex inspect pull request comments, issues,
repository data, and workflow context through MCP tools instead of relying on
pre-generated prompt text.

No container runtime is required. The action downloads the matching release
binary and caches it in both the runner tool cache and, when available, the
Actions cache service:

- `github-mcp-server` from `github/github-mcp-server` on GitHub, with the
  `repos`, `issues`, `pull_requests`, and `actions` toolsets in read-only mode.
- `gitea-mcp` from `gitea/gitea-mcp` on Gitea, pointed at the current server URL.
- `forgejo-mcp` from `goern/forgejo-mcp` on Forgejo, pointed at the current
  server URL.

The API token is forwarded through environment variables and is not written to
Codex MCP configuration. On GitHub App setups, the installation must include the
Actions read permission so Codex can inspect workflow context.

Set `CODEX_PATH` to a preinstalled Codex executable to skip the Codex binary
download and cache lookup entirely.

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

### Writing Prompts

Prompts should describe the repository task clearly enough for Codex to complete
it without follow-up questions. For reusable automation, prefer a prompt file in
the repository such as `.github/prompts/refactor.md`.

Effective prompts usually include:

- The concrete goal or outcome.
- Relevant context, files, packages, or workflows to inspect first.
- What is in scope and out of scope.
- Required formatting, build, or test commands.
- Project constraints such as compatibility, style, or minimal-change
  expectations.
- What to do if the requested change cannot be completed safely.

Do not ask Codex to commit, push, or post comments directly. This action handles
commits, pushes, pull request comments, and automerge after Codex finishes.

Set `dry-run: true` to let Codex run and create a local commit while skipping
pushes, pull request comments, and automerge updates. Refreshed Codex auth is
still saved to the configured repository secret.

Codex runs with workspace write access and without shell network access. The
configured MCP server can access the platform API with the action token.

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
comment, workflow, and Actions secret access.

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
