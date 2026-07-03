import type { MipResult } from "./mip-parser";

export type LabelDecision = "allow" | "block" | "confirm";

export interface MipLabelMap {
  allowO: string[];
  denyUnlabeled: boolean;
}

export function decide(mipResult: MipResult, mipLabelMap: MipLabelMap): LabelDecision {
  if (mipResult.labelStatus === "labeled") {
    if (mipResult.labelGuid && mipLabelMap.allowO.includes(mipResult.labelGuid)) {
      return "allow";
    }
    return "block";
  }

  if (mipResult.labelStatus === "unlabeled") {
    return mipLabelMap.denyUnlabeled ? "block" : "confirm";
  }

  // encrypted | unsupported | error -> cannot read the label, fail-closed.
  return "block";
}
