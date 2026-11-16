import type { PullRequest, PullRequestSnapshot } from "../shared/types";
import { fetchPullRequests, type ActivityPullRequest, type Cancel, type Clock, type GhRunner, type Scheduler } from "./github";
import type { OriginStore, PullRequestActivityState, PullRequestOrigin } from "./origins";

const interval = 120_000;
export class PullRequestService {
  private data: PullRequest[] = [];
  private viewer?: string;
  private refreshedAt?: string;
  private error?: string;
  private auth: PullRequestSnapshot["auth"] = { state: "checking" };
  private refreshing = false;
  private flight?: Promise<PullRequestSnapshot>;
  private timer?: ReturnType<typeof setTimeout>;
  private closed = false;
  private origins = new Map<string, PullRequestOrigin>();
  private activityStates = new Map<string, PullRequestActivityState>();

  constructor(private readonly gh: GhRunner, private readonly now: Clock = () => new Date(),
    private readonly schedule: Scheduler = (cb, ms) => setTimeout(cb, ms),
    private readonly cancel: Cancel = clearTimeout,
    private readonly onActivity: (event: { id: string; pullRequestId: string; timestamp: string; author: string; bodyExcerpt: string }) => void = () => {},
    private readonly originStore?: OriginStore) {}

  start() { void this.refresh(); this.plan(); }
  stop() { this.closed = true; if (this.timer) this.cancel(this.timer); }
  snapshot(): PullRequestSnapshot {
    return { viewer: this.viewer, pullRequests: this.data.map(p => ({ ...p, activity: { ...p.activity } })),
      refreshedAt: this.refreshedAt, stale: Boolean(this.error), refreshing: this.refreshing,
      auth: { ...this.auth }, error: this.error };
  }
  async markSeen(id: string) {
    await this.originStore?.markActivitySeen(id);
    const key = id.toLowerCase();
    const previous = this.activityStates.get(key);
    if (previous) this.activityStates.set(key, { ...previous, unseen: false });
    this.data = this.data.map(p => p.id.toLowerCase() === key ? { ...p, activity: { ...p.activity, unseen: false } } : p);
    return this.snapshot();
  }
  setOrigins(origins: ReadonlyMap<string, PullRequestOrigin>) {
    this.origins = new Map([...origins].map(([id, origin]) => [id.toLowerCase(), origin]));
    this.data = this.data.map(pr => ({ ...pr, origin: this.origins.get(pr.id.toLowerCase()) }));
  }
  setOrigin(id: string, origin: PullRequestOrigin) {
    this.origins.set(id.toLowerCase(), origin);
    this.data = this.data.map(pr => pr.id.toLowerCase() === id.toLowerCase() ? { ...pr, origin } : pr);
  }
  refresh(): Promise<PullRequestSnapshot> {
    if (this.flight) return this.flight;
    this.refreshing = true;
    this.flight = (async () => {
      try {
        const result = await fetchPullRequests(this.gh);
        if (this.originStore) {
          try { this.origins = new Map(await this.originStore.load()); } catch { /* Provenance is optional. */ }
        }
        const updated: PullRequest[] = [];
        for (const pr of result.pullRequests as ActivityPullRequest[]) {
          const key = pr.id.toLowerCase();
          const previous = this.activityStates.get(key);
          let observed: { isNew: boolean; unseen: boolean };
          if (this.originStore) {
            try {
              observed = await this.originStore.observeActivity(pr.id, pr._latestActivityId);
            } catch {
              observed = this.observeInMemory(key, pr._latestActivityId, previous);
            }
          } else {
            observed = this.observeInMemory(key, pr._latestActivityId, previous);
          }
          this.activityStates.set(key, {
            activityId: pr._latestActivityId ?? previous?.activityId,
            unseen: observed.unseen,
          });
          if (observed.isNew && pr._latestActivityId) {
            this.onActivity({ id: pr._latestActivityId, pullRequestId: pr.id,
              timestamp: pr.activity.latestAt ?? this.now().toISOString(),
              author: pr.activity.latestAuthor ?? "", bodyExcerpt: (pr.activity.latestBody ?? "").slice(0, 240) });
          }
          const { _latestActivityId: _privateActivityId, ...publicPR } = pr;
          updated.push({
            ...publicPR,
            origin: this.origins.get(key),
            activity: { ...pr.activity, unseen: observed.unseen },
          });
        }
        this.viewer = result.viewer;
        this.data = updated;
        this.refreshedAt = this.now().toISOString(); this.error = undefined;
        this.auth = { state: "ready" };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.error = message;
        this.auth = { state: /not found|ENOENT/i.test(message) ? "missing-cli" : /auth|login/i.test(message) ? "unauthenticated" : "error", message };
      } finally {
        this.refreshing = false; this.flight = undefined; this.plan();
      }
      return this.snapshot();
    })();
    return this.flight;
  }
  private observeInMemory(key: string, activityId: string | undefined, previous?: PullRequestActivityState) {
    if (!previous) return { isNew: false, unseen: false };
    if (activityId && activityId !== previous.activityId) return { isNew: true, unseen: true };
    return { isNew: false, unseen: previous.unseen };
  }
  private plan() {
    if (this.closed) return;
    if (this.timer) this.cancel(this.timer);
    const recent = this.data.some(p => this.now().getTime() - Date.parse(p.updatedAt) < interval);
    const pending = this.data.some(p => p.checks.state === "pending");
    this.timer = this.schedule(() => { void this.refresh(); }, pending || recent ? 30_000 : interval);
  }
}

export const defaultGh: GhRunner = async args => {
  const proc = Bun.spawn(["gh", ...args], { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) throw new Error(err.trim() || `gh exited with code ${code}`);
  return out;
};
