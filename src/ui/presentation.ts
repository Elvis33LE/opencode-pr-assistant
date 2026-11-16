import type { PullRequest } from "../shared/types";

export function relativeTime(value?: string): string {
  if (!value) return "Zeit unbekannt";
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) return "Zeit unbekannt";
  const seconds = Math.round((timestamp - Date.now()) / 1000);
  const abs = Math.abs(seconds);
  const rtf = new Intl.RelativeTimeFormat("de", { numeric: "auto", style: "short" });
  if (abs < 60) return rtf.format(seconds, "second");
  if (abs < 3600) return rtf.format(Math.round(seconds / 60), "minute");
  if (abs < 86400) return rtf.format(Math.round(seconds / 3600), "hour");
  if (abs < 604800) return rtf.format(Math.round(seconds / 86400), "day");
  return rtf.format(Math.round(seconds / 604800), "week");
}

export function exactTime(value?: string): string {
  if (!value) return "Zeitpunkt unbekannt";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "Zeitpunkt unbekannt"
    : new Intl.DateTimeFormat("de-DE", { dateStyle: "medium", timeStyle: "short" }).format(date);
}

export function statusOf(pr: PullRequest) {
  if (pr.checks.state === "failure" || pr.checks.failed > 0) {
    return { icon: "✖", label: `Checks fehlgeschlagen${pr.checks.failed ? ` · ${pr.checks.failed}` : ""}`, tone: "danger" };
  }
  if (pr.mergeState === "conflict") return { icon: "⚠", label: "Konflikte", tone: "danger" };
  if (pr.mergeState === "behind") return { icon: "⇣", label: "Branch liegt zurück", tone: "warning" };
  if (pr.checks.state === "pending") {
    return { icon: "◌", label: `Checks laufen${pr.checks.pending ? ` · ${pr.checks.pending}` : ""}`, tone: "info" };
  }
  if (pr.checks.state === "success") return { icon: "✓", label: "Checks bestanden", tone: "success" };
  return { icon: "?", label: "Status unbekannt", tone: "muted" };
}

export function handoffPrompt(pr: PullRequest, mode: "summary" | "work"): string {
  const activity = pr.activity.latestBody?.trim();
  const activityLine = activity
    ? `Neueste Aktivität von ${pr.activity.latestAuthor || "unbekannt"} (${exactTime(pr.activity.latestAt)}):\n> ${activity}`
    : "Keine Kommentarzusammenfassung verfügbar.";
  const status = statusOf(pr);
  const common = [
    `PR-Kontext: ${pr.owner}/${pr.repository}#${pr.number} — ${pr.title}`,
    `URL: ${pr.url}`,
    `Autor: ${pr.author}${pr.isDraft ? " · Entwurf" : ""}`,
    `Branch: ${pr.headBranch} → ${pr.baseBranch}`,
    `CI: ${status.label}. Checks: ${pr.checks.passed} bestanden, ${pr.checks.failed} fehlgeschlagen, ${pr.checks.pending} laufen, ${pr.checks.skipped} übersprungen.`,
    `Merge-/Rebase-Hinweis: ${pr.mergeState}.`,
    `Review: ${pr.reviewDecision}. Kommentare: ${pr.commentCount}.`,
    activityLine,
  ];
  if (mode === "summary") {
    return `${common.join("\n")}\n\nErkläre die neueste PR-Aktivität in einfachen Worten, leite konkret gewünschte Änderungen ab und schlage eine kurze Checkliste vor. Nimm noch keine Änderungen vor und führe keine Repository- oder GitHub-Schreibaktionen aus.`;
  }
  return `${common.join("\n")}\n\nUntersuche diesen konkreten PR und setze die nötigen Änderungen lokal um, sofern der passende Checkout bereits vorhanden ist. Beginne mit einer kurzen Einschätzung und arbeite nachvollziehbar. Wenn der Checkout fehlt oder unklar ist, frage zuerst nach, statt einen Checkout oder Worktree anzulegen. Keine GitHub-Kommentare, Reviews, Pushes, Merges oder Rebases ohne meine ausdrückliche Zustimmung.`;
}

export function groupPullRequests(pullRequests: PullRequest[]) {
  const groups = new Map<string, PullRequest[]>();
  for (const pr of pullRequests) {
    const key = `${pr.owner}/${pr.repository}`;
    const group = groups.get(key) ?? [];
    group.push(pr);
    groups.set(key, group);
  }
  return [...groups.entries()]
    .map(([name, prs]) => ({
      name,
      prs: prs.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)),
      latest: Math.max(...prs.map(pr => Date.parse(pr.updatedAt) || 0)),
    }))
    .sort((a, b) => b.latest - a.latest);
}
