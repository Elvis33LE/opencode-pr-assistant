export type CheckState = "failure" | "pending" | "success" | "unknown";

export type PullRequestCheck = {
  name: string;
  state: "failure" | "pending" | "success" | "skipped";
  url?: string;
};

export type PullRequest = {
  id: string;
  owner: string;
  repository: string;
  number: number;
  title: string;
  url: string;
  author: string;
  isDraft: boolean;
  updatedAt: string;
  createdAt: string;
  headBranch: string;
  baseBranch: string;
  mergeState: "behind" | "conflict" | "clean" | "blocked" | "unknown";
  reviewDecision: "approved" | "changes-requested" | "review-required" | "unknown";
  commentCount: number;
  checks: {
    state: CheckState;
    passed: number;
    failed: number;
    pending: number;
    skipped: number;
    items: PullRequestCheck[];
  };
  activity: {
    unseen: boolean;
    latestAt?: string;
    latestAuthor?: string;
    latestBody?: string;
  };
  origin?: {
    sessionID: string;
    parentSessionID?: string;
    observedAt: string;
    title?: string;
    projectDirectory?: string;
    projectID?: string;
    evidence: "gh-pr-create" | "explicit";
    navigationScope: "current-server";
  };
};

export type AuthState =
  | "checking"
  | "ready"
  | "missing-cli"
  | "unauthenticated"
  | "error";

export type PullRequestSnapshot = {
  viewer?: string;
  pullRequests: PullRequest[];
  refreshedAt?: string;
  stale: boolean;
  refreshing: boolean;
  auth: {
    state: AuthState;
    message?: string;
  };
  error?: string;
};

export type PullRequestActions = {
  snapshot(): Promise<PullRequestSnapshot>;
  refresh(): Promise<PullRequestSnapshot>;
  markSeen(input: { id: string }): Promise<PullRequestSnapshot>;
};
