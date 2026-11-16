/** @jsxImportSource @opentui/solid */
import { For, Show, createEffect, createMemo, createSignal, onCleanup, on, untrack } from "solid-js";
import { Plugin } from "@opencode/plugin/tui";
import { PullRequests } from "opencode-pr-assistant/rpc";
import type { PullRequest, PullRequestSnapshot } from "./shared/types";
import { exactTime, groupPullRequests, handoffPrompt, relativeTime, statusOf } from "./ui/presentation";
import { errorMessage } from "./ui/errors";

type PullRequestActivityEvent = { id: string; pullRequestId: string; timestamp: string; author: string; bodyExcerpt: string };
type RPCEvent<T> = { type: string; location: unknown; data: T };
type RPC = {
  snapshot(): Promise<PullRequestSnapshot>;
  refresh(): Promise<PullRequestSnapshot>;
  markSeen(input: { id: string }): Promise<PullRequestSnapshot>;
  events: { on(name: "activity", listener: (event: RPCEvent<PullRequestActivityEvent>) => void): () => void };
};
type ViewPreferences = { expandedRepos: string[]; expandedPRs: string[] };
type TUIViewPreferences = {
  expandedRepos: string[];
  expandedPRs: string[];
};

export default Plugin.define({
  id: "opencode-pr-assistant.tui",
  setup(context) {
    const rpc = context.client.rpc(PullRequests) as unknown as RPC;
    const [viewPreferences, updateViewPreferences] = context.storage.store("view-preferences", {
      initial: { expandedRepos: [], expandedPRs: [] },
    });
    const [activityRevision, setActivityRevision] = createSignal(0);
    const stopActivity = rpc.events.on("activity", ({ data: event }: RPCEvent<PullRequestActivityEvent>) => {
      void rpc.snapshot().then(snapshot => {
        latestSnapshot = snapshot;
        setActivityRevision(value => value + 1);
        const pr = snapshot.pullRequests.find(item => item.id === event.pullRequestId);
        context.ui.toast.show({
          title: "Neue PR-Aktivität",
          message: `${pr ? `${pr.owner}/${pr.repository}#${pr.number}` : event.pullRequestId} · Kommentar von ${event.author || "unbekannt"}. In der PR-Liste Alt+S zum Zusammenfassen.`,
          variant: "info",
        });
      });
    });
    let latestSnapshot: PullRequestSnapshot | undefined;
    const stopSlot = context.ui.slot({
      append: "sidebar.content",
      render: ({ sessionID }) => <PullRequestSidebar
        context={context}
        rpc={rpc}
        sessionID={sessionID}
        activityRevision={activityRevision}
        preferences={viewPreferences}
        updatePreferences={updateViewPreferences}
        onSnapshot={value => { latestSnapshot = value; }}
      />,
    });
    return () => { stopActivity(); stopSlot(); };
  },
});

function PullRequestSidebar(props: {
  context: Parameters<Parameters<typeof Plugin.define>[0]["setup"]>[0];
  rpc: RPC;
  sessionID: string;
  activityRevision: () => number;
  preferences: TUIViewPreferences;
  updatePreferences(mutate: (draft: ViewPreferences) => void): Promise<void>;
  onSnapshot(snapshot: PullRequestSnapshot): void;
}) {
  const [snapshot, setSnapshot] = createSignal<PullRequestSnapshot>();
  const [expandedRepos, setExpandedRepos] = createSignal(new Set(props.preferences.expandedRepos));
  const [expandedPRs, setExpandedPRs] = createSignal(new Set(props.preferences.expandedPRs));
  const [selected, setSelected] = createSignal(0);
  const [busy, setBusy] = createSignal(false);
  const [loadError, setLoadError] = createSignal<string>();
  const [originStates, setOriginStates] = createSignal(new Map<string, "checking" | "available" | "unavailable">());
  const groups = createMemo(() => groupPullRequests(snapshot()?.pullRequests ?? []));
  createEffect(() => {
    setExpandedRepos(new Set(props.preferences.expandedRepos));
    setExpandedPRs(new Set(props.preferences.expandedPRs));
  });
  const rows = createMemo(() => {
    const result: Array<{ kind: "repo"; key: string; name: string; prs: PullRequest[] } | { kind: "pr"; key: string; pr: PullRequest }> = [];
    for (const group of groups()) {
      result.push({ kind: "repo", key: group.name, name: group.name, prs: group.prs });
      if (expandedRepos().has(group.name)) {
        for (const pr of group.prs) result.push({ kind: "pr", key: pr.id, pr });
      }
    }
    return result;
  });
  const load = async (refresh = false) => {
    if (busy()) return;
    setBusy(true);
    try {
      const next = refresh ? await props.rpc.refresh() : await props.rpc.snapshot();
      setSnapshot(next);
      setLoadError(undefined);
      props.onSnapshot(next);
      setSelected(index => Math.min(index, Math.max(rows().length - 1, 0)));
    } catch (error) {
      const message = errorMessage(error);
      setLoadError(message);
      setSnapshot(current => current ? { ...current, stale: true, error: message } : undefined);
    } finally {
      setBusy(false);
    }
  };
  createEffect(on(props.activityRevision, () => { void untrack(() => load()); }));
  const refreshTimer = setInterval(() => { void load(); }, 120_000);
  onCleanup(() => clearInterval(refreshTimer));

  const current = () => rows()[selected()];
  const selectedPR = () => {
    const row = current();
    return row?.kind === "pr" ? row.pr : undefined;
  };
  const verifyOrigin = async (pr: PullRequest) => {
    const origin = pr.origin;
    if (!origin?.sessionID) return false;
    setOriginStates(current => new Map(current).set(pr.id, "checking"));
    try {
      const session = await props.context.client.session.get({ sessionID: origin.sessionID });
      const verified = session.id === origin.sessionID && (!origin.projectID || session.projectID === origin.projectID);
      setOriginStates(current => new Map(current).set(pr.id, verified ? "available" : "unavailable"));
      return verified;
    } catch {
      setOriginStates(current => new Map(current).set(pr.id, "unavailable"));
      return false;
    }
  };
  const toggle = async () => {
    const row = current();
    if (!row) return;
    if (row.kind === "repo") {
      setExpandedRepos(value => {
        const next = new Set(value);
        next.has(row.name) ? next.delete(row.name) : next.add(row.name);
        void props.updatePreferences(draft => { draft.expandedRepos = [...next]; });
        return next;
      });
      return;
    }
    const nextExpanded = new Set(expandedPRs());
    if (nextExpanded.has(row.pr.id)) nextExpanded.delete(row.pr.id);
    else nextExpanded.add(row.pr.id);
    void props.updatePreferences(draft => { draft.expandedPRs = [...nextExpanded]; });
    setExpandedPRs(nextExpanded);
    if (nextExpanded.has(row.pr.id)) {
      try {
        const next = await props.rpc.markSeen({ id: row.pr.id });
        setSnapshot(next);
        props.onSnapshot(next);
      } catch { /* retain the current snapshot */ }
    }
  };
  const send = async (mode: "summary" | "work") => {
    const pr = selectedPR();
    if (!pr) {
      contextToast(props.context, "PR auswählen", "Wähle zuerst eine Pull Request aus.", "warning");
      return;
    }
    if (mode === "work") {
      const confirmed = await props.context.ui.dialog.confirm({
        title: "An PR arbeiten?",
        message: `${pr.owner}/${pr.repository}#${pr.number} wird mit Branches, CI-Status und letzter Aktivität an den aktuellen Chat übergeben. Keine GitHub-Schreibaktion ohne deine Zustimmung.`,
        label: { confirm: "An Chat übergeben", cancel: "Abbrechen" },
      });
      if (!confirmed) return;
    }
    try {
      await props.context.client.session.prompt({ sessionID: props.sessionID, text: handoffPrompt(pr, mode) });
      contextToast(props.context, mode === "summary" ? "Zusammenfassung angefragt" : "PR an Chat übergeben", `${pr.owner}/${pr.repository}#${pr.number}`, "success");
    } catch (error) {
      contextToast(props.context, "Übergabe fehlgeschlagen", String(error), "error");
    }
  };
  const jumpToOrigin = async (pr: PullRequest) => {
    const origin = pr.origin;
    if (!origin?.sessionID) return;
    if (originStates().get(pr.id) !== "available" && !(await verifyOrigin(pr))) {
      contextToast(props.context, "Ersteller-Session nicht verfügbar", "Diese Session ist auf diesem Server nicht erreichbar.", "warning");
      return;
    }
    props.context.ui.router.navigate({ type: "session", sessionID: origin.sessionID });
  };
  const originOf = (pr: PullRequest) => pr.origin;
  createEffect(() => {
    const pr = selectedPR();
    if (pr?.origin?.sessionID && !originStates().has(pr.id)) void verifyOrigin(pr);
  });

  props.context.keymap.layer(() => ({
    mode: "base",
    enabled: true,
    priority: 30,
    commands: [
      { id: "pra-up", title: "Previous pull request row", bind: "alt+up", run: () => setSelected(index => Math.max(0, index - 1)) },
      { id: "pra-down", title: "Next pull request row", bind: "alt+down", run: () => setSelected(index => Math.min(rows().length - 1, index + 1)) },
      { id: "pra-toggle", title: "Expand repository / mark PR read", bind: "alt+enter", run: () => { void toggle(); } },
      { id: "pra-refresh", title: "Refresh pull requests", bind: "alt+r", run: () => { void load(true); } },
      { id: "pra-summary", title: "Summarize selected PR activity", bind: "alt+s", run: () => { void send("summary"); } },
      { id: "pra-work", title: "Work on selected PR", bind: "alt+w", run: () => { void send("work"); } },
      { id: "pra-origin", title: "Open verified PR creator session", bind: "alt+o", enabled: () => {
        const pr = selectedPR();
        return Boolean(pr?.origin?.sessionID && originStates().get(pr.id) === "available");
      }, run: () => { const pr = selectedPR(); if (pr) void jumpToOrigin(pr); } },
    ],
  }));

  return (
    <box flexDirection="column" paddingX={1} paddingY={1} gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text content="⇄ Pull requests" fg={props.context.theme.primary} />
        <text content={busy() ? "◌" : "↻"} fg={props.context.theme.textMuted} />
      </box>
      <Show when={snapshot()} fallback={
        <Show when={loadError()} fallback={<text content="◌ GitHub PRs werden geladen…" fg={props.context.theme.textMuted} />}>
          <text content={`! Pull Requests nicht erreichbar · ${loadError()} · Alt+R erneut versuchen`} fg={props.context.theme.warning} />
        </Show>
      }>
        <box flexDirection="row" gap={1}>
          <text content={`${snapshot()?.pullRequests.length ?? 0} offen`} fg={props.context.theme.text} />
          <text content="·" fg={props.context.theme.textMuted} />
          <text content={snapshot()?.refreshedAt ? relativeTime(snapshot()?.refreshedAt) : "nicht aktualisiert"} fg={props.context.theme.textMuted} />
        </box>
        <Show when={snapshot()?.stale}><text content={`! Veraltete Daten · ${snapshot()?.error ?? "Aktualisierung fehlgeschlagen"}`} fg={props.context.theme.warning} /></Show>
        <Show when={snapshot()?.auth.state === "missing-cli" || snapshot()?.auth.state === "unauthenticated"}>
          <text content={snapshot()?.auth.state === "missing-cli" ? "! gh fehlt: GitHub CLI installieren" : "! GitHub-Anmeldung: gh auth login"} fg={props.context.theme.warning} />
        </Show>
        <Show when={(snapshot()?.pullRequests.length ?? 0) === 0}>
          <text content="◇ Keine offenen Pull Requests für dieses Konto." fg={props.context.theme.textMuted} />
        </Show>
        <For each={rows()}>{(row, index) => {
          const focus = () => selected() === index();
          if (row.kind === "repo") {
            const open = () => expandedRepos().has(row.name);
            const unread = () => row.prs.filter(pr => pr.activity.unseen).length;
            const failed = () => row.prs.filter(pr => pr.checks.state === "failure" || pr.checks.failed > 0).length;
            return <box flexDirection="column">
              <text content={`${focus() ? "›" : " "} ${open() ? "▾" : "▸"} ${row.name}  ${row.prs.length} PR${row.prs.length === 1 ? "" : "s"}${unread() ? `  ● ${unread()} neu` : ""}${failed() ? `  ✖ ${failed()}` : ""}`} fg={focus() ? props.context.theme.primary : props.context.theme.text} />
            </box>;
          }
          const status = statusOf(row.pr);
          return <box flexDirection="column" paddingLeft={2}>
            <text content={`${focus() ? "›" : " "} ${expandedPRs().has(row.pr.id) ? "▾" : "▸"} #${row.pr.number} ${row.pr.title}`} fg={focus() ? props.context.theme.primary : props.context.theme.text} />
            <text content={`   ${status.icon} ${status.label}${row.pr.activity.unseen ? "  ● Neu" : ""} · ${relativeTime(row.pr.updatedAt)}`} fg={status.tone === "danger" ? props.context.theme.error : status.tone === "warning" ? props.context.theme.warning : status.tone === "success" ? props.context.theme.success : status.tone === "info" ? props.context.theme.info : props.context.theme.textMuted} />
            <Show when={focus() && expandedPRs().has(row.pr.id)}>
              <box flexDirection="column" paddingLeft={3}>
                <text content={`↳ ${row.pr.headBranch} → ${row.pr.baseBranch}`} fg={props.context.theme.textMuted} />
                <text content={`   Aktualisiert: ${exactTime(row.pr.updatedAt)}`} fg={props.context.theme.textMuted} />
                <text content={`   ${row.pr.reviewDecision === "approved" ? "✓ Freigegeben" : row.pr.reviewDecision === "changes-requested" ? "⚑ Änderungen angefordert" : row.pr.reviewDecision === "review-required" ? "◉ Review ausstehend" : "? Review unbekannt"} · ✎ ${row.pr.commentCount} Kommentare`} fg={props.context.theme.textMuted} />
                <Show when={row.pr.activity.latestBody}><text content={`   “${row.pr.activity.latestBody}”`} fg={props.context.theme.textMuted} /></Show>
                <Show when={originOf(row.pr)?.sessionID}>
                  <text content={`   ${originStates().get(row.pr.id) === "available" ? "↗ Ersteller-Session: " : originStates().get(row.pr.id) === "checking" ? "◌ Ersteller-Session wird geprüft: " : originStates().get(row.pr.id) === "unavailable" ? "? Ersteller-Session auf diesem Server nicht verfügbar: " : "◌ Ersteller-Session wird geprüft: "}${originOf(row.pr)?.title ?? originOf(row.pr)?.sessionID}`} fg={originStates().get(row.pr.id) === "unavailable" ? props.context.theme.warning : props.context.theme.info} />
                </Show>
              </box>
            </Show>
          </box>;
        }}</For>
      </Show>
      <text content="Alt+↑↓ wählen · Alt+Enter öffnen/lesen · Alt+S zusammenfassen · Alt+W bearbeiten · Alt+O Session · Alt+R aktualisieren" fg={props.context.theme.textMuted} />
    </box>
  );
}

function contextToast(context: Parameters<Parameters<typeof Plugin.define>[0]["setup"]>[0], title: string, message: string, variant: "info" | "success" | "warning" | "error") {
  context.ui.toast.show({ title, message, variant });
}
