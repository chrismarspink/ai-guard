import { mask, type ClassificationResult } from "./t1-engine";

/**
 * Mask every entity-detection span in place (KR_RRN, emails, API keys, etc.).
 * Keyword hits (type starting "KEYWORD:") are intentionally left untouched --
 * they're the user's own wording ("기밀", "대외비"), not PII, and masking
 * them wouldn't reduce privacy risk while confusingly mangling the sentence.
 * Mirrors the reference fileTrench's anonymize.ts approach (span-based
 * in-place replacement) but always masks rather than offering
 * suppress/remove/pseudonymize strengths, since this module has no
 * server-fetched anonymization-rules policy to select a strength from.
 */
export function anonymizeText(text: string, result: ClassificationResult): string {
  const spans = result.detections
    .filter((d) => !d.type.startsWith("KEYWORD:"))
    .flatMap((d) => d.spans)
    .sort((a, b) => a[0] - b[0]);

  let out = "";
  let cursor = 0;
  for (const [start, end] of spans) {
    if (start < cursor) continue; // overlap guard: keep output offsets monotonic
    out += text.slice(cursor, start);
    out += mask(text.slice(start, end));
    cursor = end;
  }
  out += text.slice(cursor);
  return out;
}
