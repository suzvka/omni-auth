import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    client: "src/client.ts",
    request: "src/adapters/request.ts",
    "adapters/pg": "src/builtin/pg/adapter.ts",
  },
  format: ["esm", "cjs"],
  dts: true,
  splitting: false,
  sourcemap: true,
  clean: true,
  external: [
    "better-auth",
    "pg",
  ],
  target: "es2020",
});
