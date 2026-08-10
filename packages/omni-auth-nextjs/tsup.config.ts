import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    middleware: "src/middleware.ts",
  },
  format: ["esm", "cjs"],
  dts: true,
  splitting: false,
  sourcemap: true,
  clean: true,
  external: [
    "omni-auth",
    "omni-auth/request",
    "next",
    "next/headers",
    "next/server",
  ],
  target: "es2020",
});
