import { defineConfig } from "rolldown";

export default defineConfig({
  input: "src/index.ts",
  platform: "node",
  tsconfig: true,
  output: {
    dir: "build",
    banner: "#!/usr/bin/env node",
    cleanDir: true,
    minify: true,
  },
});
