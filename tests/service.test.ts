import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PullRequestService } from "../src/core/service";
import { SqliteOriginStore } from "../src/core/origins";

function fixture(activityID: string, updatedAt: string) {
  return JSON.stringify({ data: {
    viewer: { login: "ada" },
    search: {
      nodes: [{
        number: 8, title: "PR", url: "https://github.com/acme/repo/pull/8",
        isDraft: false, createdAt: "2026-01-01T00:00:00Z", updatedAt,
        author: { login: "ada" }, repository: { name: "repo", owner: { login: "acme" } },
        headRefName: "topic", baseRefName: "main", mergeStateStatus: "CLEAN", reviewDecision: "APPROVED",
        comments: { totalCount: 1, nodes: [{ id: activityID, author: { login: "reviewer" }, body: "Please update this", createdAt: updatedAt }] },
        latestReviews: { nodes: [] }, commits: { nodes: [] },
      }],
      pageInfo: { hasNextPage: false },
    },
  } });
}

const fixedTime = () => new Date("2026-11-16T12:00:00Z");
const fakeScheduler = (() => 1 as unknown as ReturnType<typeof setTimeout>);

describe("PullRequestService", () => {
  test("coalesces refreshes and keeps cached data when refresh fails", async () => {
    let calls = 0;
    const service = new PullRequestService(async () => {
      calls++;
      if (calls > 1) throw new Error("temporary network failure");
      return JSON.stringify({ data: { viewer: { login: "ada" }, search: { nodes: [], pageInfo: { hasNextPage: false } } } });
    }, fixedTime, fakeScheduler, () => {});
    await Promise.all([service.refresh(), service.refresh()]);
    const stale = await service.refresh();
    expect(calls).toBe(2);
    expect(stale.viewer).toBe("ada");
    expect(stale.stale).toBe(true);
    service.stop();
  });

  test("baseline is silent; new activity emits once and stays unread until marked seen", async () => {
    const store = new SqliteOriginStore(new Database(":memory:"));
    let response = fixture("comment-one", "2026-11-16T10:00:00Z");
    const events: string[] = [];
    const service = new PullRequestService(async () => response, fixedTime, fakeScheduler, () => {},
      event => events.push(event.id), store);

    const baseline = await service.refresh();
    expect(events).toEqual([]);
    expect(baseline.pullRequests[0].activity.unseen).toBe(false);

    response = fixture("comment-two", "2026-11-16T11:00:00Z");
    const newActivity = await service.refresh();
    expect(events).toEqual(["comment-two"]);
    expect(newActivity.pullRequests[0].activity.unseen).toBe(true);

    const repeated = await service.refresh();
    expect(events).toEqual(["comment-two"]);
    expect(repeated.pullRequests[0].activity.unseen).toBe(true);

    const seen = await service.markSeen("acme/repo#8");
    expect(seen.pullRequests[0].activity.unseen).toBe(false);
    expect((await service.refresh()).pullRequests[0].activity.unseen).toBe(false);
    service.stop();
    store.close();
  });

  test("unseen and seen state survive SQLite reloads without duplicate events", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pr-assistant-state-"));
    const file = join(directory, "state.sqlite");
    let response = fixture("comment-one", "2026-11-16T10:00:00Z");
    const gh = async () => response;
    try {
      const firstStore = new SqliteOriginStore(new Database(file));
      const first = new PullRequestService(gh, fixedTime, fakeScheduler, () => {}, undefined, firstStore);
      await first.refresh();
      response = fixture("comment-two", "2026-11-16T11:00:00Z");
      expect((await first.refresh()).pullRequests[0].activity.unseen).toBe(true);
      first.stop();
      firstStore.close();

      const secondStore = new SqliteOriginStore(new Database(file));
      const secondEvents: string[] = [];
      const second = new PullRequestService(gh, fixedTime, fakeScheduler, () => {},
        event => secondEvents.push(event.id), secondStore);
      expect((await second.refresh()).pullRequests[0].activity.unseen).toBe(true);
      expect(secondEvents).toEqual([]);
      await second.markSeen("acme/repo#8");
      second.stop();
      secondStore.close();

      const thirdStore = new SqliteOriginStore(new Database(file));
      const third = new PullRequestService(gh, fixedTime, fakeScheduler, () => {}, undefined, thirdStore);
      expect((await third.refresh()).pullRequests[0].activity.unseen).toBe(false);
      third.stop();
      thirdStore.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
