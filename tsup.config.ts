import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/rpc.ts"],
  format: ["esm"],
  dts: true,
  clean: true,
  splitting: false,
  external: ["@opencode/plugin", "@opencode/plugin/rpc", "bun:sqlite"],
});
