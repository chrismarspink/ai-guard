// Korean display names for detection types, mirroring the reference
// data_classifier.py's ENTITY_LABELS table (root-level, Presidio-based) for
// the entity subset this lightweight engine actually recognizes.
const ENTITY_LABELS: Record<string, string> = {
  KR_RRN: "주민등록번호",
  KR_PHONE: "전화번호",
  KR_ACCOUNT: "계좌번호",
  CREDIT_CARD: "신용카드번호",
  EMAIL_ADDRESS: "이메일",
  AWS_ACCESS_KEY: "AWS 액세스 키",
  AWS_SECRET_KEY: "AWS 시크릿 키",
  GENERIC_API_KEY: "API 키/비밀토큰",
  PRIVATE_KEY_BLOCK: "개인키(PEM)",
  IP_ADDRESS: "IP 주소",
};

/** Keyword detections carry their display label after the "KEYWORD:" prefix
 *  already (see t1-engine.ts's scanKeywords), so this only needs to cover
 *  entity types from PATTERN_RECOGNIZERS. */
export function entityLabel(type: string): string {
  if (type.startsWith("KEYWORD:")) return type.slice("KEYWORD:".length);
  return ENTITY_LABELS[type] ?? type;
}
