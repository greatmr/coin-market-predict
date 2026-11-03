import { defineConfig, env } from "prisma/config";

// The Prisma CLI does not read .env by itself; load it when present so
// `npx prisma migrate ...` works the same way as the application.
try {
  process.loadEnvFile?.(".env");
} catch {
  // No .env file: rely on the process environment.
}

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    url: env("DATABASE_URL"),
  },
});
