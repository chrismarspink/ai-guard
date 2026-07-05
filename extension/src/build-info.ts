// Build stamp injected by scripts/build.mjs via Vite `define`. Guarded with a
// typeof check so unit tests (vitest, no define) fall back to a dev stamp
// instead of throwing on the undefined global.
declare const __BUILD_INFO__:
  | { version: string; buildDate: string; buildId: string }
  | undefined;

export const BUILD_INFO =
  typeof __BUILD_INFO__ !== "undefined"
    ? __BUILD_INFO__
    : { version: "dev", buildDate: "", buildId: "dev" };
