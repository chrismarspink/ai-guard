import { describe, expect, it } from "vitest";
import { matchAdapter } from "../src/adapters/adapter-loader";
import chatgpt from "../src/adapters/chatgpt.json";
import claude from "../src/adapters/claude.json";
import type { SiteAdapter } from "../src/adapters/types";

const adapters = [chatgpt, claude] as unknown as SiteAdapter[];

describe("matchAdapter", () => {
  it("matches a ChatGPT URL", () => {
    expect(matchAdapter("https://chatgpt.com/c/123", adapters)?.id).toBe("chatgpt");
  });

  it("matches a Claude URL", () => {
    expect(matchAdapter("https://claude.ai/chat/abc", adapters)?.id).toBe("claude");
  });

  it("returns null for an unmatched URL", () => {
    expect(matchAdapter("https://example.com/", adapters)).toBeNull();
  });
});
