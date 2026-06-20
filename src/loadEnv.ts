import { existsSync } from "node:fs";

// Load a local .env (gitignored) into process.env if present, so the demos pick
// up GEMINI_API_KEY / ALMONER_* without exporting them each run. Node 22+ ships
// process.loadEnvFile. Importing this module first runs it before any env read.
if (existsSync(".env")) {
  try {
    process.loadEnvFile(".env");
  } catch {
    /* malformed or unreadable .env — ignore and fall back to real env vars */
  }
}
