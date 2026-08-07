import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["./src/index.ts", "./src/ink/index.ts", "./src/terminal/index.ts"],
  format: ["esm"],
  dts: false,
  outDir: "dist",
  clean: true,
});
