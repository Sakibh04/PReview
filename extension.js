'use strict';

const crypto = require('node:crypto');
const vscode = require('vscode');

const CONTROLLER_ID = 'reviewComments';
const CONTROLLER_LABEL = 'AI Review Comments';
const OLLAMA_URL = 'http://127.0.0.1:11434/api/chat';
const OLLAMA_MODEL = 'qwen2.5-coder:7b';
let previewPanel;
let previewEntries = [];

function activate(context) {
  const outputChannel = vscode.window.createOutputChannel('AI Review Comments');
  const controller = vscode.comments.createCommentController(CONTROLLER_ID, CONTROLLER_LABEL);

  controller.options = {
    prompt: 'Send this comment to the AI reviewer',
    placeHolder: 'Write feedback, then submit it from the thread actions.'
  };

  controller.commentingRangeProvider = {
    provideCommentingRanges(document) {
      if (document.lineCount === 0) {
        return [];
      }

      const endLine = document.lineCount - 1;
      const endCharacter = document.lineAt(endLine).range.end.character;
      return [new vscode.Range(0, 0, endLine, endCharacter)];
    }
  };

  context.subscriptions.push(
    outputChannel,
    controller,
    vscode.commands.registerCommand('reviewComments.submitComment', async reply => {
      outputChannel.show(true);
      outputChannel.appendLine('[review-comments] submit command invoked');
      vscode.window.showInformationMessage('Review Comments: Send to AI clicked');
      await handleSubmit(reply, outputChannel);
    })
  );

  return {
    controller
  };
}

async function handleSubmit(reply, outputChannel) {
  try {
    outputChannel.appendLine(`[review-comments] reply type: ${typeof reply}`);

    const thread = reply?.thread ?? reply;
    const commentText = normalizeText(reply?.text);
    const ollamaSettings = getOllamaSettings();

    if (!thread || !thread.uri || !thread.range) {
      const message = '[review-comments] submit ignored: missing thread or range';
      console.log(message);
      outputChannel.appendLine(message);
      vscode.window.showWarningMessage('Review Comments: missing thread data');
      return;
    }

    outputChannel.appendLine('[review-comments] opening document');
    const document = await vscode.workspace.openTextDocument(thread.uri);
    outputChannel.appendLine('[review-comments] document opened');

    const selectedRange = thread.range;
    const code = document.getText(selectedRange);
    const contextLines = collectContext(document, selectedRange, 10);
    const anchorText = code.trim() || contextLines.selected.join('\n').trim();

    const payload = {
      filePath: thread.uri.fsPath,
      relativePath: vscode.workspace.asRelativePath(thread.uri, false),
      range: {
        startLine: selectedRange.start.line + 1,
        startCharacter: selectedRange.start.character + 1,
        endLine: selectedRange.end.line + 1,
        endCharacter: selectedRange.end.character + 1
      },
      code,
      surroundingContext: contextLines,
      commentText,
      threadHistory: (thread.comments ?? []).map(comment => ({
        author: comment?.author?.name ?? 'unknown',
        body: normalizeText(comment?.body),
        timestamp: comment?.timestamp ? new Date(comment.timestamp).toISOString() : undefined
      })),
      anchorHash: crypto.createHash('sha1').update(anchorText).digest('hex')
    };

    const message = '[review-comments] submit payload';

    console.log(message);
    outputChannel.appendLine(message);

    const entry = createPreviewEntry(payload, ollamaSettings);
    const panel = showSubmissionPreview();
    let review = '';

    try {
      review = await getOllamaReview(payload, outputChannel, ollamaSettings, panel, entry.id);
    } catch (error) {
      const message = `[review-comments] Ollama review failed: ${error.message}`;
      console.error(message);
      outputChannel.appendLine(message);
      review = message;
    }

    entry.review = review;
    renderPreviewPanel();

    panel.webview.postMessage({
      type: 'review-final',
      id: entry.id,
      review
    });
  } catch (error) {
    const message = `[review-comments] submit failed: ${error.message}`;
    console.error(message);
    outputChannel.appendLine(message);
    vscode.window.showErrorMessage('Review Comments: submission failed');
  }
}

function createPreviewEntry(payload, ollamaSettings) {
  const selectedLine = payload.surroundingContext?.selected?.[0] ?? '';
  const selectedLineText = selectedLine.replace(/^\d+:\s*/, '');

  const entry = {
    id: crypto.randomUUID(),
    question: payload.commentText || 'Review this code.',
    lineNumber: payload.range?.startLine ?? 1,
    lineText: selectedLineText || '(no selected line)',
    model: ollamaSettings.model,
    review: 'Waiting for Ollama...'
  };

  previewEntries.push(entry);
  return entry;
}

function showSubmissionPreview() {
  if (!previewPanel) {
    previewPanel = vscode.window.createWebviewPanel(
      'reviewCommentsPreview',
      'AI Review Result',
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true
      }
    );

    previewPanel.onDidDispose(() => {
      previewPanel = undefined;
      previewEntries = [];
    });
  } else {
    previewPanel.reveal(vscode.ViewColumn.Beside);
  }

  renderPreviewPanel();

  return previewPanel;
}

function renderPreviewPanel() {
  if (!previewPanel) {
    return;
  }

  const nonce = crypto.randomBytes(16).toString('base64');
  const entriesHtml = previewEntries.map(entry => `
    <div class="section card">
      <h1>Ollama Response</h1>
      <p>Model: ${escapeHtml(entry.model)}</p>
      <p>Question: ${escapeHtml(entry.question)}</p>
      <p>Line ${entry.lineNumber}: ${escapeHtml(entry.lineText)}</p>
      <pre class="live" id="review-output-${escapeHtml(entry.id)}">${escapeHtml(entry.review)}</pre>
    </div>
  `).join('\n');

  previewPanel.webview.html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>AI Review Submission</title>
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${previewPanel.webview.cspSource}; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      margin: 0;
      padding: 20px;
      background: #111827;
      color: #e5e7eb;
    }
    h1 {
      font-size: 18px;
      margin: 0 0 12px;
    }
    p {
      margin: 0 0 16px;
      color: #9ca3af;
    }
    pre {
      margin: 0;
      padding: 16px;
      border-radius: 10px;
      background: #0f172a;
      color: #d1fae5;
      overflow: auto;
      white-space: pre-wrap;
      word-break: break-word;
    }
    .section {
      margin-bottom: 20px;
    }
    .card {
      border: 1px solid rgba(148, 163, 184, 0.18);
      border-radius: 14px;
      padding: 16px;
      background: rgba(15, 23, 42, 0.72);
    }
    .live {
      min-height: 80px;
    }
  </style>
</head>
<body>
  ${entriesHtml || '<div class="section"><h1>Ollama Response</h1><p>No submissions yet.</p></div>'}
  <script nonce="${nonce}">
    const outputById = new Map();

    function getOutputElement(id) {
      if (!outputById.has(id)) {
        outputById.set(id, document.getElementById('review-output-' + id));
      }

      return outputById.get(id);
    }

    window.addEventListener('message', event => {
      const message = event.data;
      if (!message || message.type === undefined) {
        return;
      }

      const reviewOutput = getOutputElement(message.id);
      if (!reviewOutput) {
        return;
      }

      if (message.type === 'review-chunk') {
        reviewOutput.textContent += message.chunk;
      }

      if (message.type === 'review-final') {
        reviewOutput.textContent = message.review || 'No response received from Ollama.';
      }
    });
  </script>
</body>
</html>`;
}

async function getOllamaReview(payload, outputChannel, ollamaSettings, panel, entryId) {
  if (typeof fetch !== 'function') {
    throw new Error('Fetch is not available in this VS Code runtime.');
  }

  const requestBody = {
    model: ollamaSettings.model,
    stream: true,
    messages: [
      {
        role: 'system',
        content: 'You are a concise code assistant. Follow the user\'s comment text as the task, and respond with only the requested output. If the user asks to explain code, explain it plainly instead of reviewing it.'
      },
      {
        role: 'user',
        content: [
          `Task from comment text: ${payload.commentText || 'Review this code.'}`,
          'Use the selected code and surrounding context to answer the task directly.',
          payload.commentText && /explain/i.test(payload.commentText)
            ? 'Explain what the selected function does, step by step, in plain language.'
            : 'If you find issues, return only the most important findings with a short fix for each.',
          JSON.stringify(payload, null, 2)
        ].join('\n\n')
      }
    ]
  };

  outputChannel.appendLine(`[review-comments] sending request to Ollama model ${ollamaSettings.model}`);

  const response = await fetch(ollamaSettings.url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(requestBody)
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Ollama request failed (${response.status}): ${errorText}`);
  }

  return readOllamaStream(response, panel, entryId);
}

async function readOllamaStream(response, panel, entryId) {
  if (!response.body || typeof response.body.getReader !== 'function') {
    const data = await response.json();
    return data?.message?.content ?? '';
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let review = '';

  while (true) {
    const { done, value } = await reader.read();

    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });

    let newlineIndex = buffer.indexOf('\n');
    while (newlineIndex !== -1) {
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      newlineIndex = buffer.indexOf('\n');

      if (!line) {
        continue;
      }

      const chunk = parseOllamaLine(line);
      if (!chunk) {
        continue;
      }

      review += chunk;
      panel.webview.postMessage({
        type: 'review-chunk',
        id: entryId,
        chunk
      });
    }
  }

  const trailing = buffer.trim();
  if (trailing) {
    const chunk = parseOllamaLine(trailing);
    if (chunk) {
      review += chunk;
      panel.webview.postMessage({
        type: 'review-chunk',
        id: entryId,
        chunk
      });
    }
  }

  return review;
}

function parseOllamaLine(line) {
  try {
    const data = JSON.parse(line);
    return data?.message?.content ?? '';
  } catch {
    return '';
  }
}

function getOllamaSettings() {
  const config = vscode.workspace.getConfiguration('reviewComments');

  return {
    url: config.get('ollamaUrl', OLLAMA_URL),
    model: config.get('ollamaModel', OLLAMA_MODEL)
  };
}

function collectContext(document, range, radius) {
  const startLine = Math.max(0, range.start.line - radius);
  const endLine = Math.min(document.lineCount - 1, range.end.line + radius);
  const before = [];
  const selected = [];
  const after = [];

  for (let line = startLine; line <= endLine; line += 1) {
    const text = `${line + 1}: ${document.lineAt(line).text}`;
    if (line < range.start.line) {
      before.push(text);
    } else if (line > range.end.line) {
      after.push(text);
    } else {
      selected.push(text);
    }
  }

  return {
    before,
    selected,
    after
  };
}

function normalizeText(value) {
  if (typeof value === 'string') {
    return value;
  }

  if (!value) {
    return '';
  }

  if (typeof value.value === 'string') {
    return value.value;
  }

  return String(value);
}

function escapeHtml(value) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function deactivate() {}

module.exports = {
  activate,
  deactivate
};