'use strict';

const crypto = require('node:crypto');
const vscode = require('vscode');

const CONTROLLER_ID = 'reviewComments';
const CONTROLLER_LABEL = 'AI Review Comments';
const OLLAMA_URL = 'http://127.0.0.1:11434/api/chat';
const OLLAMA_MODEL = 'qwen2.5-coder:7b';
const REQUEST_TIMEOUT_MS = 120000;
const MAX_REVIEW_CONTEXT = 6000;
const MAX_PAYLOAD_CONTEXT = 12000;

let previewPanel;
let previewEntries = [];
let webviewReady = false;
let resolveWebviewReady = null;
const activeRequests = new Set();

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

    const entry = createPreviewEntry(payload, ollamaSettings);
    const isNewPanel = !previewPanel;
    const panel = showSubmissionPreview(outputChannel);

    if (!isNewPanel) {
      postToPanel(panel, {
        type: 'entry-added',
        id: entry.id,
        html: renderEntryHtml(entry)
      });
    } else {
      await waitForWebviewReady();
      outputChannel.appendLine(`[review-comments] webview ready (fallback=${!webviewReady}), starting request`);
    }

    let review = '';

    try {
      review = await getOllamaReview(payload, outputChannel, ollamaSettings, panel, entry.id);
      entry.status = 'done';
    } catch (error) {
      const message = `[review-comments] Ollama review failed: ${error.message}`;
      console.error(message);
      outputChannel.appendLine(message);
      review = message;
      entry.status = 'error';
    }

    entry.review = review;
    renderPreviewPanel();
    postToPanel(panel, {
      type: 'review-final',
      id: entry.id,
      review,
      status: entry.status
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
    payload,
    question: payload.commentText || 'Review this code.',
    lineNumber: payload.range?.startLine ?? 1,
    lineText: selectedLineText || '(no selected line)',
    model: ollamaSettings.model,
    review: '',
    status: 'pending',
    composerText: '',
    followUps: []
  };

  previewEntries.push(entry);
  return entry;
}

function showSubmissionPreview(outputChannel) {
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
      abortActiveRequests();
      previewPanel = undefined;
      previewEntries = [];
      webviewReady = false;
      resolveWebviewReady = null;
    });

    webviewReady = false;
    resolveWebviewReady = null;

    previewPanel.webview.onDidReceiveMessage(async message => {
      if (message?.type === 'webview-ready') {
        webviewReady = true;
        if (resolveWebviewReady) {
          resolveWebviewReady();
          resolveWebviewReady = null;
        }
        return;
      }
      await handleWebviewMessage(message, outputChannel);
    });

    renderPreviewPanel();
  } else {
    previewPanel.reveal(vscode.ViewColumn.Beside);
  }

  return previewPanel;
}

function waitForWebviewReady() {
  if (webviewReady) {
    return Promise.resolve();
  }

  return new Promise(resolve => {
    const timer = setTimeout(() => {
      resolveWebviewReady = null;
      resolve();
    }, 5000);

    resolveWebviewReady = () => {
      clearTimeout(timer);
      resolve();
    };
  });
}

function renderPreviewPanel() {
  if (!previewPanel) {
    return;
  }

  const entriesHtml = previewEntries.map(entry => renderEntryHtml(entry)).join('\n');

  previewPanel.webview.html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>AI Review Submission</title>
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${previewPanel.webview.cspSource}; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
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
    .card-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 12px;
    }
    .status {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      font-size: 12px;
      font-weight: 600;
      padding: 3px 12px;
      border-radius: 999px;
      color: #cbd5e1;
      background: rgba(100, 116, 139, 0.18);
      border: 1px solid rgba(148, 163, 184, 0.25);
    }
    .status::after {
      content: '';
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: currentColor;
    }
    .status-pending {
      animation: pulse 1.4s ease-in-out infinite;
    }
    .status-pending::after {
      background: #fbbf24;
    }
    .status-streaming {
      color: #7dd3fc;
      background: rgba(56, 189, 248, 0.12);
      border-color: rgba(56, 189, 248, 0.35);
    }
    .status-streaming::after {
      background: #38bdf8;
      animation: blink 1s steps(2, start) infinite;
    }
    .status-done {
      color: #6ee7b7;
      background: rgba(52, 211, 153, 0.12);
      border-color: rgba(52, 211, 153, 0.35);
    }
    .status-done::after {
      background: #34d399;
    }
    .status-error {
      color: #fda4af;
      background: rgba(244, 63, 94, 0.12);
      border-color: rgba(244, 63, 94, 0.35);
    }
    .status-error::after {
      background: #fb7185;
    }
    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.55; }
    }
    @keyframes blink {
      0%, 49% { opacity: 1; }
      50%, 100% { opacity: 0.15; }
    }
    .follow-up-list {
      margin-top: 16px;
      display: grid;
      gap: 12px;
    }
    .follow-up-item {
      border-top: 1px solid rgba(148, 163, 184, 0.18);
      padding-top: 12px;
    }
    .follow-up-item p {
      margin-bottom: 8px;
    }
    .follow-up-item-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 8px;
    }
    .follow-up-output {
      min-height: 56px;
    }
    .follow-up-composer {
      display: flex;
      gap: 8px;
      align-items: stretch;
      margin-top: 16px;
    }
    .follow-up-input {
      flex: 1;
      min-height: 72px;
      resize: vertical;
      border-radius: 10px;
      border: 1px solid rgba(148, 163, 184, 0.22);
      background: rgba(2, 6, 23, 0.75);
      color: #e5e7eb;
      padding: 12px;
      font: inherit;
      box-sizing: border-box;
    }
    .follow-up-input:focus {
      outline: none;
      border-color: rgba(56, 189, 248, 0.5);
    }
    .send-btn {
      align-self: flex-end;
      background: #2563eb;
      color: #ffffff;
      border: none;
      border-radius: 10px;
      padding: 12px 18px;
      font: inherit;
      font-weight: 600;
      cursor: pointer;
      white-space: nowrap;
    }
    .send-btn:hover:not(:disabled) {
      background: #3b82f6;
    }
    .send-btn:disabled {
      background: rgba(100, 116, 139, 0.3);
      color: rgba(148, 163, 184, 0.7);
      cursor: default;
    }
    .copy-btn {
      background: none;
      border: 1px solid rgba(148, 163, 184, 0.3);
      color: #94a3b8;
      border-radius: 8px;
      padding: 3px 10px;
      font: inherit;
      font-size: 12px;
      cursor: pointer;
      white-space: nowrap;
    }
    .copy-btn:hover {
      color: #e2e8f0;
      border-color: rgba(148, 163, 184, 0.5);
    }
    .copy-btn.copied {
      color: #6ee7b7;
      border-color: rgba(52, 211, 153, 0.5);
    }
    .copy-btn:disabled {
      opacity: 0.5;
      cursor: default;
    }
    .review-output.error,
    .follow-up-output.error {
      color: #fda4af;
      border: 1px solid rgba(244, 63, 94, 0.35);
    }
    .live {
      min-height: 80px;
    }
  </style>
</head>
<body>
  <div id="entries">
    ${entriesHtml || '<div id="empty-state" class="section"><h1>Ollama Response</h1><p>No submissions yet.</p></div>'}
  </div>
  <script>
    const vscode = acquireVsCodeApi();
    const outputById = new Map();
    const followUpOutputById = new Map();
    const pendingEntries = new Set();
    const savedTextareas = (vscode.getState() && vscode.getState().textareas) || {};

    window.addEventListener('error', event => {
      vscode.postMessage({
        type: 'webview-error',
        message: String(event.message || event.error || 'unknown error'),
        line: event.lineno
      });
    });

    window.addEventListener('unhandledrejection', event => {
      vscode.postMessage({
        type: 'webview-error',
        message: 'unhandled rejection: ' + String(event.reason)
      });
    });

    function getOutputElement(id) {
      if (!outputById.has(id)) {
        outputById.set(id, document.getElementById('review-output-' + id));
      }

      return outputById.get(id);
    }

    function getFollowUpOutputElement(entryId, followUpId) {
      const key = entryId + ':' + followUpId;

      if (!followUpOutputById.has(key)) {
        followUpOutputById.set(key, document.getElementById('follow-up-output-' + entryId + '-' + followUpId));
      }

      return followUpOutputById.get(key);
    }

    function statusLabel(status) {
      if (status === 'pending') {
        return 'Waiting for Ollama';
      }

      if (status === 'streaming') {
        return 'Streaming';
      }

      if (status === 'error') {
        return 'Error';
      }

      return 'Done';
    }

    function setStatus(entryId, status) {
      const el = document.getElementById('status-' + entryId);
      if (el) {
        el.className = 'status status-' + status;
        el.textContent = statusLabel(status);
      }
    }

    function setFollowUpStatus(entryId, followUpId, status) {
      const el = document.getElementById('fu-status-' + entryId + '-' + followUpId);
      if (el) {
        el.className = 'status status-' + status;
        el.textContent = statusLabel(status);
      }
    }

    function flashCopied(button) {
      if (!button) {
        return;
      }

      const original = button.textContent;
      button.textContent = 'Copied';
      button.classList.add('copied');
      setTimeout(() => {
        button.textContent = original;
        button.classList.remove('copied');
      }, 1500);
    }

    function updateSendButton(entryId) {
      const input = document.getElementById('follow-up-input-' + entryId);
      const button = document.getElementById('send-btn-' + entryId);

      if (!input || !button) {
        return;
      }

      button.disabled = pendingEntries.has(entryId) || input.value.trim() === '';
    }

    function ensureFollowUpItem(entryId, followUpId, prompt) {
      const container = document.getElementById('follow-up-list-' + entryId);

      if (!container || document.getElementById('follow-up-' + entryId + '-' + followUpId)) {
        return;
      }

      const item = document.createElement('div');
      item.className = 'follow-up-item';
      item.id = 'follow-up-' + entryId + '-' + followUpId;

      const header = document.createElement('div');
      header.className = 'follow-up-item-header';

      const statusNode = document.createElement('span');
      statusNode.className = 'status status-pending';
      statusNode.id = 'fu-status-' + entryId + '-' + followUpId;
      statusNode.textContent = 'Waiting for Ollama';

      const copyNode = document.createElement('button');
      copyNode.className = 'copy-btn';
      copyNode.disabled = true;
      copyNode.dataset.copyEntry = entryId;
      copyNode.dataset.copyFollowUp = followUpId;
      copyNode.textContent = 'Copy';

      header.appendChild(statusNode);
      header.appendChild(copyNode);

      const promptNode = document.createElement('p');
      promptNode.textContent = 'Follow-up: ' + prompt;

      const outputNode = document.createElement('pre');
      outputNode.className = 'follow-up-output';
      outputNode.id = 'follow-up-output-' + entryId + '-' + followUpId;

      item.appendChild(header);
      item.appendChild(promptNode);
      item.appendChild(outputNode);
      container.appendChild(item);
    }

    function persistTextarea(entryId, value) {
      savedTextareas[entryId] = value;
      vscode.setState({ textareas: savedTextareas });
    }

    function sendFollowUp(entryId) {
      if (pendingEntries.has(entryId)) {
        return;
      }

      const input = document.getElementById('follow-up-input-' + entryId);

      if (!input) {
        return;
      }

      const prompt = input.value.trim();
      if (!prompt) {
        return;
      }

      pendingEntries.add(entryId);
      updateSendButton(entryId);
      vscode.postMessage({
        type: 'send-follow-up',
        entryId,
        prompt
      });

      input.value = '';
      persistTextarea(entryId, '');
      vscode.postMessage({ type: 'composer-change', entryId, value: '' });
      updateSendButton(entryId);
    }

    function copySelector(message) {
      return message.followUpId
        ? '[data-copy-entry="' + message.entryId + '"][data-copy-follow-up="' + message.followUpId + '"]'
        : '[data-copy-entry="' + message.entryId + '"]';
    }

    document.addEventListener('keydown', event => {
      const input = event.target.closest('.follow-up-input');
      if (!input || event.key !== 'Enter') {
        return;
      }

      if (event.isComposing) {
        return;
      }

      if (event.shiftKey || event.metaKey) {
        event.preventDefault();
        const start = input.selectionStart ?? input.value.length;
        const end = input.selectionEnd ?? input.value.length;
        input.value = input.value.slice(0, start) + '\\n' + input.value.slice(end);
        input.selectionStart = input.selectionEnd = start + 1;
        updateSendButton(input.dataset.entryId);
        persistTextarea(input.dataset.entryId, input.value);
        vscode.postMessage({ type: 'composer-change', entryId: input.dataset.entryId, value: input.value });
        return;
      }

      event.preventDefault();
      sendFollowUp(input.dataset.entryId);
    });

    document.addEventListener('input', event => {
      const input = event.target.closest('.follow-up-input');
      if (input && input.dataset.entryId) {
        updateSendButton(input.dataset.entryId);
        persistTextarea(input.dataset.entryId, input.value);
        vscode.postMessage({ type: 'composer-change', entryId: input.dataset.entryId, value: input.value });
      }
    });

    document.addEventListener('keyup', event => {
      const input = event.target.closest('.follow-up-input');
      if (input && input.dataset.entryId) {
        updateSendButton(input.dataset.entryId);
        persistTextarea(input.dataset.entryId, input.value);
        vscode.postMessage({ type: 'composer-change', entryId: input.dataset.entryId, value: input.value });
      }
    });

    document.addEventListener('click', event => {
      const sendButton = event.target.closest('.send-btn');
      if (sendButton && sendButton.dataset.entryId) {
        sendFollowUp(sendButton.dataset.entryId);
        return;
      }

      const copyButton = event.target.closest('.copy-btn');
      if (copyButton) {
        vscode.postMessage({
          type: 'copy-review',
          entryId: copyButton.dataset.copyEntry,
          followUpId: copyButton.dataset.copyFollowUp
        });
      }
    });

    window.addEventListener('message', event => {
      const message = event.data;
      if (!message || message.type === undefined) {
        return;
      }

      if (message.type === 'entry-added') {
        const container = document.getElementById('entries');
        if (container) {
          const emptyState = document.getElementById('empty-state');
          if (emptyState) {
            emptyState.remove();
          }
          container.insertAdjacentHTML('beforeend', message.html);
        }
      }

      if (message.type === 'review-streaming') {
        setStatus(message.id, 'streaming');
      }

      if (message.type === 'review-chunk') {
        const reviewOutput = getOutputElement(message.id);
        if (reviewOutput) {
          reviewOutput.textContent += message.chunk;
        }
        setStatus(message.id, 'streaming');
      }

      if (message.type === 'review-final') {
        const reviewOutput = getOutputElement(message.id);
        if (reviewOutput) {
          reviewOutput.textContent = message.review || 'No response received from Ollama.';
          reviewOutput.classList.toggle('error', message.status === 'error');
        }
        setStatus(message.id, message.status || 'done');
      }

      if (message.type === 'follow-up-pending') {
        ensureFollowUpItem(message.entryId, message.followUpId, message.prompt);
      }

      if (message.type === 'follow-up-streaming') {
        setFollowUpStatus(message.entryId, message.followUpId, 'streaming');
      }

      if (message.type === 'follow-up-chunk') {
        const followUpOutput = getFollowUpOutputElement(message.entryId, message.followUpId);
        if (followUpOutput) {
          followUpOutput.textContent += message.chunk;
        }
        setFollowUpStatus(message.entryId, message.followUpId, 'streaming');
      }

      if (message.type === 'follow-up-final') {
        const followUpOutput = getFollowUpOutputElement(message.entryId, message.followUpId);
        if (followUpOutput) {
          followUpOutput.textContent = message.review || 'No response received from Ollama.';
          followUpOutput.classList.toggle('error', message.status === 'error');
        }
        setFollowUpStatus(message.entryId, message.followUpId, message.status || 'done');
        const copyButton = document.querySelector(copySelector({
          entryId: message.entryId,
          followUpId: message.followUpId
        }));
        if (copyButton) {
          copyButton.disabled = false;
        }
        pendingEntries.delete(message.entryId);
        updateSendButton(message.entryId);
      }

      if (message.type === 'copy-done') {
        flashCopied(document.querySelector(copySelector(message)));
      }
    });

    document.querySelectorAll('.follow-up-input').forEach(input => {
      const entryId = input.dataset.entryId;
      if (entryId && typeof savedTextareas[entryId] === 'string') {
        input.value = savedTextareas[entryId];
      }
      updateSendButton(entryId);
    });

    vscode.postMessage({ type: 'webview-ready' });
  </script>
</body>
</html>`;
}

function statusLabel(status) {
  if (status === 'pending') {
    return 'Waiting for Ollama';
  }

  if (status === 'streaming') {
    return 'Streaming';
  }

  if (status === 'error') {
    return 'Error';
  }

  return 'Done';
}

function renderEntryHtml(entry) {
  const followUpHtml = entry.followUps.map(followUp => renderFollowUpHtml(entry.id, followUp)).join('\n');
  const status = entry.status || 'done';
  const inFlight = status === 'pending' || status === 'streaming';
  const sendDisabled = !(entry.composerText || '').trim() ? ' disabled' : '';

  return `
    <div class="section card">
      <div class="card-header">
        <span class="status status-${escapeHtml(status)}" id="status-${escapeHtml(entry.id)}">${escapeHtml(statusLabel(status))}</span>
        <button class="copy-btn" data-copy-entry="${escapeHtml(entry.id)}" ${inFlight ? 'disabled' : ''}>Copy</button>
      </div>
      <p>Model: ${escapeHtml(entry.model)}</p>
      <p>Question: ${escapeHtml(entry.question)}</p>
      <p>Line ${entry.lineNumber}: ${escapeHtml(entry.lineText)}</p>
      <pre class="live review-output${status === 'error' ? ' error' : ''}" id="review-output-${escapeHtml(entry.id)}">${escapeHtml(entry.review)}</pre>
      <div class="follow-up-list" id="follow-up-list-${escapeHtml(entry.id)}">
        ${followUpHtml}
      </div>
      <div class="follow-up-composer">
        <textarea class="follow-up-input" id="follow-up-input-${escapeHtml(entry.id)}" data-entry-id="${escapeHtml(entry.id)}" placeholder="Ask a follow-up. Enter to send, Shift+Enter for a new line.">${escapeHtml(entry.composerText || '')}</textarea>
        <button class="send-btn" id="send-btn-${escapeHtml(entry.id)}" data-entry-id="${escapeHtml(entry.id)}"${sendDisabled}>Send</button>
      </div>
    </div>
  `;
}

function renderFollowUpHtml(entryId, followUp) {
  const status = followUp.status || 'done';
  const inFlight = status === 'pending' || status === 'streaming';

  return `
    <div class="follow-up-item" id="follow-up-${escapeHtml(entryId)}-${escapeHtml(followUp.id)}">
      <div class="follow-up-item-header">
        <span class="status status-${escapeHtml(status)}" id="fu-status-${escapeHtml(entryId)}-${escapeHtml(followUp.id)}">${escapeHtml(statusLabel(status))}</span>
        <button class="copy-btn" data-copy-entry="${escapeHtml(entryId)}" data-copy-follow-up="${escapeHtml(followUp.id)}" ${inFlight ? 'disabled' : ''}>Copy</button>
      </div>
      <p>Follow-up: ${escapeHtml(followUp.prompt)}</p>
      <pre class="follow-up-output${status === 'error' ? ' error' : ''}" id="follow-up-output-${escapeHtml(entryId)}-${escapeHtml(followUp.id)}">${escapeHtml(followUp.review)}</pre>
    </div>
  `;
}

async function handleWebviewMessage(message, outputChannel) {
  if (!message || !message.type) {
    return;
  }

  if (message.type === 'webview-error') {
    outputChannel.appendLine(`[review-comments] webview error: ${message.message}${message.line ? ` (line ${message.line})` : ''}`);
    return;
  }

  if (message.type === 'composer-change') {
    const entry = previewEntries.find(item => item.id === message.entryId);
    if (entry) {
      entry.composerText = typeof message.value === 'string' ? message.value : '';
    }
    return;
  }

  if (message.type === 'send-follow-up') {
    await handleFollowUp(message.entryId, message.prompt, outputChannel);
    return;
  }

  if (message.type === 'copy-review') {
    const entry = previewEntries.find(item => item.id === message.entryId);
    const text = message.followUpId
      ? entry?.followUps.find(followUp => followUp.id === message.followUpId)?.review ?? ''
      : entry?.review ?? '';
    if (!text) {
      return;
    }
    await vscode.env.clipboard.writeText(text);
    postToPanel(previewPanel, {
      type: 'copy-done',
      entryId: message.entryId,
      followUpId: message.followUpId
    });
  }
}

async function handleFollowUp(entryId, prompt, outputChannel) {
  try {
    const entry = previewEntries.find(item => item.id === entryId);
    if (!entry) {
      return;
    }

    const followUp = {
      id: crypto.randomUUID(),
      prompt,
      review: '',
      status: 'pending'
    };

    entry.followUps.push(followUp);

    postToPanel(previewPanel, {
      type: 'follow-up-pending',
      entryId,
      followUpId: followUp.id,
      prompt
    });

    const review = await getOllamaFollowUpReview(entry, prompt, outputChannel, followUp.id);
    followUp.review = review;
    followUp.status = 'done';

    renderPreviewPanel();
    postToPanel(previewPanel, {
      type: 'follow-up-final',
      entryId,
      followUpId: followUp.id,
      review,
      status: followUp.status
    });
  } catch (error) {
    const message = `[review-comments] follow-up failed: ${error.message}`;
    console.error(message);
    outputChannel.appendLine(message);
    const latestFollowUp = previewEntries.find(item => item.id === entryId)?.followUps.slice(-1)[0];
    if (latestFollowUp) {
      latestFollowUp.status = 'error';
    }
    renderPreviewPanel();
    postToPanel(previewPanel, {
      type: 'follow-up-final',
      entryId,
      followUpId: latestFollowUp?.id,
      review: message,
      status: 'error'
    });
  }
}

async function getOllamaReview(payload, outputChannel, ollamaSettings, panel, entryId) {
  if (typeof fetch !== 'function') {
    throw new Error('Fetch is not available in this VS Code runtime.');
  }

  const requestBody = buildOllamaRequestBody(payload, ollamaSettings.model);
  const request = createRequestSignal(REQUEST_TIMEOUT_MS);

  outputChannel.appendLine(`[review-comments] sending request to Ollama model ${ollamaSettings.model}`);

  try {
    const response = await fetch(ollamaSettings.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      signal: request.signal,
      body: JSON.stringify(requestBody)
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Ollama request failed (${response.status}): ${errorText}`);
    }

    return readOllamaStream(response, panel, entryId, 'review-chunk');
  } catch (error) {
    if (error.name === 'AbortError') {
      throw new Error(
        request.isTimeout()
          ? `Ollama request timed out after ${REQUEST_TIMEOUT_MS / 1000}s`
          : 'Ollama request cancelled'
      );
    }
    throw error;
  } finally {
    request.cleanup();
  }
}

async function getOllamaFollowUpReview(entry, prompt, outputChannel, followUpId) {
  if (typeof fetch !== 'function') {
    throw new Error('Fetch is not available in this VS Code runtime.');
  }

  const ollamaSettings = getOllamaSettings();
  const requestBody = buildFollowUpRequestBody(entry, prompt, ollamaSettings.model);
  const request = createRequestSignal(REQUEST_TIMEOUT_MS);

  outputChannel.appendLine(`[review-comments] sending follow-up request to Ollama model ${ollamaSettings.model}`);

  try {
    const response = await fetch(ollamaSettings.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      signal: request.signal,
      body: JSON.stringify(requestBody)
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Ollama request failed (${response.status}): ${errorText}`);
    }

    return readOllamaStream(response, previewPanel, entry.id, 'follow-up-chunk', followUpId);
  } catch (error) {
    if (error.name === 'AbortError') {
      throw new Error(
        request.isTimeout()
          ? `Ollama request timed out after ${REQUEST_TIMEOUT_MS / 1000}s`
          : 'Ollama request cancelled'
      );
    }
    throw error;
  } finally {
    request.cleanup();
  }
}

function buildOllamaRequestBody(payload, model) {
  return {
    model,
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
}

function buildFollowUpRequestBody(entry, prompt, model) {
  return {
    model,
    stream: true,
    messages: [
      {
        role: 'system',
        content: 'You are a concise code assistant. Continue the conversation from the previous answer and respond directly to the follow-up question.'
      },
      {
        role: 'user',
        content: [
          `Original question: ${entry.question}`,
          `Selected line: ${entry.lineNumber}: ${entry.lineText}`,
          `Previous answer: ${truncateForModel(entry.review, MAX_REVIEW_CONTEXT)}`,
          `Follow-up question: ${prompt}`,
          truncateForModel(JSON.stringify(entry.payload, null, 2), MAX_PAYLOAD_CONTEXT)
        ].join('\n\n')
      }
    ]
  };
}

async function readOllamaStream(response, panel, entryId, chunkType, followUpId) {
  if (!response.body || typeof response.body.getReader !== 'function') {
    const data = await response.json();
    return data?.message?.content ?? '';
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let review = '';
  let started = false;

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
      if (!started) {
        started = true;
        markStreaming(entryId, chunkType, followUpId);
      }
      if (!postToPanel(panel, {
        type: chunkType,
        id: entryId,
        followUpId,
        chunk
      })) {
        return review;
      }
    }
  }

  const trailing = buffer.trim();
  if (trailing) {
    const chunk = parseOllamaLine(trailing);
    if (chunk) {
      review += chunk;
      if (!started) {
        started = true;
        markStreaming(entryId, chunkType, followUpId);
      }
      if (!postToPanel(panel, {
        type: chunkType,
        id: entryId,
        followUpId,
        chunk
      })) {
        return review;
      }
    }
  }

  return review;
}

function markStreaming(entryId, chunkType, followUpId) {
  if (chunkType === 'review-chunk') {
    const entry = previewEntries.find(item => item.id === entryId);
    if (entry) {
      entry.status = 'streaming';
    }
    postToPanel(previewPanel, {
      type: 'review-streaming',
      id: entryId
    });
    return;
  }
  const entry = previewEntries.find(item => item.id === entryId);
  const followUp = entry?.followUps.find(followUp => followUp.id === followUpId);
  if (followUp) {
    followUp.status = 'streaming';
  }
  postToPanel(previewPanel, {
    type: 'follow-up-streaming',
    entryId,
    followUpId
  });
}

function parseOllamaLine(line) {
  try {
    const data = JSON.parse(line);
    return data?.message?.content ?? '';
  } catch {
    return '';
  }
}

function createRequestSignal(timeoutMs) {
  const controller = new AbortController();
  let didTimeout = false;
  activeRequests.add(controller);

  const timer = setTimeout(() => {
    didTimeout = true;
    controller.abort();
  }, timeoutMs);

  return {
    signal: controller.signal,
    isTimeout: () => didTimeout,
    cleanup() {
      clearTimeout(timer);
      activeRequests.delete(controller);
    }
  };
}

function abortActiveRequests() {
  for (const controller of activeRequests) {
    controller.abort();
  }
  activeRequests.clear();
}

function postToPanel(panel, message) {
  if (!panel || panel !== previewPanel || !panel.webview) {
    return false;
  }

  try {
    panel.webview.postMessage(message);
    return true;
  } catch {
    return false;
  }
}

function truncateForModel(text, maxChars) {
  if (typeof text !== 'string' || text.length <= maxChars) {
    return text;
  }

  return `${text.slice(0, maxChars)}\n...[truncated for model context]`;
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
  deactivate,
  buildOllamaRequestBody,
  buildFollowUpRequestBody,
  parseOllamaLine,
  collectContext,
  normalizeText,
  escapeHtml,
  truncateForModel
};
