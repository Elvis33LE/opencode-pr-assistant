/** @jsxImportSource solid-js */
import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import { Schema } from "effect";
import { Command, MenuItem, Panel, Plugin, Style } from "@opencode/plugin/gui";
import { PullRequests } from "opencode-pr-assistant/rpc";
import type { PullRequest, PullRequestSnapshot } from "./shared/types";
import type { Context } from "@opencode/plugin/gui";
import { exactTime, groupPullRequests, handoffPrompt, relativeTime, statusOf } from "./ui/presentation";
import dashboardStyle from "./ui/dashboard.css?inline";
import { errorMessage } from "./ui/errors";

type PullRequestActivityEvent = { id: string; pullRequestId: string; timestamp: string; author: string; bodyExcerpt: string };
type RPCEvent<T> = { type: string; location: unknown; data: T };
type DashboardRPC = {
  snapshot(): Promise<PullRequestSnapshot>;
  refresh(): Promise<PullRequestSnapshot>;
  markSeen(input: { id: string }): Promise<PullRequestSnapshot>;
  events: { on(name: "activity", listener: (event: RPCEvent<PullRequestActivityEvent>) => void): () => void };
};
type ViewPreferences = { readonly expandedRepos: readonly string[]; readonly expandedPRs: readonly string[] };
type MutableViewPreferences = { expandedRepos: string[]; expandedPRs: string[] };
type PersistedViewPreferences = {
  readonly value: ViewPreferences | undefined;
  update(mutate: (draft: MutableViewPreferences) => undefined): void;
};

export default Plugin.define({
  setup(ctx) {
    const rpc = ctx.client.rpc(PullRequests) as unknown as DashboardRPC;
    ctx.add(Style, dashboardStyle);
    const viewPreferences = ctx.storage.store("view-preferences", {
      schema: Schema.Struct({
        expandedRepos: Schema.Array(Schema.String),
        expandedPRs: Schema.Array(Schema.String),
      }),
      initial: { expandedRepos: [], expandedPRs: [] },
      scope: "global",
    });
    const tab = { id: "main", title: "Pull requests", label: () => <span class="pra-tab">⇄ PRs</span> };
    const open = () => {
      const session = ctx.sessions.current();
      if (session) ctx.layout.open(`${ctx.id}:main`, session);
      else ctx.toast.show({ title: "Öffne zuerst einen Chat", description: "Das PR-Panel ist an eine Session gebunden." });
    };

    ctx.add(Panel, {
      id: "main",
      region: "side",
      wide: true,
      mobile: { title: "Pull requests", order: 70, kind: "drawer", icon: "branch" },
      list: input => input.open.includes("main") ? [tab] : [],
      render: props => <Dashboard ctx={ctx} rpc={rpc} sessionID={() => props.session.id} serverID={() => props.session.server.id} preferences={viewPreferences} />,
    });
    ctx.add(MenuItem, { menu: "session.panel", id: "open", title: "Pull requests", icon: "branch", run: open });
    ctx.add(Command, {
      id: "open",
      title: "Open pull request dashboard",
      description: "Alle offenen GitHub-Pull-Requests ansehen",
      group: "Pull requests",
      run: open,
    });
  },
});

function Dashboard(props: {
  ctx: Context;
  rpc: {
    snapshot(): Promise<PullRequestSnapshot>;
    refresh(): Promise<PullRequestSnapshot>;
    markSeen(input: { id: string }): Promise<PullRequestSnapshot>;
    events: { on(name: "activity", listener: (event: RPCEvent<PullRequestActivityEvent>) => void): () => void };
  };
  sessionID: () => string;
  serverID: () => string;
  preferences: PersistedViewPreferences;
}) {
  const ctx = props.ctx;
  const rpc = props.rpc;
  const [snapshot, setSnapshot] = createSignal<PullRequestSnapshot | undefined>();
  const [selected, setSelected] = createSignal<string>();
  const [expandedRepos, setExpandedRepos] = createSignal<Set<string>>(new Set(props.preferences.value?.expandedRepos ?? []));
  const [expandedPRs, setExpandedPRs] = createSignal<Set<string>>(new Set(props.preferences.value?.expandedPRs ?? []));
  const [busy, setBusy] = createSignal(false);
  const [loadError, setLoadError] = createSignal<string>();
  const [originStates, setOriginStates] = createSignal<Map<string, "checking" | "available" | "unavailable">>(new Map());
  const groups = createMemo(() => groupPullRequests(snapshot()?.pullRequests ?? []));
  let alive = true;

  const load = async (manual = false) => {
    if (busy()) return;
    setBusy(true);
    try {
      const next = manual ? await rpc.refresh() : await rpc.snapshot();
      if (alive) {
        setSnapshot(next);
        setLoadError(undefined);
      }
    } catch (error) {
      const message = errorMessage(error);
      if (alive) setLoadError(message);
      if (alive) setSnapshot(current => current ? { ...current, stale: true, error: message } : undefined);
    } finally {
      if (alive) setBusy(false);
    }
  };
  onMount(() => { void load(); });
  const refreshTimer = setInterval(() => { void load(); }, 120_000);
  onCleanup(() => clearInterval(refreshTimer));
  onCleanup(() => { alive = false; });
  createEffect(() => {
    const preferences = props.preferences.value;
    if (!preferences) return;
    setExpandedRepos(new Set(preferences.expandedRepos));
    setExpandedPRs(new Set(preferences.expandedPRs));
  });

  const send = async (pr: PullRequest, mode: "summary" | "work") => {
    const sessionID = props.sessionID();
    if (!sessionID) {
      ctx.toast.show({ title: "Kein Chat geöffnet", description: "Öffne eine Session und versuche es erneut.", variant: "error" });
      return;
    }
    if (mode === "work") {
      const confirmed = await ctx.dialogs.confirm({
        title: "PR im Chat bearbeiten lassen?",
        description: `Der Agent erhält Kontext zu ${pr.owner}/${pr.repository}#${pr.number} und kann lokale Änderungen vorbereiten. Es werden keine GitHub-Schreibaktionen ohne deine Zustimmung ausgeführt.`,
        confirm: "An Chat übergeben",
        cancel: "Abbrechen",
      });
      if (!confirmed) return;
    }
    try {
      await ctx.client.session.prompt({ sessionID, text: handoffPrompt(pr, mode) });
      ctx.toast.show({
        title: mode === "summary" ? "Zusammenfassung angefragt" : "PR an Chat übergeben",
        description: `${pr.owner}/${pr.repository}#${pr.number}`,
        variant: "success",
      });
    } catch (error) {
      ctx.toast.show({ title: "Übergabe fehlgeschlagen", description: String(error), variant: "error" });
    }
  };
  const originOf = (pr: PullRequest) => pr.origin;
  const verifyOrigin = async (pr: PullRequest) => {
    const origin = originOf(pr);
    if (!origin?.sessionID) return;
    setOriginStates(current => new Map(current).set(pr.id, "checking"));
    try {
      const session = await ctx.client.session.get({ sessionID: origin.sessionID });
      const verified = session.id === origin.sessionID && (!origin.projectID || session.projectID === origin.projectID);
      setOriginStates(current => new Map(current).set(pr.id, verified ? "available" : "unavailable"));
    } catch {
      setOriginStates(current => new Map(current).set(pr.id, "unavailable"));
    }
  };
  const openOrigin = (pr: PullRequest) => {
    const origin = originOf(pr);
    const server = props.serverID();
    if (!origin?.sessionID || !server || originStates().get(pr.id) !== "available") return;
    ctx.tabs.open({ server, id: origin.sessionID }, { focus: true });
  };

  const onActivity = ({ data: event }: RPCEvent<PullRequestActivityEvent>) => {
    const pr = snapshot()?.pullRequests.find(item => item.id === event.pullRequestId);
    const title = pr ? `${pr.owner}/${pr.repository}#${pr.number}` : event.pullRequestId;
    ctx.toast.show({
      title: "● Neue PR-Aktivität",
      description: `${title}${pr ? ` · ${pr.title}` : ""} · Kommentar von ${event.author || "unbekannt"}`,
      duration: 12_000,
      actions: pr ? [{ label: "Zusammenfassen", run: () => void send(pr, "summary") }] : undefined,
    });
    const session = ctx.sessions.current();
    if (session) {
      void ctx.attention.notify({
        title: "Neue PR-Aktivität",
        message: `${title} · neue Aktivität`,
        session: { server: session.server.id, id: session.id },
        id: event.id,
        sound: false,
      });
    }
    void load();
  };
  const unsubscribe = rpc.events.on("activity", onActivity);
  onCleanup(unsubscribe);

  const toggleRepo = (name: string) => setExpandedRepos(current => {
    const next = new Set(current);
    next.has(name) ? next.delete(name) : next.add(name);
    props.preferences.update(draft => { draft.expandedRepos = [...next]; return undefined; });
    return next;
  });
  const togglePR = async (pr: PullRequest) => {
    const next = new Set(expandedPRs());
    if (next.has(pr.id)) next.delete(pr.id);
    else {
      next.add(pr.id);
      setSelected(pr.id);
      try { setSnapshot(await rpc.markSeen({ id: pr.id })); } catch { /* keep the current snapshot */ }
      const originPR = snapshot()?.pullRequests.find(item => item.id === pr.id);
      if (originPR?.origin?.sessionID) void verifyOrigin(originPR);
    }
    props.preferences.update(draft => { draft.expandedPRs = [...next]; return undefined; });
    setExpandedPRs(next);
  };

  return (
    <main class="pra-shell">
      <header class="pra-header">
        <div class="pra-heading">
          <div class="pra-eyebrow">GITHUB · ACCOUNT-WEIT</div>
          <h1>Pull requests <span class="pra-count">{snapshot()?.pullRequests.length ?? "—"}</span></h1>
        </div>
        <button class="pra-icon-button" type="button" aria-label="Pull Requests aktualisieren" title="Jetzt aktualisieren" onClick={() => void load(true)} disabled={busy()}>
          {busy() ? "◌" : "↻"}
        </button>
      </header>

      <div class="pra-toolbar">
        <span>{snapshot()?.viewer ? `@${snapshot()!.viewer}` : "Dein GitHub-Konto"}</span>
        <span class="pra-dot-separator">·</span>
        <span>{snapshot()?.refreshedAt ? `Daten ${relativeTime(snapshot()!.refreshedAt)}` : "Noch nicht aktualisiert"}</span>
      </div>

      <Show when={snapshot()?.stale}>
        <div class="pra-banner warning" role="status"><b>! Veraltete Daten</b><span>{snapshot()?.error ?? "Die letzte Aktualisierung war nicht erfolgreich."}</span><button onClick={() => void load(true)}>Erneut versuchen</button></div>
      </Show>
      <Show when={snapshot()?.auth.state === "missing-cli" || snapshot()?.auth.state === "unauthenticated"}>
        <div class="pra-banner warning" role="status">
          <b>{snapshot()?.auth.state === "missing-cli" ? "gh fehlt" : "GitHub-Anmeldung fehlt"}</b>
          <span>{snapshot()?.auth.message ?? (snapshot()?.auth.state === "missing-cli" ? "Installiere GitHub CLI und melde dich an." : "Melde dich mit gh auth login an.")}</span>
        </div>
      </Show>

      <Show when={!snapshot()} fallback={
        <Show when={(snapshot()?.pullRequests.length ?? 0) > 0} fallback={
          <section class="pra-empty"><span class="pra-empty-icon">◇</span><h2>Keine offenen PRs</h2><p>Für dieses GitHub-Konto wurden keine offenen Pull Requests gefunden.</p><button class="pra-button" onClick={() => void load(true)}>↻ Aktualisieren</button></section>
        }>
          <div class="pra-list" aria-label="Repositories und Pull Requests">
            <For each={groups()}>{group => {
              const expanded = () => expandedRepos().has(group.name);
              const unseen = () => group.prs.filter(pr => pr.activity.unseen).length;
              const failing = () => group.prs.filter(pr => pr.checks.state === "failure" || pr.checks.failed > 0).length;
              return <section class="pra-repo">
                <button class="pra-repo-row" aria-expanded={expanded()} onClick={() => toggleRepo(group.name)}>
                  <span class="pra-chevron">{expanded() ? "▾" : "▸"}</span>
                  <span class="pra-repo-name">{group.name}</span>
                  <span class="pra-repo-meta">{group.prs.length} PR{group.prs.length === 1 ? "" : "s"}</span>
                  <Show when={unseen() > 0}><span class="pra-badge activity">● {unseen()} neu</span></Show>
                  <Show when={failing() > 0}><span class="pra-badge danger">✖ {failing()}</span></Show>
                </button>
                <Show when={expanded()}>
                  <div class="pra-pr-list">
                    <For each={group.prs}>{pr => <PRRow
                      pr={pr}
                      expanded={expandedPRs().has(pr.id)}
                      selected={selected() === pr.id}
                      onToggle={() => void togglePR(pr)}
                      onSummarize={() => void send(pr, "summary")}
                      onWork={() => void send(pr, "work")}
                      onOpenOrigin={() => openOrigin(pr)}
                      onCopyBranch={() => void ctx.system.copy(pr.headBranch).then(() => ctx.toast.show({ title: "Branch kopiert", description: pr.headBranch, variant: "success" }))}
                      originTitle={originOf(pr)?.title}
                      hasOrigin={Boolean(originOf(pr)?.sessionID)}
                      originState={originStates().get(pr.id)}
                      reviewLabel={pr.reviewDecision === "changes-requested" ? "⚑ Changes requested" : pr.reviewDecision === "approved" ? "✓ Approved" : pr.reviewDecision === "review-required" ? "◉ Review requested" : "Review unknown"}
                      commentCount={pr.commentCount}
                    />}</For>
                  </div>
                </Show>
              </section>;
            }}</For>
          </div>
        </Show>
      }>
        <Show when={loadError()} fallback={<div class="pra-skeleton" aria-label="Pull Requests werden geladen"><i /><i /><i /></div>}>
          <section class="pra-empty"><span class="pra-empty-icon">!</span><h2>Pull Requests nicht erreichbar</h2><p>{loadError()}</p><button class="pra-button" onClick={() => void load(true)}>Erneut versuchen</button></section>
        </Show>
      </Show>
    </main>
  );
}

function PRRow(props: {
  pr: PullRequest;
  expanded: boolean;
  selected: boolean;
  onToggle(): void;
  onSummarize(): void;
  onWork(): void;
  onOpenOrigin(): void;
  onCopyBranch(): void;
  hasOrigin: boolean;
  originTitle?: string;
  originState?: "checking" | "available" | "unavailable";
  reviewLabel: string;
  commentCount: number;
}) {
  const status = () => statusOf(props.pr);
  return <article class={`pra-pr ${props.selected ? "selected" : ""}`}>
    <button class="pra-pr-row" aria-expanded={props.expanded} onClick={props.onToggle}>
      <span class="pra-chevron">{props.expanded ? "▾" : "▸"}</span>
      <span class="pra-pr-copy">
        <span class="pra-pr-title"><span class="pra-number">#{props.pr.number}</span> {props.pr.title}</span>
        <span class={`pra-status ${status().tone}`}><b>{status().icon}</b> {status().label}</span>
      </span>
      <Show when={props.pr.activity.unseen}><span class="pra-new" aria-label="Neue Aktivität">● Neu</span></Show>
      <time class="pra-time" datetime={props.pr.updatedAt} title={exactTime(props.pr.updatedAt)}>{relativeTime(props.pr.updatedAt)}</time>
    </button>
    <Show when={props.expanded}>
      <div class="pra-detail">
        <div class="pra-branches"><span>{props.pr.headBranch}</span><b>→</b><span>{props.pr.baseBranch}</span></div>
        <div class="pra-detail-meta"><span>Von {props.pr.author}</span><span>Aktualisiert: {exactTime(props.pr.updatedAt)}</span></div>
        <div class="pra-detail-meta"><span>{props.reviewLabel}</span><span>✎ {props.commentCount} Kommentare</span></div>
        <Show when={props.pr.activity.latestBody}>
          <blockquote class="pra-comment">
            <span class="pra-comment-label">LETZTE AKTIVITÄT · {props.pr.activity.latestAuthor ?? "Unbekannt"} · {relativeTime(props.pr.activity.latestAt)}</span>
            <span>{props.pr.activity.latestBody}</span>
          </blockquote>
        </Show>
        <div class="pra-checks">
          <For each={props.pr.checks.items}>{check => <span class={`pra-check ${check.state}`} title={check.name}>{check.state === "success" ? "✓" : check.state === "failure" ? "✖" : check.state === "pending" ? "◌" : "·"} {check.name}</span>}</For>
        </div>
        <div class="pra-actions">
          <a class="pra-button quiet" href={props.pr.url} target="_blank" rel="noreferrer">↗ GitHub öffnen</a>
          <button class="pra-button quiet" onClick={props.onCopyBranch}>⧉ Branch kopieren</button>
          <Show when={props.hasOrigin}>
            <Show when={props.originState === "available"} fallback={
              <span class="pra-origin-state" title={props.originTitle}>
                {props.originState === "checking" ? "◌ Session wird geprüft…" : props.originState === "unavailable" ? "? Ersteller-Session auf diesem Server nicht verfügbar" : "◌ Session wird geprüft…"}
              </span>
            }>
              <button class="pra-button quiet" title={props.originTitle} onClick={props.onOpenOrigin}>↗ Ersteller-Session</button>
            </Show>
          </Show>
          <button class="pra-button quiet" onClick={props.onSummarize}>✦ Zusammenfassen</button>
          <button class="pra-button primary" onClick={props.onWork}>An PR arbeiten →</button>
        </div>
      </div>
    </Show>
  </article>;
}
