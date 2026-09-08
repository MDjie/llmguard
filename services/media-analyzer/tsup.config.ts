import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["services/media-analyzer/src/server.ts"],
  format: ["esm"],
  platform: "node",
  target: "node24",
  outDir: "services/media-analyzer/dist",
  splitting: false,
  clean: true,
  noExternal: ["zod", "saxes", "xmlchars"],
});
