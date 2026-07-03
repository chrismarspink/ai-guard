import gradeProfile from "./gradeProfile.json";

export interface Detection {
  type: string;
  count: number;
  weight: number;
  samples: string[];
  /** [start, end) offsets into the classified text -- empty for keyword hits
   *  (see anonymize.ts: keyword mentions are the user's own wording, not PII,
   *  so they're never masked). Used to build the SHAP-style contribution bar
   *  and to anonymize prompts in place. */
  spans: [number, number][];
  /** This detection's exact share of `score` (weight * post-cap count),
   *  i.e. the same "contribution" concept as the reference classifier's
   *  SHAP block -- not gradient-based, just the score term this finding
   *  contributed, which is all a regex/keyword engine can honestly claim. */
  contribution: number;
}

export type Grade = "O" | "S" | "C";

export interface ClassificationResult {
  grade: Grade;
  score: number;
  detections: Detection[];
}

interface Recognizer {
  name: string;
  pattern: string;
  flags: string;
  description?: string;
  validator: "kr_rrn_checksum" | "luhn" | null;
  weight: number;
}

interface KeywordSpec {
  keyword: string;
  weight: number;
  label: string;
}

const RECOGNIZERS = gradeProfile.recognizers as Recognizer[];
const KEYWORDS = gradeProfile.keywords as KeywordSpec[];
const BULK_PII_TYPES = new Set(gradeProfile.bulkPiiTypes as string[]);
const { cThreshold, sThreshold, bulkPiiThreshold } = gradeProfile.thresholds;
const { defaultEntityWeight, entityCountCap, kwCountCap } = gradeProfile as {
  defaultEntityWeight: number;
  entityCountCap: number;
  kwCountCap: number;
};

function luhnOk(digits: string): boolean {
  let total = 0;
  const reversed = digits.split("").reverse();
  for (let i = 0; i < reversed.length; i++) {
    let d = Number(reversed[i]);
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    total += d;
  }
  return total % 10 === 0;
}

function krRrnChecksumOk(digits: string): boolean {
  if (digits.length !== 13) return false;
  const weights = [2, 3, 4, 5, 6, 7, 8, 9, 2, 3, 4, 5];
  let total = 0;
  for (let i = 0; i < 12; i++) total += Number(digits[i]) * weights[i];
  const check = (11 - (total % 11)) % 10;
  return check === Number(digits[12]);
}

const VALIDATORS: Record<string, (raw: string) => boolean> = {
  kr_rrn_checksum: (m) => krRrnChecksumOk(m.replace(/[-\s]/g, "")),
  luhn: (m) => luhnOk(m.replace(/[ -]/g, "")),
};

export function mask(value: string): string {
  if (value.length <= 4) return "*".repeat(value.length);
  const keep = Math.max(2, Math.floor(value.length / 4));
  return value.slice(0, keep) + "*".repeat(value.length - keep);
}

function scanKeywords(text: string): Detection[] {
  const lower = text.toLowerCase();
  const out: Detection[] = [];
  for (const { keyword, weight, label } of KEYWORDS) {
    const needle = keyword.toLowerCase();
    let count = 0;
    let idx = 0;
    for (;;) {
      const j = lower.indexOf(needle, idx);
      if (j < 0) break;
      count += 1;
      idx = j + needle.length;
      if (count >= kwCountCap * 2) break;
    }
    if (count > 0) {
      out.push({ type: `KEYWORD:${label}`, count, weight, samples: [label], spans: [], contribution: 0 });
    }
  }
  return out;
}

export function classify(text: string, maxSamplesPerType = 3): ClassificationResult {
  const detections: Detection[] = [];
  let totalScore = 0;

  for (const recognizer of RECOGNIZERS) {
    const regex = new RegExp(recognizer.pattern, recognizer.flags);
    let matches = Array.from(text.matchAll(regex));
    if (recognizer.validator) {
      const validate = VALIDATORS[recognizer.validator];
      matches = matches.filter((m) => validate(m[0]));
    }
    if (matches.length === 0) continue;

    const weight = recognizer.weight ?? defaultEntityWeight;
    // C-tier types (weight >= cThreshold) count uncapped: one occurrence
    // already forces grade C, and capping wouldn't change the outcome, so
    // keep the count accurate for logging. Everything else caps at
    // entityCountCap so repeated low-weight hits don't linearly inflate the
    // score (bulk exposure is instead caught by the BULK_PII_TYPES check).
    const cap = weight >= cThreshold ? matches.length : Math.min(matches.length, entityCountCap);
    const contribution = weight * cap;
    totalScore += contribution;
    detections.push({
      type: recognizer.name,
      count: matches.length,
      weight,
      samples: matches.slice(0, maxSamplesPerType).map((m) => mask(m[0])),
      spans: matches.map((m) => [m.index!, m.index! + m[0].length]),
      contribution,
    });
  }

  for (const kw of scanKeywords(text)) {
    const cap = Math.min(kw.count, kwCountCap);
    const contribution = kw.weight * cap;
    totalScore += contribution;
    detections.push({ ...kw, contribution });
  }

  // sThreshold/cThreshold are absolute score cutoffs, not a ratio to each
  // other: a single EMAIL_ADDRESS hit (weight 1.0) already crosses 0.75.
  let grade: Grade = "O";
  if (totalScore >= cThreshold) {
    grade = "C";
  } else if (totalScore >= sThreshold) {
    grade = "S";
  }

  const bulkCount = detections.reduce((sum, d) => (BULK_PII_TYPES.has(d.type) ? sum + d.count : sum), 0);
  if (bulkCount >= bulkPiiThreshold) {
    grade = "C";
  }

  return { grade, score: Math.round(totalScore * 100) / 100, detections };
}
