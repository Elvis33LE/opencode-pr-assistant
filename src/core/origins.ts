import { Database } from "bun:sqlite";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { PullRequest } from "../shared/types";

export type PullRequestOrigin = NonNullable<PullRequest["origin"]>;
export type CreatedPullRequest = { id: string; owner: string; repository: string; number: number };
export type PullRequestActivityState = { activityId?: string; unseen: boolean };

export interface OriginStore {
  load(): Promise<ReadonlyMap<string, PullRequestOrigin>>;
  put(pullRequestId: string, origin: PullRequestOrigin): Promise<void>;
  observeActivity(pullRequestId: string, activityId?: string): Promise<{ isNew: boolean; unseen: boolean }>;
  loadActivityStates(): Promise<ReadonlyMap<string, PullRequestActivityState>>;
  markActivitySeen(pullRequestId: string): Promise<void>;
  close(): void;
}

export function detectCreatedPullRequest(event: {
  tool: string;
  input: unknown;
  status: string;
  result?: { content?: unknown; output?: unknown };
}): CreatedPullRequest | undefined {
  if (event.status !== "completed" || !/^(shell|bash|powershell|cmd|terminal)$/i.test(event.tool)) return;
  const input = event.input && typeof event.input === "object" ? event.input as Record<string, unknown> : {};
  const command = typeof input.command === "string" ? input.command : typeof input.cmd === "string" ? input.cmd : "";
  if (!/(^|[;&|\n]\s*)(?:gh|gh\.exe)\s+pr\s+create(?=\s|$)/im.test(command)) return;
  const strings: string[] = [];
  const collect = (value: unknown) => {
    if (typeof value === "string") strings.push(value);
    else if (Array.isArray(value)) value.forEach(collect);
    else if (value && typeof value === "object") Object.values(value).forEach(collect);
  };
  collect(event.result?.content);
  collect(event.result?.output);
  const output = strings.join("\n");
  const pattern = /https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/(\d+)(?=$|[\s/?#])/g;
  for (const match of output.matchAll(pattern)) {
    const owner = match[1], repository = match[2], number = Number(match[3]);
    if (number > 0 && Number.isSafeInteger(number)) {
      return { id: `${owner}/${repository}#${number}`, owner, repository, number };
    }
  }
}

export class SqliteOriginStore implements OriginStore {
  constructor(private readonly db: Database) {
    db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA synchronous=NORMAL;");
    db.exec(`CREATE TABLE IF NOT EXISTS pull_request_origins (
      pr_id TEXT PRIMARY KEY COLLATE NOCASE,
      origin_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`);
    db.exec(`CREATE TABLE IF NOT EXISTS pull_request_activity_state (
      pr_id TEXT PRIMARY KEY COLLATE NOCASE,
      activity_id TEXT,
      unseen INTEGER NOT NULL DEFAULT 0 CHECK (unseen IN (0, 1)),
      updated_at TEXT NOT NULL
    )`);
  }

  async load() {
    const rows = this.db.query("SELECT pr_id, origin_json FROM pull_request_origins").all() as { pr_id: string; origin_json: string }[];
    const origins = new Map<string, PullRequestOrigin>();
    for (const row of rows) {
      try {
        const origin: unknown = JSON.parse(row.origin_json);
        if (isOrigin(origin)) origins.set(row.pr_id, origin);
      } catch { /* Skip corrupt metadata rows; never block the dashboard. */ }
    }
    return origins;
  }

  async put(pullRequestId: string, origin: PullRequestOrigin) {
    const key = pullRequestId.toLowerCase();
    if (!/^[^/]+\/[^#]+#\d+$/.test(key)) throw new Error("Invalid canonical pull request ID");
    this.db.query(`INSERT INTO pull_request_origins(pr_id, origin_json, updated_at)
      VALUES (?, ?, ?) ON CONFLICT(pr_id) DO UPDATE SET
      origin_json = excluded.origin_json, updated_at = excluded.updated_at`)
      .run(key, JSON.stringify(origin), origin.observedAt);
  }

  async observeActivity(pullRequestId: string, activityId?: string) {
    const key = pullRequestId.toLowerCase();
    if (!/^[^/]+\/[^#]+#\d+$/.test(key)) throw new Error("Invalid canonical pull request ID");
    const transaction = this.db.transaction(() => {
      const existing = this.db.query(
        "SELECT activity_id, unseen FROM pull_request_activity_state WHERE pr_id = ?",
      ).get(key) as { activity_id: string | null; unseen: number } | null;
      if (!existing) {
        this.db.query(`INSERT INTO pull_request_activity_state(pr_id, activity_id, unseen, updated_at)
          VALUES (?, ?, 0, ?)`).run(key, activityId ?? null, new Date().toISOString());
        return { isNew: false, unseen: false };
      }
      if (!activityId || existing.activity_id === activityId) {
        return { isNew: false, unseen: Boolean(existing.unseen) };
      }
      this.db.query(`UPDATE pull_request_activity_state
        SET activity_id = ?, unseen = 1, updated_at = ? WHERE pr_id = ?`)
        .run(activityId, new Date().toISOString(), key);
      return { isNew: true, unseen: true };
    });
    return transaction.immediate();
  }

  async loadActivityStates() {
    const rows = this.db.query("SELECT pr_id, activity_id, unseen FROM pull_request_activity_state")
      .all() as { pr_id: string; activity_id: string | null; unseen: number }[];
    return new Map(rows.map(row => [row.pr_id, {
      activityId: row.activity_id ?? undefined,
      unseen: Boolean(row.unseen),
    }]));
  }

  async markActivitySeen(pullRequestId: string) {
    this.db.query(`UPDATE pull_request_activity_state
      SET unseen = 0, updated_at = ? WHERE pr_id = ?`)
      .run(new Date().toISOString(), pullRequestId.toLowerCase());
  }

  close() { this.db.close(); }
}

export async function openUserOriginStore(env: Record<string, string | undefined> = process.env) {
  const root = env.XDG_STATE_HOME || env.LOCALAPPDATA || join(homedir(), ".local", "state");
  const directory = join(root, "opencode-pr-assistant");
  await mkdir(directory, { recursive: true });
  return new SqliteOriginStore(new Database(join(directory, "origins.sqlite")));
}

function isOrigin(value: unknown): value is PullRequestOrigin {
  if (!value || typeof value !== "object") return false;
  const origin = value as Partial<PullRequestOrigin>;
  return typeof origin.sessionID === "string" && typeof origin.observedAt === "string"
    && (origin.evidence === "gh-pr-create" || origin.evidence === "explicit");
}
