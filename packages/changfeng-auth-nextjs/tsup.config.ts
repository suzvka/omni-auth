import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
  },
  format: ["esm", "cjs"],
  dts: true,
  splitting: false,
  sourcemap: true,
  clean: true,
  external: [
    "changfeng-auth",
    "next",
    "next/headers",
    "next/server",
  ],
  target: "es2020",
});
