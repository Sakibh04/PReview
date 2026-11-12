# AGENTS.md

VS Code extension, plain CommonJS, no build step.

- `extension.js`: host. Activation, commands, comment-thread sync, webview panel, request lifecycle.
- `lib/providers.js`: pure Node (no `vscode` import). Prompt building (`buildMessages`), Ollama NDJSON streaming, and Claude streaming via `@anthropic-ai/sdk`.
- `media/preview.js` + `media/preview.css`: webview UI, loaded as real files via `asWebviewUri` with a nonce CSP. `preview.js` also exports `renderMarkdown` under Node for tests.

## Dev commands

- `npm run lint`: `node --check` on each source file (syntax only).
- `npm test`: `node --test`. `test/extension.test.js` stubs `vscode` via `Module._load` before requiring `extension.js`. The Claude tests inject `createClient`, so they make no network calls and spend no credits.
- Debug with the `.vscode/launch.json` "Run Extension" config (F5).

## Architecture notes

- **State lives in the host.** `entries[]` holds each review: `payload` (file, range, numbered context lines) and `turns[]` (`prompt`, `answer`, `status` of `pending|streaming|done|error|cancelled`, `provider`, `model`, timings, `usage`). Turn 0 is the original question, and later turns are follow-ups.
- **The webview renders from data only.** Host → webview messages: `init` (full state, sent in reply to `ready`), `entry` (upsert one entry), `chunk` (streamed text for one turn), `removed`, `provider`. Webview → host: `ready`, `follow-up`, `retry`, `ask-claude`, `cancel`, `copy`, `reveal`, `remove`, `clear`, `select-provider`, `webview-error`. Because the webview always gets a full `init` on load, messages lost before `ready` don't matter. Never rebuild `webview.html` to push updates.
- **Entries outlive the panel.** Closing the panel does not abort requests. `showPanel` recreates it and the `ready`/`init` handshake restores everything.
- **Comment threads.** `threadToEntry` maps a thread to its entry, so a reply typed in a thread that already has an entry becomes a follow-up. `syncThread` rewrites `thread.comments` at each turn's start and end, not per chunk.
- **Conversation replay.** `buildMessages(entry, i)` replays only `done` turns before `i`, so user and assistant roles always alternate. The code context rides on the first user message.
- **Claude.** The default model is `claude-opus-5-5` with `output_config.effort` (default `medium`). Don't send `thinking: {type: "disabled"}` or `budget_tokens`, which return 400 on that model. Supported models also get server-side refusal fallbacks (`betas: ['server-side-fallback-2026-07-01']`, `fallbacks: 'default'`). The API key is stored in `context.secrets` (`reviewComments.anthropicApiKey`), with `ANTHROPIC_API_KEY` as a fallback. Claude is only called when the provider setting is `anthropic` or the user clicks **Ask Claude**.
- Requests time out after 180s (`REQUEST_TIMEOUT_MS`). Every request has its own `AbortController` in `activeRequests` (key `entryId:turnId`).
- Defaults in `lib/providers.js` (`OLLAMA_URL`, `OLLAMA_MODEL`, `ANTHROPIC_MODEL`, `ANTHROPIC_EFFORT`) must match the `contributes.configuration` defaults in `package.json`.
- Model text is always escaped (`escapeHtml` in `preview.js`) before markdown formatting is applied.
