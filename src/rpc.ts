import { Rpc } from "@opencode/plugin/rpc";
import { z } from "zod";
import type { PullRequestSnapshot } from "./shared/types";

const checkSchema = z.object({
  name: z.string(),
  state: z.enum(["failure", "pending", "success", "skipped"]),
  url: z.string().optional(),
});
const originSchema = z.object({
  sessionID: z.string(),
  parentSessionID: z.string().optional(),
  observedAt: z.string(),
  title: z.string().optional(),
  projectDirectory: z.string().optional(),
  projectID: z.string().optional(),
  evidence: z.enum(["gh-pr-create", "explicit"]),
  navigationScope: z.literal("current-server"),
});
const pullRequestSchema = z.object({
  id: z.string(), owner: z.string(), repository: z.string(), number: z.number(),
  title: z.string(), url: z.string(), author: z.string(), isDraft: z.boolean(),
  updatedAt: z.string(), createdAt: z.string(), headBranch: z.string(), baseBranch: z.string(),
  mergeState: z.enum(["behind", "conflict", "clean", "blocked", "unknown"]),
  reviewDecision: z.enum(["approved", "changes-requested", "review-required", "unknown"]),
  commentCount: z.number(),
  checks: z.object({
    state: z.enum(["failure", "pending", "success", "unknown"]),
    passed: z.number(), failed: z.number(), pending: z.number(), skipped: z.number(), items: z.array(checkSchema),
  }),
  activity: z.object({
    unseen: z.boolean(), latestAt: z.string().optional(), latestAuthor: z.string().optional(), latestBody: z.string().optional(),
  }),
  origin: originSchema.optional(),
});
const snapshotSchema: z.ZodType<PullRequestSnapshot> = z.object({
  viewer: z.string().optional(),
  pullRequests: z.array(pullRequestSchema),
  refreshedAt: z.string().optional(),
  stale: z.boolean(), refreshing: z.boolean(),
  auth: z.object({
    state: z.enum(["checking", "ready", "missing-cli", "unauthenticated", "error"]),
    message: z.string().optional(),
  }),
  error: z.string().optional(),
});
const activitySchema = z.object({
  id: z.string(),
  pullRequestId: z.string(),
  timestamp: z.string(),
  author: z.string(),
  bodyExcerpt: z.string(),
});

export type PullRequestActivityEvent = {
  id: string;
  pullRequestId: string;
  timestamp: string;
  author: string;
  bodyExcerpt: string;
};

export const PullRequests = Rpc.define({
  id: "opencode-pr-assistant",
  methods: {
    snapshot: { input: z.undefined(), output: snapshotSchema },
    refresh: { input: z.undefined(), output: snapshotSchema },
    markSeen: {
      input: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false },
      output: snapshotSchema,
    },
  },
  events: { activity: { schema: activitySchema } },
});
