export type ContentDecision = "allow" | "block" | "confirm";

export interface ExtractStatusLike {
  status: "ok" | "unsupported" | "error";
}

export interface ClassificationLike {
  grade: "O" | "S" | "C";
}

// "audit" is handled identically to "confirm" here: this function only ever
// returns a *raw* decision, and it's the caller's job (mirroring
// content-script.ts's existing decideLabel/decidePromptAction usage) to turn
// audit mode into an "allow" override on top of that raw decision.
export function decideContent(
  extract: ExtractStatusLike,
  classification: ClassificationLike | null,
  fileMode: "block" | "confirm" | "audit",
): ContentDecision {
  if (extract.status !== "ok") {
    // Couldn't verify the content is grade O at all -- fail closed.
    return "block";
  }

  // status is "ok" but no classification was supplied -- shouldn't happen in
  // practice (the caller always classifies successfully-extracted text), but
  // fail closed rather than assume grade O.
  if (!classification) return "block";
  if (classification.grade === "O") return "allow";

  // Mirrors decidePromptAction's asymmetry: S always offers a confirm step
  // regardless of fileMode, while C respects block-mode strictly.
  if (classification.grade === "S") return "confirm";

  // grade === "C"
  return fileMode === "block" ? "block" : "confirm";
}
