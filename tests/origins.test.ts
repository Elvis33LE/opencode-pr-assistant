import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectCreatedPullRequest, SqliteOriginStore } from "../src/core/origins";

describe("PR provenance", () => {
  test("only records completed shell gh pr create with canonical GitHub PR URL", () => {
    const valid = {
      tool: "shell",
      status: "completed",
      input: { command: "gh pr create --fill" },
      result: { content: "https://github.com/acme/widget/pull/42\n" },
    };
    expect(detectCreatedPullRequest(valid)?.id).toBe("acme/widget#42");
    expect(detectCreatedPullRequest({ ...valid, status: "error" })).toBeUndefined();
    expect(detectCreatedPullRequest({ ...valid, input: { command: "gh pr view 42" } })).toBeUndefined();
    expect(detectCreatedPullRequest({ ...valid, result: { content: "https://github.enterprise.test/acme/widget/pull/42" } })).toBeUndefined();
    expect(detectCreatedPullRequest({ ...valid, tool: "read" })).toBeUndefined();
  });

  test("persists account-wide metadata atomically across store instances without transcripts", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pr-assistant-origin-"));
    const file = join(directory, "origins.sqlite");
    const origin = { sessionID: "ses_123", parentSessionID: "ses_parent", observedAt: "2026-11-16T00:00:00.000Z",
      title: "Add widget API", projectDirectory: "C:/work/widget", projectID: "project-a",
      evidence: "gh-pr-create" as const, navigationScope: "current-server" as const };
    try {
      const first = new SqliteOriginStore(new Database(file));
      await first.put("Acme/Widget#42", origin);
      first.close();
      const second = new SqliteOriginStore(new Database(file));
      expect((await second.load()).get("acme/widget#42")).toEqual(origin);
      second.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
