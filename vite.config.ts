import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";
import { gui } from "@opencode/plugin/gui/vite";

export default defineConfig({
  plugins: [gui({ entry: "src/gui.tsx", outFile: "dist/gui-experimental.cjs" })],
  resolve: { alias: { "opencode-pr-assistant/rpc": fileURLToPath(new URL("./src/rpc.ts", import.meta.url)) } },
});
