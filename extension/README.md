# innoecm-ai-guard — browser extension

Chrome MV3 extension that (1) inspects LLM-site prompts for PII/secrets before
send (T1 regex engine, ported 1:1 from `profiles/data_classifier.py`), and
(2) scans the extracted text content of uploaded files through that same T1
engine, allowing the upload only when it grades exactly `"O"` (MIP label
checking still exists as an optional, off-by-default secondary layer — see
"Known deviations from the spec").

## Requirements

- Node.js 18.13+ (Node 20+ recommended; File/Blob globals used by the MIP
  parser tests need Node's built-in `File`).

## Commands

```bash
npm install       # install dependencies
npm run typecheck # tsc --noEmit (strict)
npm test          # vitest run (71 tests: t1-engine, mip-parser, label-policy,
                  # adapter-loader, content-policy, extract-text, event-queue,
                  # policy-loader, anonymize, dialog, service-worker)
npm run build     # produce dist/ (unpacked extension)
npm run dev       # same as build; no watch mode implemented yet
```

## Build approach (why not @crxjs/vite-plugin)

MV3 declarative `content_scripts` run as classic (non-module) scripts, so
they must ship as self-contained IIFEs, while the background service worker
is shipped as an ES module (`"type": "module"` in `manifest.json`). A single
`vite build` cannot mix output formats/entries like that in one pass without
a plugin such as `@crxjs/vite-plugin`. Given the newer Node/Vite versions in
this environment and the goal of a robust, dependency-light build, we instead
use `scripts/build.mjs`, which calls Vite's JS `build()` API three times
(once per entry, each with its own output format) and then copies the static
`manifest.json` into `dist/`. `vite.config.ts` is kept minimal and is only
used by Vitest (which auto-loads it) for test configuration.

## Loading unpacked into Chrome

1. `npm run build`
2. Open `chrome://extensions`
3. Enable "Developer mode" (top right)
4. Click "Load unpacked" and select the `extension/dist` folder

## Keeping things in sync

Site match patterns are duplicated in three places by design (adapters are
data, not code, per plan-doc risk R7): `manifest.json` `content_scripts[].matches`
and `host_permissions`, `src/adapters/*.json` `urls`, and
`src/policy/default-policy.json` `sites[].urls`. When adding/removing a site,
update all three.

## Module layout

- `src/engine/t1-engine.ts` — regex/score/grade engine driven by the
  pre-generated `src/engine/gradeProfile.json` bundle (do not hand-edit; it's
  generated from `profiles/data_classifier.py` via `profiles/export_patterns.py`).
- `src/mip/mip-parser.ts` — magic-number sniffing + OOXML (fflate)/PDF (XMP
  byte-scan) MIP label extraction; fails closed (`encrypted`/`unsupported`/`error`)
  whenever a label can't be read. Only invoked when `policy.fileCheck.mipCheck`
  is enabled (see `src/content-scan/` below for the v1 default gate).
- `src/mip/label-policy.ts` — turns a `MipResult` + policy's `mipLabelMap`
  into an `allow`/`block`/`confirm` decision; used only as the optional
  secondary layer alongside content scanning.
- `src/content-scan/extract-text.ts` — magic-number/extension sniffing +
  best-effort text extraction (plain text, OOXML docx/pptx/xlsx via fflate);
  fails closed (`unsupported`/`error`) for PDF, HWP/HWPX, legacy/encrypted
  OLE binaries, and anything else it can't read a text layer from.
- `src/content-scan/content-policy.ts` — turns an extract status + T1
  `ClassificationResult` into an `allow`/`block`/`confirm` decision; this is
  v1's primary file-upload gate (see "Known deviations from the spec").
- `src/adapters/*.json` — per-site selectors/endpoints (remote-updatable data,
  not code, so DOM changes don't require a new extension release).
- `src/policy/policy-loader.ts` — `getPolicy()` resolves in this order: (1)
  `chrome.storage.managed` (GPO/MDM-pushed enterprise policy, highest
  precedence), (2) the server-fetched policy cached in `chrome.storage.local`
  by `service-worker.ts` (this is what makes an admin's edit in `/admin`
  actually reach installed extensions, not just the dashboard), (3) the
  bundled `default-policy.json` fallback for unmanaged/offline installs.
- `src/background/service-worker.ts` — on install/startup and every heartbeat
  tick: registers the install with the server (`POST /install/register`,
  once — the returned token is persisted and reused, never regenerated
  locally) if not already registered, sends the heartbeat with
  `Authorization`/`X-Install-Id` headers, fetches+caches `GET /policy`
  (`If-None-Match` aware), and flushes the queued-event backlog. A `401` from
  any of these drops the stored install credentials so the next tick
  re-registers from scratch (covers a server DB reset in dev). Also routes
  `CLASSIFY_PROMPT`/`LOG_EVENT` messages from content scripts, attaching
  `getProfileEmail()`'s result as `event.user` on every `LOG_EVENT` (added
  2026-07-03 so the server's audit log can show *who* triggered an event, not
  just *which install* — see "Known deviations" below on why this only
  resolves on managed profiles).
- `src/lib/event-queue.ts` — `flush()` POSTs one event per call (the server
  has no batch endpoint — `POST /events` takes a single `EventIn`, not an
  array), stopping and reporting "unauthorized" on the first `401`, or
  keeping the unsent remainder queued with exponential backoff on any other
  failure.
- `src/content/injected.ts` (MAIN world) — hooks send/drop/paste/fetch/XHR on
  the host page; bridges to the ISOLATED content script via `window.postMessage`
  using a per-page nonce (stamped on `<html data-innoecm-nonce>`) so the
  channel can't be spoofed by the page or another extension.
- `src/content/content-script.ts` (ISOLATED world) — verifies the bridge
  nonce, calls the service worker / mip-parser, renders the confirm/block
  dialog (`src/ui/dialog.ts`, Shadow DOM), and posts the verdict back. For
  file uploads it always runs `extract-text.ts` + `content-policy.ts`
  (content scan, primary gate) and only additionally runs
  `mip-parser.ts`/`label-policy.ts` when `policy.fileCheck.mipCheck` is on,
  combining the two raw decisions block > confirm > allow before applying the
  `mode.file === "audit"` allow-override. For S/C-grade prompts it loops:
  classify → dialog → if "anonymize" chosen, mask via `engine/anonymize.ts`
  and reclassify, repeating until the user sends, cancels, or the masked
  text itself grades `"O"`.
- `src/engine/anonymize.ts` — masks every entity-detection span in place
  (keeps grade-keyword hits like "기밀" untouched -- they're the user's own
  wording, not PII). Used only for the prompt anonymize-then-send flow, not
  files.
- `src/engine/labels.ts` — Korean display names for detection types, shown
  in the dialog's findings list.
- `src/ui/dialog.ts` — shows a colored O/S/C grade badge, the findings list
  (type/count/masked samples), a per-finding contribution bar (this engine's
  honest equivalent of the reference classifier's SHAP block -- the exact
  score term each finding contributed, not a gradient attribution), a fixed
  audit-log notice, and (prompts only, grade S/C) an "익명화 후 전송" button.

## Extension ↔ server connectivity (bug found and fixed 2026-07-03)

The extension and server were originally built as two parallel workstreams
and only integration-tested via manual `curl` against the server in
isolation — nobody had verified the *extension's own* request shapes against
the *server's* actual contract. They didn't match: the extension never
called `POST /install/register` (so it had no valid bearer token at all),
sent no `Authorization`/`X-Install-Id` headers on heartbeat/events, batched
events as `{events: [...]}` when the server only accepts one event per POST,
and never fetched policy from the server at all (so an admin's edit in
`/admin` had no way to reach an installed extension — the loop only worked
one direction, extension → server). All four are fixed now (see the
`service-worker.ts`/`event-queue.ts`/`policy-loader.ts` entries above) and
verified against a live `docker compose` server, including a full
register → heartbeat → policy-fetch → event-flush → admin-edits-policy →
extension-refetches round trip.

## Known deviations from the spec

- `@crxjs/vite-plugin` was not used (see "Build approach" above); a
  hand-rolled `scripts/build.mjs` + static `manifest.json` was used instead,
  as explicitly permitted by the task brief.
- Adapter JSON is loaded via static `import` in `injected.ts`/tests rather
  than `chrome.runtime.getURL` + `fetch`, since adapters are bundled, static,
  versioned data (not remote code) — this avoids an extra async round-trip
  before hooks are installed.
- `MIP_CHECK` has no service-worker message handler: a `File`/`Blob` can't be
  structured-cloned from a content script to the service worker, so the
  ISOLATED content script calls `mip-parser.ts` directly instead.
- `mip-parser` OOXML XML entries are decoded as UTF-8 (not the plan doc's
  latin1/binary suggestion, which is reserved for the PDF byte-range scan)
  so non-ASCII label names (e.g. Korean) round-trip correctly.
- Vitest uses `happy-dom` (per-file `// @vitest-environment happy-dom`) for
  `mip-parser.test.ts` instead of `jsdom`, because jsdom's `Blob`/`File`
  polyfill doesn't implement `.slice().arrayBuffer()`, which the parser
  depends on.
- `getProfileEmail()` (`service-worker.ts`) calls `chrome.identity.getProfileUserInfo`
  with no `accountStatus` override, so it only returns an email on a
  Chrome-managed (enterprise) profile — deliberately, not a limitation to fix
  later: a workplace DLP tool pulling a user's personal Gmail out of an
  unmanaged/personal Chrome profile just because they sideloaded the
  extension would be a privacy overreach the plan doc's own "least
  privilege" principle (§8) argues against. Events from unmanaged profiles
  log `user: null` — still fully attributable by `installId`, just not to a
  person.
- **2026-07-02 product decision, not an oversight**: v1 file-upload gating
  was changed from the original plan doc's MIP-label-primary design
  (§2.2/§4.2) to whole-file content scanning through the same T1 engine used
  for prompts, allowing the upload only at grade `"O"`. MIP label checking
  still exists and works (`src/mip/`) but is now an optional secondary layer,
  off by default (`policy.fileCheck.mipCheck`), because whole-file content
  scanning is useful without requiring an org-wide MIP label rollout, while
  MIP checking remains available as an add-on for orgs that already have it.
