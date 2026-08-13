import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    client: "src/client.ts",
    request: "src/adapters/request.ts",
    "adapters/pg": "src/builtin/pg/adapter.ts",
    "nextjs/index": "src/nextjs/index.ts",
    schema: "src/schema.ts",
    "codegen-ddl": "src/codegen-ddl.ts",
    "codegen-prisma": "src/codegen-prisma.ts",
  },
  format: ["esm", "cjs"],
  dts: true,
  splitting: false,
  sourcemap: true,
  clean: true,
  external: [
    "pg",
    "next",
    "next/headers",
    "next/server",
    "react",
  ],
  target: "es2020",
});
