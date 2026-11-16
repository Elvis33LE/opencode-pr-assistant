# opencode-pr-assistant — product and implementation plan

## Product goal

Build an independent OpenCode 2 plugin that gives one authenticated GitHub
account a continuously refreshed view of its open pull requests across every
repository visible to that account. It should make urgent CI/rebase state and
new discussion easy to spot, then let the user deliberately hand one selected
PR to an OpenCode agent in the current chat.

The public source repository is
[`Elvis33LE/opencode-pr-assistant`](https://github.com/Elvis33LE/opencode-pr-assistant).
The existing `brain` project is unrelated and must remain untouched.

## Product boundaries

- The dashboard covers open PRs authored by the active GitHub CLI account,
  including repositories the account can access. It does not silently broaden
  to every PR assigned to or merely mentioning the account.
- GitHub access is read-only: list PRs, CI/check state, merge/rebase state, and
  recent activity. The plugin itself never pushes commits, rebases, merges, or
  posts comments/reviews.
- “Send to chat” is explicit and confirmed. It adds a bounded, identified PR
  context to the current OpenCode session; it does not itself execute a GitHub
  write. The agent remains subject to the session's normal tools and
  permissions.
- A PR is identified by `owner/repository#number`, never by the current
  workspace. A handoff must include the canonical URL and branch names. If the
  local checkout is unavailable, the agent should report that and ask before
  creating a checkout/worktree.
- When high-confidence evidence shows that an OpenCode session created a PR,
  persist a provenance link from the PR identity to the exact creator session
  (and, where available, its parent/root session). Show a **↗ Open creator
  session** action so the user can return to the original transcript and
  context. Never infer this link merely because the PR author matches the
  account.
- “Behind base” is shown as an update/rebase warning, not as a claim that
  rebasing is always the repository's required merge strategy.

## Information architecture

### Desktop

- A session side-region panel titled **Pull Requests**, opened through the
  panel launcher or command palette.
- Compact toolbar: open-PR count, authenticated viewer, last successful refresh,
  stale/error indicator, and manual refresh.
- Scrollable repository tree, each repository independently collapsible.
- PR rows within each repository are independently expandable/selectable.
- Selecting a PR reveals a detail view with branches, latest activity, CI
  summary/checks, merge-state explanation, review decision, comment count,
  exact update time, browser link, branch-copy action, and the explicit
  **Work on this PR in chat** action.
- Preserve selection, scroll position, and keyboard focus during refreshes.
- Offer a configurable panel launcher/command rather than creating an
  always-on-top overlay that fights the host layout. Persist repository and PR
  collapse preferences through the documented GUI/TUI plugin stores.

### TUI

- Compact account-wide list in the supported sidebar content slot.
- Repository groups and PR rows collapse independently; a supported session
  panel or route provides larger PR details where the narrow sidebar cannot.
- A selected PR may be handed to the current session only after confirmation.
- Use OpenCode's keymap/dialog APIs; do not inspect or depend on private host
  renderables.

### Sorting and time

- Repositories sort by the newest `updatedAt` among their open PRs.
- PRs within each repository sort by `updatedAt` descending.
- Show a short relative time in every row (for example, “12 min ago”).
- Make the exact timestamp available in Desktop focus/hover details and as
  visible detail text in the TUI.
- Distinguish PR activity time from “data last refreshed” time.
- Keep newest-activity order as the default. Add a **Needs attention** filter
  only as an optional lens; it must not silently reorder the main list by
  urgency.

### Design lessons from the browser sidebar

The supplied userscript reinforces useful interaction principles: a visible
collapsed handle with a count, independently collapsible repositories,
compact PR cards, distinct CI/conflict/review signals, persistent collapse
state, refresh, and quick branch copying. Adapt those ideas to the native
OpenCode panel/sidebar and its theme instead of reproducing the fixed-position
browser overlay or GitHub-specific CSS.

- Show review decisions alongside CI: changes requested, review required,
  approved, or unknown. Do not let approval mask failing checks or conflicts.
- Keep branch copy as a quick, safe action; label it and confirm clipboard
  success. It never checks out or changes a branch.
- Use `gh` CLI authentication and report its state; do not add a
  personal-token text field or store a raw token in plugin/browser storage.
- Paginate all open PRs rather than silently limiting the dashboard to the
  newest 50. Use a capped recent-activity preview and fetch expensive detail
  only when needed to control GitHub API cost.

## Visual language

Color is a semantic aid; the symbol and written status must remain sufficient
when colors are unavailable or difficult to distinguish. Use the active host
theme's semantic tokens and verify contrast in light/dark themes.

| Meaning | Symbol | Semantic tone | Suggested text |
| --- | --- | --- | --- |
| Failed check(s) | `✖` | danger / red | `Checks failing · 2` |
| Branch behind / update needed | `⇣` | warning / amber | `Branch behind base` |
| Merge conflict | `⚠` | danger / red | `Conflicts` |
| Checks running | `◌` | accent / blue | `Checks running · 3` |
| Checks passed | `✓` | success / green | `Checks passing` |
| Unknown/unavailable | `?` | muted / gray | `Status unavailable` |
| New activity | `●` | secondary accent / teal or violet | `New activity` |
| Current keyboard focus | `›` or outline | high-contrast focus | Selected item |
| Stale snapshot | `!` | warning / amber | `Showing stale data` |
| Changes requested | `✎` | danger / rose | `Changes requested` |
| Review required | `◷` | warning / amber | `Review required` |
| Approved | `✓` | success / green | `Approved` |

Urgency order in compact rows: failing checks, conflict, branch behind,
running checks, passing, unknown. “New activity” is an independent badge and
must not mask CI/rebase state. Never imply that passing checks alone means a PR
is mergeable.

Example collapsed repository:

```text
▸ acme / frontend                 4 PRs   ● 2 new   ✖ 1
```

Example expanded group:

```text
▾ acme / frontend                 4 PRs
   #284 API timeout handling       ✖ 1 failing   ● new   12 min ago
   #281 Keyboard shortcuts         ⇣ behind base          34 min ago
   #278 Onboarding refresh         ◌ checks running        1 hr ago
```

## Data, authentication, and polling

- Reuse the user's existing `gh` authentication; do not accept or write a PAT
  to plugin options/configuration and never log credential output.
- Invoke GitHub CLI with an argument array, bounded execution time/output, and
  cancellation. Report missing CLI, unauthenticated state, rate limit, partial
  data, and transport/API errors distinctly.
- Resolve the authenticated viewer, then query open authored PRs across
  accessible repositories with explicit cursor pagination.
- Normalize GraphQL/API responses into the shared `PullRequest` model. Map
  checks to failure/pending/success/unknown and GitHub merge state to
  conflict/behind/clean/blocked/unknown. Unknown must never be treated as
  healthy.
- Prefer low-cost summary status for all PRs; fetch detailed failed/running
  check names and recent comments only as needed, to limit rate usage.
- Start a server-owned refresh on plugin setup and own its timer through the
  plugin cleanup lifecycle. Default to about two minutes; use a shorter cadence
  only while checks are pending or activity is very recent. Prevent overlapping
  requests and abort work on unload.
- Persist per-PR activity cursors and seen state in the user-level SQLite
  store. Retain last-known results after transient failures and mark them stale
  rather than replacing them with an empty list.
- UI may trigger manual refresh; it must not run an independent high-frequency
  poll in every window.
- Periodic refresh is best-effort while the OpenCode server is running. This is
  not a durable external scheduler and stops when the server stops.

## New activity and chat handoff

- Compare each PR's last activity/update marker to a per-PR seen cursor.
- A new update/comment raises a quiet `●` badge and repository count. Do not
  send unsolicited chat prompts or repeated notifications.
- Opening the PR details or explicitly marking it seen clears the badge.
- Detect comment/review activity in the server poller and publish a typed RPC
  activity event. The first scan establishes a baseline; it must not notify for
  all pre-existing comments. Deduplicate subsequent events using a stable
  comment/review ID (falling back to an activity timestamp only if GitHub
  supplies no ID).
- Desktop may show a concise in-app toast with an explicit **Summarize** action.
  OpenCode V2 documents toast actions, plus `ctx.attention.notify` for
  system-level notifications while the app is unfocused. The system
  notification itself is only a jump-back-to-session affordance; the actionable
  button belongs in the in-app toast or the PR detail panel.
- Do not display a full comment body in a system notification. Show repository,
  PR number/title, and “new comment/activity”; load the body in the detail panel.
  Honor notification settings and avoid repeated alerts for the same event.
- TUI keeps the same unread/activity marker in the sidebar and offers
  **Summarize in chat** from the PR row/details. Use the TUI's supported dialog,
  toast, and keymap APIs rather than assuming GUI toast-action parity. New
  activity is announced in a toast; use the documented summary key/action in
  the sidebar to submit it.
- The confirmation summarizes the target (`owner/repo#number`, title, URL) and
  what context will be supplied (branches, current CI/rebase state, newest
  activity excerpt).
- **Summarize** submits a prompt to the current session asking the agent to
  explain the new comment, extract requested changes, and suggest a checklist;
  it does not authorize repository edits. **Work on this PR** is a separate,
  explicit action/confirmation that sends the same exact PR context and asks
  the agent to inspect and implement locally, while forbidding GitHub writes,
  pushes, merges, or rebases without explicit approval.
- Both paths use the documented OpenCode client `session.prompt` API and
  identify the selected session and exact PR. They do not run an LLM in the
  background or inject prompts without a user action.
- If no active session exists, disable the handoff with a clear instruction to
  open a chat. Creating a new session is a later opt-in enhancement.
- After successful submission, show a confirmation naming the PR; on failure,
  preserve the detail view and allow retry.

## Session provenance

- Treat session provenance as a distinct PR metadata record, not as a GitHub
  field. Store `owner/repository#number`, creator session ID, optional root
  session ID/title, observed time, and evidence type.
- The preferred evidence is a successful OpenCode session tool result that
  contains the canonical GitHub PR URL from `gh pr create` (or a supported
  equivalent), correlated with that tool's session ID. Support child sessions
  when the host event/session APIs expose them.
- Do not mark a PR as session-created when only its author or timestamp is
  known. If evidence is ambiguous, leave the origin unavailable and offer an
  explicit “link this session” action as a possible later enhancement.
- Persist the mapping in an injected SQLite store under the current user's
  XDG_STATE_HOME/LOCALAPPDATA state directory, keyed by canonical PR ID. Use
  WAL, a busy timeout, atomic upsert, and metadata only; do not store transcripts
  or credentials. This makes the PR-to-session lookup shared across project
  locations for this user account.
- GUI/TUI should display the origin only when present. The navigation action
  opens the exact creator session; it must not start a new agent turn or modify
  the PR. Since the tool hook exposes no server ID, opening is supported only
  when the session belongs to the currently connected OpenCode server; verify
  the session exists before offering navigation and explain when it is
  unavailable.
- Existing PRs predating installation can only be backfilled if their
  originating session evidence is still available and the scan is supported.
  Otherwise, provenance is prospective and should be labeled honestly.

## Error and empty states

- **Initial load:** keep toolbar stable and show non-empty loading placeholders;
  never flash “no PRs” before the first response.
- **No open PRs:** say “No open pull requests for this account” and offer
  refresh.
- **Stale/error:** retain the last successful data, label its age, and offer
  retry.
- **Partial status:** keep available PRs visible; label missing check/rebase
  fields as unknown.
- **Authentication:** distinguish `gh` missing from `gh` not authenticated and
  show a next step without exposing credentials.
- Polling updates must not steal focus or move the cursor unexpectedly.

## Implementation milestones

1. **Foundation:** package metadata and OpenCode 2 server/RPC/TUI/experimental
   GUI entrypoints; shared normalized model and dependency-injected boundaries.
2. **GitHub read model:** authenticated viewer, paginated account-wide query,
   status/activity normalization, explicit API failure states.
3. **Server lifecycle:** cache, polling cadence, single-flight guard, storage,
   RPC refresh/list/mark-seen, activity events, provenance capture/navigation,
   and plugin cleanup.
4. **Desktop/TUI:** themed status hierarchy, collapsible repository/PR tree,
   responsive details, timestamps, actionable comment notification, confirmed
   current-chat summary/work handoff, and creator-session navigation.
5. **Safety and test pass:** fixtures and fake `gh` runner, no real GitHub
   calls in tests, no real comments/pushes/rebases/merges, package load checks.
6. **Publish source:** run typecheck/build/focused tests, review the diff, commit
   and push the complete source to the already-created public GitHub repository.
   Do not publish to npm or install globally unless separately requested.

## Verification plan

- **GitHub adapter:** fake executable results for success, multiple cursors,
  malformed JSON, missing executable, unauthenticated, rate-limited, timeout,
  and cancellation. Assert no token appears in logs/errors.
- **Normalization:** fixtures for failed/pending/passing/skipped/unknown checks
  and clean/behind/conflict/blocked/unknown merge state.
- **Polling:** injected clock/timer proves initial refresh, cadence selection,
  no overlap, cancellation and cleanup, stale-data retention on failure.
- **Activity:** deterministic old/new timestamps verify unread, mark-seen and
  no duplicate badges.
- **Ordering:** latest PR first inside repository and newest repository first.
- **RPC:** schema validation, refresh, snapshot, seen-cursor behavior, and
  stable PR identity.
- **Chat handoff:** fake OpenCode client verifies the chosen current session,
  exact PR identity/link/context, explicit confirmation and no API write call.
- **Session provenance:** fixtures correlate only successful PR-creation tool
  output with the originating session; unrelated URLs, failures, and author
  matches alone must not create links. Test exact session navigation payload.
- **Build:** TypeScript checks for server, GUI, and TUI; build package and
  inspect required exports/artifacts. GUI API is experimental, so validate
  against the host version targeted by the package.

## Decisions deliberately deferred

- Including PRs where the account is only an assignee/reviewer, not the author.
- Multiple GitHub accounts and account switching.
- Creating new chat sessions, cloning repositories, opening worktrees, or
  checking out branches automatically.
- GitHub write actions (comment, approve, merge, push, rebase).
- npm publication, marketplace distribution, or a durable scheduler that
  continues when OpenCode is stopped.
