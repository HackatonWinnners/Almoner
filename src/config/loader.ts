import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, isAbsolute } from "node:path";
import type { ProgramConfig, MeritCriterion } from "../types/program.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_DIR = join(__dirname, "..", "..", "configs");

const MERIT_CRITERIA: MeritCriterion[] = [
  "need",
  "feasibility",
  "impact_per_dollar",
  "plan_clarity",
  "local_legitimacy",
  "sdg_alignment",
];

/** Strip // and block comments so we can hand-parse .jsonc without deps. */
function stripJsonc(raw: string): string {
  return raw
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, (_m, p1) => p1);
}

function fail(msg: string): never {
  throw new Error(`[ProgramConfig] ${msg}`);
}

function assertNum(v: unknown, path: string): number {
  if (typeof v !== "number" || Number.isNaN(v)) fail(`${path} must be a number`);
  return v as number;
}

/** Validate the structural + semantic invariants the rest of the system relies on. */
export function validateConfig(cfg: ProgramConfig): ProgramConfig {
  if (!cfg.program_id) fail("program_id is required");

  // Milestone tranche percentages must sum to 100.
  const pctSum = cfg.milestones.reduce((s, m) => s + assertNum(m.tranche_pct, `milestone ${m.id}.tranche_pct`), 0);
  if (pctSum !== 100) fail(`milestone tranche_pct must sum to 100, got ${pctSum}`);

  // Scoring weights must cover every criterion and sum to ~1.0.
  const weights = cfg.scoring.weights;
  for (const c of MERIT_CRITERIA) {
    if (typeof weights[c] !== "number") fail(`scoring.weights.${c} is required`);
  }
  const weightSum = MERIT_CRITERIA.reduce((s, c) => s + weights[c], 0);
  if (Math.abs(weightSum - 1) > 1e-6) fail(`scoring.weights must sum to 1.0, got ${weightSum}`);

  // Budget sanity.
  if (cfg.budget.per_grant_cap > cfg.budget.total_pool) {
    fail("per_grant_cap exceeds total_pool");
  }

  // Approval band must straddle the auto-approve ceiling sensibly.
  const [lo, hi] = cfg.approval_policy.human_review_band;
  if (lo > hi) fail("human_review_band is inverted");
  if (hi > cfg.budget.per_grant_cap) {
    fail(`human_review_band upper (${hi}) exceeds per_grant_cap (${cfg.budget.per_grant_cap})`);
  }

  return cfg;
}

export function loadConfig(programIdOrPath: string): ProgramConfig {
  const path = isAbsolute(programIdOrPath)
    ? programIdOrPath
    : join(CONFIG_DIR, programIdOrPath.endsWith(".jsonc") ? programIdOrPath : `${programIdOrPath}.jsonc`);

  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    fail(`config not found: ${path}`);
  }

  let parsed: ProgramConfig;
  try {
    parsed = JSON.parse(stripJsonc(raw)) as ProgramConfig;
  } catch (e) {
    fail(`invalid JSONC in ${path}: ${(e as Error).message}`);
  }

  return validateConfig(parsed);
}
