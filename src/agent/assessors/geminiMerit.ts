import { GoogleGenAI } from "@google/genai";
import { CRITERIA, computeMerit, type MeritAssessor } from "../scoring.js";
import type { Application, CriterionScore } from "../../types/grant.js";
import type { ProgramConfig, MeritCriterion } from "../../types/program.js";

// LLM merit assessor — Gemini reads the application narrative and scores the six
// anchored criteria (0–5) with a one-line rationale each. The weighting and the
// final 0–100 merit are computed deterministically from the anchors (reusing
// computeMerit), so the scoring stays explainable and the model only does the
// part it's good at: judging the text.

const ANCHOR_GUIDE: Record<MeritCriterion, string> = {
  need: "genuineness + severity of the need ON ITS OWN MERITS, regardless of sector or country — 0 no real need, 3 real need, 5 acute, urgent, unmet need",
  feasibility: "0 unrealistic for the amount, 3 feasible with some stretch, 5 clearly executable",
  impact_per_dollar: "benefit per dollar for the people helped — 0 costly for little, 3 reasonable, 5 high benefit per dollar",
  plan_clarity: "0 vague, 3 has a plan, 5 concrete steps + milestones + budget",
  local_legitimacy: "0 anonymous / no trace, 3 some presence or verifiable context, 5 staked endorser and/or prior delivery",
  sdg_alignment: "alignment with ANY UN Sustainable Development Goal (no poverty, zero hunger, health, education, gender, clean water, energy, sustainable cities, climate, peace, etc.) — 0 none, 3 partial, 5 strong fit to any SDG",
};

export class GeminiMeritAssessor implements MeritAssessor {
  private readonly ai: GoogleGenAI;
  constructor(apiKey: string, private readonly model = process.env.GEMINI_MODEL ?? "gemini-2.5-flash-lite") {
    this.ai = new GoogleGenAI({ apiKey });
  }

  async assess(app: Application, cfg: ProgramConfig, media?: { mimeType: string; data: string }[]) {
    const rubric = CRITERIA.map((c) => `- ${c}: ${ANCHOR_GUIDE[c]}`).join("\n");
    const hasMedia = !!media && media.length > 0;
    const prompt = [
      `You are the merit officer for "${cfg.title}", an OPEN humanitarian microgrant fund.`,
      `It funds genuine need in ANY sector and ANY country (food, water, health, education, shelter, livelihood, energy, disaster/war relief, climate, etc.).`,
      `Do NOT penalize an application for its cause, sector, or location — a war-displaced family needing food is just as in-scope as a climate project. Judge each criterion on its own merits.`,
      `Score this application on each criterion with an integer anchor 0–5 and a one-sentence rationale.`,
      "",
      "Criteria & anchors:",
      rubric,
      "",
      "Application:",
      `- category: ${app.category}`,
      `- location: ${app.geo}`,
      `- requested: ${app.requestedAmount} ${cfg.currency}`,
      `- has staked local endorser: ${app.applicant.endorser ? "yes" : "no"}`,
      `- wallet age (days): ${app.applicant.wallet.ageDays}, prior delivered grants: ${app.applicant.wallet.priorGrants}`,
      `- narrative: """${app.narrative}"""`,
      hasMedia ? `\n${media!.length} supporting image(s) are attached below — examine them and let them inform feasibility, plan clarity, impact, and local legitimacy (e.g. does the photo evidence the stated need or capability?).` : "",
      "",
      `Return ONLY JSON of this exact shape: {${CRITERIA.map((c) => `"${c}":{"anchor":0-5,"rationale":"..."}`).join(",")}}`,
    ].join("\n");

    const parts: unknown[] = [{ text: prompt }];
    if (hasMedia) for (const m of media!) parts.push({ inlineData: { mimeType: m.mimeType, data: m.data } });

    const resp = await this.ai.models.generateContent({
      model: this.model,
      contents: parts as never,
      config: { responseMimeType: "application/json", temperature: 0.2 },
    });

    let raw: Record<string, { anchor?: unknown; rationale?: unknown }> = {};
    try {
      raw = JSON.parse(resp.text ?? "{}");
    } catch {
      raw = {};
    }

    const breakdown: CriterionScore[] = CRITERIA.map((criterion) => {
      const r = raw[criterion] ?? {};
      let anchor = Math.round(Number(r.anchor));
      if (!Number.isFinite(anchor) || anchor < 0) anchor = 0;
      if (anchor > 5) anchor = 5;
      const rationale = String(r.rationale ?? "").trim().slice(0, 220) || `${criterion}: scored ${anchor}/5.`;
      return { criterion, anchor: anchor as CriterionScore["anchor"], weight: cfg.scoring.weights[criterion], rationale };
    });

    return computeMerit(breakdown, cfg);
  }
}
