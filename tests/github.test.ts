import { describe, expect, test } from "bun:test";
import { mapPullRequest } from "../src/core/github";

const fixture = (reviewDecision: string | null, totalCount: number) => ({
  number: 17, title: "Fixture PR", url: "https://github.com/acme/repo/pull/17", isDraft: false,
  createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-02T00:00:00Z",
  author: { login: "ada" }, repository: { name: "repo", owner: { login: "acme" } },
  headRefName: "feature", baseRefName: "main", mergeStateStatus: "CLEAN", reviewDecision,
  comments: { totalCount, nodes: [] }, commits: { nodes: [] },
});

describe("GitHub PR normalization", () => {
  test("normalizes review decisions and total comment count", () => {
    expect(mapPullRequest(fixture("APPROVED", 5)).reviewDecision).toBe("approved");
    expect(mapPullRequest(fixture("CHANGES_REQUESTED", 2)).reviewDecision).toBe("changes-requested");
    expect(mapPullRequest(fixture("REVIEW_REQUIRED", 1)).reviewDecision).toBe("review-required");
    expect(mapPullRequest(fixture(null, 0)).reviewDecision).toBe("unknown");
    expect(mapPullRequest(fixture("APPROVED", 5)).commentCount).toBe(5);
  });
});
