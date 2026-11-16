# opencode-pr-assistant

Read-only, account-wide dashboard of your authored open GitHub pull requests. It uses the existing `gh` CLI authentication and GitHub GraphQL API; it does not save credentials or perform write operations.

## Safety and setup

Install the plugin in OpenCode and authenticate using GitHub CLI (`gh auth login`). The plugin checks the local CLI by making read-only API calls. It never creates comments, pushes, rebases, or merges. Snapshots are held in memory only. Polling is normally every two minutes and becomes faster while checks are pending or pull requests recently changed.

The server-owned RPC namespace is `PullRequests`, with `snapshot`, `refresh`, and `markSeen` actions.

New activity is deduplicated by GitHub comment/review ID. The first poll is a
silent baseline; later activity is marked unread until opened/marked seen. This
cursor and seen state are stored with the user-level SQLite metadata.

The GUI and TUI offer collapsible repository groups and PR details. Expanded
states are persisted in each surface's plugin storage. Desktop shows an
actionable in-app summary toast; the TUI shows a toast and provides an `Alt+S`
keyboard action to summarize the selected PR.

When a successful terminal `gh pr create` call returns a canonical
`https://github.com/<owner>/<repo>/pull/<number>` URL, the plugin records its
OpenCode session ID, optional parent session, title, project ID/directory, and
observation time. The metadata-only mapping is stored in a user-level SQLite
database under `XDG_STATE_HOME` or `LOCALAPPDATA` (falling back to
`~/.local/state`), so it is shared across project locations on that user
account. SQLite uses WAL and a busy timeout; no transcript or comment body is
stored. Existing PRs are not guessed from GitHub authors.

The OpenCode 2.3.0 hook/session APIs expose no server ID. The UI can navigate to
the stored session only on the currently connected OpenCode server; sessions
from another server must be shown as unavailable rather than guessed.

## Development

Run `bun install`, `bun run typecheck`, `bun run build`, and `bun test`.
