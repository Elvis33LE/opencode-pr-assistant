import { Plugin } from "@opencode/plugin";
import { PullRequestService, defaultGh } from "./core/service";
import { detectCreatedPullRequest, openUserOriginStore } from "./core/origins";
import { PullRequests } from "./rpc";

export default Plugin.define({
  id: "opencode-pr-assistant",
  async setup(ctx) {
    let emitActivity = (_event: import("./rpc").PullRequestActivityEvent) => {};
    const origins = await openUserOriginStore();
    const service = new PullRequestService(defaultGh, undefined, undefined, undefined,
      event => emitActivity(event), origins);
    service.setOrigins(await origins.load());
    const registration = await ctx.rpc.register(PullRequests, {
      snapshot: async () => service.snapshot(),
      refresh: async () => service.refresh(),
      markSeen: async input => service.markSeen((input as { id: string }).id),
    });
    emitActivity = event => { void registration.events.emit("activity", event); };
    const toolRegistration = await ctx.tool.hook("execute.after", async event => {
      const created = detectCreatedPullRequest(event);
      if (!created || event.status !== "completed") return;
      try {
        const session = await ctx.session.get({ sessionID: event.sessionID });
        const origin = {
          sessionID: event.sessionID,
          parentSessionID: session.parentID,
          observedAt: new Date().toISOString(),
          title: session.title,
          projectDirectory: session.location.directory,
          projectID: session.projectID,
          evidence: "gh-pr-create" as const,
          navigationScope: "current-server" as const,
        };
        await origins.put(created.id, origin);
        service.setOrigin(created.id, origin);
      } catch {
        // A successful PR creation must not be affected by optional provenance capture.
      }
    });
    service.start();
    return async () => {
      service.stop();
      await toolRegistration.dispose();
      await registration.dispose();
      origins.close();
    };
  },
});
