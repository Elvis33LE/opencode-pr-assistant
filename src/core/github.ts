import type { PullRequest, PullRequestCheck } from "../shared/types";

export type GhRunner = (args: string[]) => Promise<string>;
export type Clock = () => Date;
export type Scheduler = (callback: () => void, ms: number) => ReturnType<typeof setTimeout>;
export type Cancel = (handle: ReturnType<typeof setTimeout>) => void;

const QUERY = `
query($cursor: String) {
  viewer { login }
  search(query: "is:pr is:open author:@me", type: ISSUE, first: 100, after: $cursor) {
    pageInfo { hasNextPage endCursor }
    nodes {
      ... on PullRequest {
        number title url isDraft createdAt updatedAt state reviewDecision
        author { login }
        repository { name nameWithOwner owner { login } }
        headRefName baseRefName mergeStateStatus
        latestReviews(first: 1) { nodes { id author { login } body submittedAt } }
        comments(last: 10) { totalCount nodes { id author { login } body createdAt } }
        commits(last: 1) { nodes { commit { statusCheckRollup { state contexts(first: 100) {
          nodes {
            __typename
            ... on CheckRun { name conclusion status detailsUrl }
            ... on StatusContext { context state targetUrl }
          }
        } } } } }
      }
    }
  }
}`;

type Node = Record<string, any>;
export type ActivityPullRequest = PullRequest & { _latestActivityId?: string };
const text = (x: unknown) => typeof x === "string" ? x : "";
const checksFor = (pr: Node): PullRequest["checks"] => {
  const rollup = pr.commits?.nodes?.at(-1)?.commit?.statusCheckRollup;
  const items: PullRequestCheck[] = (rollup?.contexts?.nodes ?? []).map((c: Node) => {
    const raw = c.conclusion ?? c.state ?? c.status;
    const state = /SUCCESS|COMPLETED/i.test(text(raw)) ? "success"
      : /FAILURE|ERROR|CANCELLED|TIMED_OUT/i.test(text(raw)) ? "failure"
      : /PENDING|QUEUED|IN_PROGRESS|EXPECTED/i.test(text(raw)) ? "pending" : "skipped";
    return { name: text(c.name ?? c.context) || "Check", state, url: c.detailsUrl ?? c.targetUrl };
  });
  const failed = items.filter(x => x.state === "failure").length;
  const pending = items.filter(x => x.state === "pending").length;
  const passed = items.filter(x => x.state === "success").length;
  const skipped = items.filter(x => x.state === "skipped").length;
  return { state: failed ? "failure" : pending ? "pending" : items.length ? "success" : "unknown", passed, failed, pending, skipped, items };
};

export function mapPullRequest(pr: Node): ActivityPullRequest {
  const repo = pr.repository;
  const activity = [
    ...(pr.latestReviews?.nodes ?? []).map((x: Node) => ({ id: x.id, at: x.submittedAt, author: x.author?.login, body: x.body })),
    ...(pr.comments?.nodes ?? []).map((x: Node) => ({ id: x.id, at: x.createdAt, author: x.author?.login, body: x.body })),
  ].filter(x => x.at).sort((a: Node, b: Node) => Date.parse(b.at) - Date.parse(a.at))[0];
  const status = text(pr.mergeStateStatus);
  return {
    id: `${repo.owner.login}/${repo.name}#${pr.number}`,
    owner: repo.owner.login, repository: repo.name, number: pr.number,
    title: text(pr.title), url: text(pr.url), author: text(pr.author?.login),
    isDraft: Boolean(pr.isDraft), updatedAt: text(pr.updatedAt), createdAt: text(pr.createdAt),
    headBranch: text(pr.headRefName), baseBranch: text(pr.baseRefName),
    mergeState: status === "BEHIND" ? "behind" : status === "DIRTY" ? "conflict"
      : status === "CLEAN" ? "clean" : status === "BLOCKED" ? "blocked" : "unknown",
    reviewDecision: pr.reviewDecision === "APPROVED" ? "approved"
      : pr.reviewDecision === "CHANGES_REQUESTED" ? "changes-requested"
      : pr.reviewDecision === "REVIEW_REQUIRED" ? "review-required" : "unknown",
    commentCount: Number.isFinite(pr.comments?.totalCount) ? pr.comments.totalCount : 0,
    checks: checksFor(pr),
    activity: { unseen: false, latestAt: activity?.at, latestAuthor: activity?.author, latestBody: activity?.body },
    _latestActivityId: activity?.id,
  };
}

export async function fetchPullRequests(gh: GhRunner) {
  let cursor: string | null = null;
  let viewer = "";
  const pullRequests: ActivityPullRequest[] = [];
  do {
    const args = ["api", "graphql", "-f", `query=${QUERY}`];
    if (cursor) args.push("-F", `cursor=${cursor}`);
    const parsed = JSON.parse(await gh(args));
    if (parsed.errors?.length) throw new Error(parsed.errors.map((e: Node) => e.message).join("; "));
    viewer ||= text(parsed.data.viewer?.login);
    pullRequests.push(...parsed.data.search.nodes.map(mapPullRequest));
    const page = parsed.data.search.pageInfo;
    cursor = page.hasNextPage ? page.endCursor : null;
  } while (cursor);
  return { viewer, pullRequests };
}
