# PReview AI Comments

Line-level AI code review inside VS Code comment threads. Ask about any line, get an answer in the editor thread and in the PReview panel, then keep the conversation going with follow-ups. It runs on a local Ollama model by default, and you can send any single question to Claude when you want a stronger answer.

## Features

- **Ask from the gutter.** Click **+** next to a line, type a question (or leave it blank for a review), then press **Send comment**. The answer is posted back into that thread.
- **Ask from a selection.** Select code, right-click, then **PReview: Review Selection** or **Explain Selection** (`Cmd+Alt+R` / `Ctrl+Alt+R` reviews the selection).
- **Real conversations.** Reply in the editor thread or in the panel. Every follow-up sends the whole conversation and the code context.
- **Severity-tagged reviews.** Findings are tagged high, medium or low and come with concrete fixes. Each code block has a Copy button.
- **Claude on demand.** Every Ollama answer has an **Ask Claude** button that re-runs just that question with Claude. Or switch the default provider from the status bar.
- **Panel that matches your theme.** It uses VS Code theme colours (light, dark, high contrast). It shows streaming output, Stop and Retry, time taken, token usage for Claude, and a jump-to-code link on every review.

## Requirements

- VS Code 1.90 or newer.
- For the default provider: [Ollama](https://ollama.com) running locally with a model pulled (default `qwen2.5-coder:7b`).
- For Claude (optional): an Anthropic API key.

## Setup

```bash
npm install
ollama serve
ollama pull qwen2.5-coder:7b
```

Open the folder in VS Code and press F5 (**Run Extension**) to start an Extension Development Host.

### Using Claude

1. Run **PReview: Set Claude API Key** from the Command Palette. The key goes into VS Code Secret Storage, never into settings. `ANTHROPIC_API_KEY` in the environment also works.
2. Click **Ask Claude** on any answer, or click the **PReview** status bar item to make Claude the default.

Nothing is sent to Claude unless you pick it. Ollama stays the default.

## Settings

| Setting | Default | Purpose |
|---|---|---|
| `reviewComments.provider` | `ollama` | Default provider: `ollama` or `anthropic` |
| `reviewComments.ollamaUrl` | `http://127.0.0.1:11434/api/chat` | Ollama chat endpoint |
| `reviewComments.ollamaModel` | `qwen2.5-coder:7b` | Ollama model |
| `reviewComments.anthropicModel` | `claude-opus-5-5` | Claude model ID |
| `reviewComments.anthropicEffort` | `medium` | Claude effort: `low` … `max` (higher is more thorough and costs more) |
| `reviewComments.contextLines` | `15` | Lines of surrounding code sent above and below the selection |
| `reviewComments.replyInThread` | `true` | Also post answers into the editor comment thread |

## Troubleshooting

- **"Could not reach Ollama"**: run `ollama serve`, or fix `reviewComments.ollamaUrl`.
- **"Model … is not installed"**: run the `ollama pull …` command shown, or change `reviewComments.ollamaModel`.
- **"Claude rejected the API key"**: run **PReview: Set Claude API Key** again.
- Logs are in the **Output** panel under **PReview**.

## Development

```bash
npm run lint   # syntax check of every source file
npm test       # unit tests (Node 18+). No network: the Claude client is faked.
```

Layout: `extension.js` (VS Code host), `lib/providers.js` (prompts, Ollama and Claude streaming), `media/` (webview UI).
