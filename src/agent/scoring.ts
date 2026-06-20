import type { ProgramConfig, MeritCriterion } from "../types/program.js";
import type { Application, CriterionScore, MeritResult } from "../types/grant.js";

// Merit / impact scoring (§6.1). Anchored rubric -> reproducible, explainable.
// merit = Σ (anchor/5 * weight) * 100

export const CRITERIA: MeritCriterion[] = [
  "need",
  "feasibility",
  "impact_per_dollar",
  "plan_clarity",
  "local_legitimacy",
  "sdg_alignment",
];

export function computeMerit(breakdown: CriterionScore[], cfg: ProgramConfig): MeritResult {
  const score = breakdown.reduce((s, c) => s + (c.anchor / 5) * c.weight, 0) * 100;
  const rounded = Math.round(score);
  const funded = rounded >= cfg.scoring.fund_threshold;
  const top = [...breakdown].sort((a, b) => b.anchor - a.anchor)[0];
  const bottom = [...breakdown].sort((a, b) => a.anchor - b.anchor)[0];
  const summary = funded
    ? `Funded at ${rounded}/100 (threshold ${cfg.scoring.fund_threshold}). Strongest: ${top?.criterion}. Weakest: ${bottom?.criterion}.`
    : `Below threshold at ${rounded}/100 (need ${cfg.scoring.fund_threshold}). Weakest: ${bottom?.criterion} — ${bottom?.rationale}`;
  return { score: rounded, breakdown, funded, summary };
}

/** The assessment seam. `live` impl calls Claude Agent SDK with the rubric. */
export interface MeritAssessor {
  assess(app: Application, cfg: ProgramConfig): Promise<MeritResult>;
}

/** Per-criterion anchors for the offline demo. Real assessor returns these from the LLM. */
export type MeritFixture = Partial<Record<MeritCriterion, { anchor: CriterionScore["anchor"]; rationale: string }>>;

export class MockMeritAssessor implements MeritAssessor {
  constructor(private readonly fixtures: Record<string, MeritFixture> = {}) {}

  async assess(app: Application, cfg: ProgramConfig): Promise<MeritResult> {
    const fx = this.fixtures[app.id] ?? {};
    const breakdown: CriterionScore[] = CRITERIA.map((criterion) => {
      const f = fx[criterion];
      const anchor = f?.anchor ?? this.heuristicAnchor(criterion, app);
      return {
        criterion,
        anchor,
        weight: cfg.scoring.weights[criterion],
        rationale: f?.rationale ?? `Heuristic anchor ${anchor}/5 for ${criterion}.`,
      };
    });
    return computeMerit(breakdown, cfg);
  }

  // Crude fallback so the demo still produces a number without a fixture.
  private heuristicAnchor(criterion: MeritCriterion, app: Application): CriterionScore["anchor"] {
    const n = app.narrative.trim().length;
    if (criterion === "plan_clarity") return n > 200 ? 4 : n > 80 ? 3 : 1;
    if (criterion === "local_legitimacy") return app.applicant.endorser ? 5 : app.applicant.wallet.priorGrants > 0 ? 3 : 1;
    if (criterion === "feasibility") return app.requestedAmount <= 300 ? 4 : 3;
    return 3;
  }
}
