# AGENTS.md

Single-file VS Code extension. All extension logic lives in `extension.js` (entrypoint `activate`), with the full webview UI (HTML/CSS/JS) embedded as inline template literals in `renderPreviewPanel()`.

## Dev commands

- `npm run lint` is only a syntax check (`node --check extension.js`). It catches parse errors, not runtime/API errors.
- `npm test` runs `node --test` (Node 18+). Tests live in `test/extension.test.js`; they stub `vscode` via `Module._load` before requiring `extension.js`, so keep requiring `vscode` at the top of the file.
- Pure helpers (`buildOllamaRequestBody`, `buildFollowUpRequestBody`, `parseOllamaLine`, `collectContext`, `normalizeText`, `escapeHtml`, `truncateForModel`) are exported from `extension.js` solely so the tests can reach them.
- No build step, no formatter config.

## Running the extension

- Debug via the `.vscode/launch.json` "Run Extension" config (F5 from Run and Debug view) → Extension Development Host.
- Runtime requires Ollama running locally: `ollama serve`, with model `qwen2.5-coder:7b` pulled. Defaults live in `extension.js` (`OLLAMA_URL`, `OLLAMA_MODEL`) and mirror the `reviewComments.ollamaUrl` / `reviewComments.ollamaModel` settings.
- `getOllamaSettings()` reads settings first, falling back to the constants. Keep the two in sync if you change a default.

## Gotchas

- Uses global `fetch` (modern VS Code runtime) — `getOllamaReview` throws if `fetch` is missing.
- The webview is rendered once when the panel is created; it is NOT re-rendered on updates. New submission cards are appended via an `entry-added` postMessage, and all other updates (chunks, finals, statuses) go through postMessage only. State lives in module-level `previewEntries` and the webview DOM survives via `retainContextWhenHidden`; both reset when the panel is disposed (`onDidDispose`). Do not call `renderPreviewPanel()` to push updates — it reloads the whole webview and wipes the follow-up textareas.
- The webview announces `{ type: 'webview-ready' }` at the end of its script; `handleSubmit` awaits `waitForWebviewReady()` (5s fallback) before streaming so messages posted to a freshly-created webview are never lost.
- `renderPreviewPanel()` is called as a deterministic safety net after every `review-final`/`follow-up-final` (in addition to the postMessage) so results display even if a postMessage is lost. Because this reloads the webview, the follow-up composer survives via TWO mechanisms: the webview posts `composer-change` on every input (stored as `entry.composerText` and re-rendered into the textarea), and `vscode.setState` (`textareas` key) restores values on script load. The Send button's initial disabled state is derived from `entry.composerText`. Do not remove the re-render or the composer persistence independently — they exist to fix "stuck at Waiting for Ollama" without regressing the greyed-out Send button.
- Webview HTML uses `script-src 'unsafe-inline'` (CSP) to guarantee the inline script runs in all environments. The `<script>` tag must NOT carry a `nonce` attribute — per CSP3 a nonce on the element disables `'unsafe-inline'` for it, and with no matching `nonce-...` source in the CSP the script is silently blocked. All user/model text is inserted via `escapeHtml()`. The webview reports runtime errors back via a `webview-error` postMessage, logged to the output channel.
- **Template-literal escape trap:** the whole webview HTML/JS is one JS template literal, so any backslash in the webview JS is resolved by Node at render time. A `'\n'` in the webview code becomes a literal newline in the output and is a `SyntaxError` in the browser, which silently prevents the ENTIRE main script from running (reviews still render via the deterministic `renderPreviewPanel()` re-render, but no listeners/composer work). Write `'\\n'` so the rendered HTML contains `'\n'`. When checking the webview script, syntax-check the RENDERED HTML (escape-resolved), not the raw template source — `node --check` on the raw literal passes while the browser sees invalid JS.
- The "Send comment" command receives a comment reply object; `handleSubmit` resolves the thread via `reply?.thread ?? reply` and requires `thread.uri` + `thread.range`.
- Ollama streaming: the NDJSON response is parsed line-by-line in `readOllamaStream`/`parseOllamaLine`; chunk messages are posted to the webview. `markStreaming` fires on the first chunk to flip an entry/follow-up to `streaming`.
- Entries and follow-ups carry a `status` (`pending`/`streaming`/`done`/`error`) mirrored into the webview via `review-final`/`follow-up-final` messages; error text renders in red. The webview posts `send-follow-up` (composer Enter or the Send button) and `copy-review`/`copy-done` (Copy buttons) messages back.
- Requests use an `AbortController` (`createRequestSignal`) with a 120s timeout; `abortActiveRequests()` fires on panel dispose. All webview posts go through `postToPanel`, which no-ops after the panel is disposed. Follow-up context is bounded via `truncateForModel`.
- Debug logging goes to the "AI Review Comments" output channel and the same string is prefixed `[review-comments]`.
