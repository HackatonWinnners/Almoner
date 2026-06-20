import type { MilestoneSpec } from "../types/program.js";
import type { EvidenceItem, VerifyResult, VerifyVerdict } from "../types/grant.js";
import type { X402Client } from "../tools/x402.js";

// Milestone evidence verification pipeline (§7).
// Fairness rule: on genuine uncertainty, escalate to a human — never auto-reject.
// The cost of erring against a poor applicant exceeds erring against the fund.

export class EvidenceVerifier {
  constructor(private readonly x402: X402Client) {}

  async verify(milestone: MilestoneSpec, evidence: EvidenceItem[]): Promise<VerifyResult> {
    const checks: VerifyResult["checks"] = [];

    // 1. Completeness — all required evidence types present.
    const present = new Set(evidence.map((e) => e.type));
    const missing = milestone.evidence.filter((t) => !present.has(t));
    checks.push({
      name: "completeness",
      pass: missing.length === 0,
      detail: missing.length ? `missing: ${missing.join(", ")}` : "all required evidence present",
    });

    // 2. Authenticity — EXIF/geo plausibility, reuse, AI-gen (paid x402 image check).
    let aiFlag = false;
    let reuse = false;
    for (const item of evidence) {
      if (item.type === "geo_photo" || item.type === "receipt") {
        const check = await this.x402.checkImage(item.blobRef, { aiGeneratedLikelihood: item.aiGeneratedLikelihood });
        if (check.aiGeneratedLikelihood > 0.7 || check.reverseImageHit) aiFlag = true;
        if (item.reusedFromPriorTranche) reuse = true;
        if (item.exifPresent === false) {
          checks.push({ name: "exif", pass: false, detail: `${item.type}: EXIF metadata absent` });
        }
        if (item.geoConsistent === false) {
          checks.push({ name: "geo", pass: false, detail: `${item.type}: geo inconsistent with program region` });
        }
      }
    }
    checks.push({ name: "authenticity_ai", pass: !aiFlag, detail: aiFlag ? "image flagged AI-generated / reverse-image hit" : "no AI-gen signal" });
    checks.push({ name: "reuse", pass: !reuse, detail: reuse ? "evidence reused from a prior tranche" : "evidence is fresh" });

    // 3 & 4. Content-match + consistency would call a vision LLM here.
    checks.push({ name: "content_match", pass: true, detail: "vision-LLM: evidence depicts claimed outcome (mock)" });

    return this.decide(milestone.id, checks);
  }

  private decide(milestoneId: string, checks: VerifyResult["checks"]): VerifyResult {
    const failed = checks.filter((c) => !c.pass);
    const hardFail = failed.some((c) => c.name === "authenticity_ai" || c.name === "reuse");
    const passRatio = (checks.length - failed.length) / checks.length;

    let verdict: VerifyVerdict;
    let confidence: number;
    if (hardFail) {
      verdict = "FAIL";
      confidence = 0.9;
    } else if (failed.length === 0) {
      verdict = "PASS";
      confidence = 0.95;
    } else if (passRatio >= 0.7) {
      verdict = "PARTIAL";
      confidence = passRatio;
    } else {
      verdict = "UNCERTAIN"; // -> human review, not auto-reject
      confidence = passRatio;
    }

    return {
      milestoneId,
      verdict,
      confidence: Math.round(confidence * 100) / 100,
      checks,
      rationale:
        verdict === "PASS"
          ? "All evidence checks passed; releasing next tranche."
          : verdict === "FAIL"
            ? `Authenticity failure (${failed.map((f) => f.name).join(", ")}); flagging.`
            : verdict === "PARTIAL"
              ? `Minor gaps (${failed.map((f) => f.name).join(", ")}); requesting fix.`
              : `Insufficient confidence; escalating to human review rather than auto-rejecting.`,
    };
  }
}
