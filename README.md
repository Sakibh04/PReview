# PReview AI Comments

PReview AI Comments is a VS Code extension that sends a comment-thread selection to a local Ollama model and shows the result in a preview panel. It is designed for quick code explanations and review-style feedback directly from the Comments UI.

## Features

- Adds a `Review Comments: Send to AI` action to comment threads.
- Sends the selected code, surrounding context, and your comment text to Ollama.
- Streams the model response into a preview panel.
- Supports both review prompts and explanation prompts.
- Hides the serialized payload from the UI and output channel.

## Requirements

- VS Code 1.90.0 or newer.
- Ollama installed and running locally.
- A downloaded model. The default is `qwen2.5-coder:7b`.

## Setup

1. Start Ollama.
   ```bash
   ollama serve
   ```
2. Make sure the model is available.
   ```bash
   ollama list
   ```
3. Open the extension in VS Code.
4. Launch the Extension Development Host from the Run and Debug view.

## Usage

1. Open a file in VS Code.
2. Create or open a comment thread on a line of code.
3. Add a comment such as `explain this function` or a review request.
4. Click `Review Comments: Send to AI` from the thread actions.
5. Wait for the `AI Review Result` panel to appear.

If your comment text includes `explain`, the extension asks Ollama to explain the selected code in plain language. Otherwise, it asks for concise review feedback.

## Configuration

The extension exposes two settings:

- `reviewComments.ollamaUrl`
- `reviewComments.ollamaModel`

Defaults:

```json
{
  "reviewComments.ollamaUrl": "http://127.0.0.1:11434/api/chat",
  "reviewComments.ollamaModel": "qwen2.5-coder:7b"
}
```

Set these in VS Code settings if you want to use a different local Ollama endpoint or model.

## Troubleshooting

- If the action is not visible, reload the Extension Development Host after changing the extension.
- If the response does not appear, confirm that Ollama is running and the model name matches your local install.
- If the model fails to respond, check the Output panel for `AI Review Comments`.
- If you changed the model or endpoint, make sure the extension settings still point to a reachable local Ollama server.

## Development

Lint the main file with:

```bash
npm run lint
```

The extension entrypoint is [extension.js](extension.js), and the manifest is [package.json](package.json).
