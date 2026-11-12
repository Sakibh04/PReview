'use strict';

const crypto = require('node:crypto');
const vscode = require('vscode');
const providers = require('./lib/providers');

const CONTROLLER_ID = 'reviewComments';
const CONTROLLER_LABEL = 'PReview';
const SECRET_ANTHROPIC_KEY = 'reviewComments.anthropicApiKey';
const REQUEST_TIMEOUT_MS = 180000;
const AI_AUTHOR = 'PReview';

/** @type {{ context: vscode.ExtensionContext, output: vscode.OutputChannel, controller: vscode.CommentController, statusBar: vscode.StatusBarItem } | undefined} */
let host;
let panel;
let entries = [];
const threadToEntry = new WeakMap();
const activeRequests = new Map();

function log(message) {
  host?.output.appendLine(`[review-comments] ${message}`);
}

// ------------------------------------------------------------------ activate

function activate(context) {
  const output = vscode.window.createOutputChannel('PReview');
  const controller = vscode.comments.createCommentController(CONTROLLER_ID, CONTROLLER_LABEL);
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  host = { context, output, controller, statusBar };

  controller.options = {
    prompt: 'Ask PReview about this code…',
    placeHolder: 'e.g. "any bugs here?", "explain this", "make this async". Leave empty for a general review.'
  };
  controller.commentingRangeProvider = {
    provideCommentingRanges(document) {
      if (document.lineCount === 0 || document.uri.scheme === 'comment') {
        return [];
      }
      const end = document.lineCount - 1;
      return [new vscode.Range(0, 0, end, document.lineAt(end).range.end.character)];
    }
  };

  statusBar.command = 'reviewComments.selectProvider';
  updateStatusBar();
  statusBar.show();

  context.subscriptions.push(
    output,
    controller,
    statusBar,
    vscode.commands.registerCommand('reviewComments.submitComment', reply => submitFromThread(reply)),
    vscode.commands.registerCommand('reviewComments.reviewSelection', () => submitFromSelection('review')),
    vscode.commands.registerCommand('reviewComments.explainSelection', () => submitFromSelection('explain')),
    vscode.commands.registerCommand('reviewComments.showPanel', () => showPanel(true)),
    vscode.commands.registerCommand('reviewComments.selectProvider', selectProvider),
    vscode.commands.registerCommand('reviewComments.setAnthropicKey', () => promptForAnthropicKey()),
    vscode.commands.registerCommand('reviewComments.clearAnthropicKey', async () => {
      await context.secrets.delete(SECRET_ANTHROPIC_KEY);
      vscode.window.showInformationMessage('PReview: Claude API key removed.');
    }),
    vscode.commands.registerCommand('reviewComments.deleteThread', thread => removeThread(thread)),
    vscode.workspace.onDidChangeConfiguration(event => {
      if (event.affectsConfiguration('reviewComments')) {
        updateStatusBar();
        postProviderInfo();
      }
    })
  );

  return { controller };
}

function deactivate() {
  for (const controller of activeRequests.values()) {
    controller.abort();
  }
  activeRequests.clear();
}

// ------------------------------------------------------------------ settings

function getSettings() {
  const config = vscode.workspace.getConfiguration('reviewComments');
  return {
    provider: config.get('provider', 'ollama') === 'anthropic' ? 'anthropic' : 'ollama',
    ollamaUrl: config.get('ollamaUrl', providers.OLLAMA_URL),
    ollamaModel: config.get('ollamaModel', providers.OLLAMA_MODEL),
    anthropicModel: config.get('anthropicModel', providers.ANTHROPIC_MODEL),
    anthropicEffort: config.get('anthropicEffort', providers.ANTHROPIC_EFFORT),
    contextLines: Math.max(0, Math.min(200, Number(config.get('contextLines', 15)) || 0)),
    replyInThread: config.get('replyInThread', true)
  };
}

function providerInfo(settings = getSettings()) {
  return settings.provider === 'anthropic'
    ? { id: 'anthropic', label: 'Claude', model: settings.anthropicModel }
    : { id: 'ollama', label: 'Ollama', model: settings.ollamaModel };
}

function updateStatusBar() {
  if (!host) {
    return;
  }
  const running = activeRequests.size;
  const info = providerInfo();
  host.statusBar.text = running
    ? `$(sync~spin) PReview: ${info.label}`
    : `$(comment-discussion) PReview: ${info.label}`;
  host.statusBar.tooltip = `PReview is using ${info.label} (${info.model}). Click to switch provider.`;
}

async function selectProvider() {
  const settings = getSettings();
  const picked = await vscode.window.showQuickPick(
    [
      {
        label: '$(server) Ollama',
        description: settings.ollamaModel,
        detail: 'Runs locally. Free, private, needs `ollama serve`.',
        id: 'ollama'
      },
      {
        label: '$(sparkle) Claude',
        description: settings.anthropicModel,
        detail: 'Anthropic API. Stronger reviews, uses your API credits.',
        id: 'anthropic'
      }
    ],
    { title: 'PReview: default AI provider', placeHolder: `Currently: ${providerInfo(settings).label}` }
  );
  if (!picked) {
    return;
  }
  if (picked.id === 'anthropic' && !(await getAnthropicKey({ prompt: true }))) {
    return;
  }
  await vscode.workspace.getConfiguration('reviewComments').update('provider', picked.id, vscode.ConfigurationTarget.Global);
}

async function getAnthropicKey({ prompt }) {
  const stored = await host.context.secrets.get(SECRET_ANTHROPIC_KEY);
  if (stored) {
    return stored;
  }
  if (process.env.ANTHROPIC_API_KEY) {
    return process.env.ANTHROPIC_API_KEY;
  }
  return prompt ? promptForAnthropicKey() : undefined;
}

async function promptForAnthropicKey() {
  const key = await vscode.window.showInputBox({
    title: 'PReview: Claude API key',
    prompt: 'Stored in VS Code Secret Storage, never in settings. Create one at console.anthropic.com.',
    placeHolder: 'sk-ant-…',
    password: true,
    ignoreFocusOut: true,
    validateInput: value => (value.trim().startsWith('sk-ant-') ? undefined : 'Claude API keys start with "sk-ant-"')
  });
  if (!key) {
    return undefined;
  }
  await host.context.secrets.store(SECRET_ANTHROPIC_KEY, key.trim());
  vscode.window.showInformationMessage('PReview: Claude API key saved.');
  return key.trim();
}

// ------------------------------------------------------------------ submit

async function submitFromThread(reply) {
  try {
    const thread = reply?.thread ?? reply;
    const text = normalizeText(reply?.text).trim();

    if (!thread?.uri || !thread?.range) {
      vscode.window.showWarningMessage('PReview: open a comment thread first.');
      return;
    }

    const existing = entries.find(entry => entry.id === threadToEntry.get(thread));
    if (existing) {
      if (!text) {
        vscode.window.showInformationMessage('PReview: type a follow-up in the reply box first.');
        return;
      }
      await askFollowUp(existing, text);
      return;
    }

    await startEntry(thread, text, providers.detectMode(text));
  } catch (error) {
    log(`submit failed: ${error.stack || error.message}`);
    vscode.window.showErrorMessage(`PReview: ${error.message}`);
  }
}

async function submitFromSelection(mode) {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showWarningMessage('PReview: open a file and select some code first.');
    return;
  }
  const selection = editor.selection;
  const range = new vscode.Range(selection.start.line, 0, selection.end.line, editor.document.lineAt(selection.end.line).range.end.character);
  const thread = host.controller.createCommentThread(editor.document.uri, range, []);
  thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
  await startEntry(thread, '', mode);
}

async function startEntry(thread, commentText, mode) {
  const document = await vscode.workspace.openTextDocument(thread.uri);
  const settings = getSettings();
  const payload = buildPayload(document, thread.range, settings.contextLines);

  const entry = {
    id: crypto.randomUUID(),
    mode,
    createdAt: Date.now(),
    payload,
    uri: thread.uri.toString(),
    thread,
    hasUserComment: Boolean(commentText),
    turns: []
  };
  entry.turns.push(createTurn(commentText || providers.defaultQuestion(mode)));

  entries.push(entry);
  threadToEntry.set(thread, entry.id);
  thread.label = 'PReview';
  thread.canReply = true;
  thread.contextValue = 'preview-thread';

  showPanel(false);
  await runTurn(entry, entry.turns[0]);
}

function buildPayload(document, range, contextLines) {
  const startLine = range.start.line;
  const endLine = Math.max(startLine, range.end.line);
  const lines = providers.collectContextLines(document, startLine, endLine, contextLines);
  return {
    relativePath: vscode.workspace.asRelativePath(document.uri, false),
    languageId: document.languageId,
    range: { startLine: startLine + 1, endLine: endLine + 1 },
    context: { lines }
  };
}

function createTurn(prompt) {
  return { id: crypto.randomUUID(), prompt, answer: '', status: 'pending', error: '', provider: '', model: '', startedAt: 0, finishedAt: 0, usage: null };
}

async function askFollowUp(entry, prompt) {
  if (entry.turns.some(turn => isBusy(turn))) {
    vscode.window.showInformationMessage('PReview: wait for the current answer to finish.');
    return;
  }
  const turn = createTurn(prompt);
  entry.turns.push(turn);
  showPanel(false);
  await runTurn(entry, turn);
}

function isBusy(turn) {
  return turn.status === 'pending' || turn.status === 'streaming';
}

// ------------------------------------------------------------------ run

async function runTurn(entry, turn, providerOverride) {
  const settings = getSettings();
  const provider = providerOverride || settings.provider;
  const turnIndex = entry.turns.indexOf(turn);
  const requestKey = `${entry.id}:${turn.id}`;

  Object.assign(turn, {
    answer: '',
    error: '',
    status: 'pending',
    provider,
    model: provider === 'anthropic' ? settings.anthropicModel : settings.ollamaModel,
    startedAt: Date.now(),
    finishedAt: 0,
    usage: null
  });
  postEntry(entry);
  syncThread(entry);

  const abort = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    abort.abort();
  }, REQUEST_TIMEOUT_MS);
  activeRequests.set(requestKey, abort);
  updateStatusBar();

  const onText = text => {
    if (turn.status === 'pending') {
      turn.status = 'streaming';
      postEntry(entry);
    }
    turn.answer += text;
    post({ type: 'chunk', entryId: entry.id, turnId: turn.id, text });
  };

  try {
    const { system, messages } = providers.buildMessages(entry, turnIndex);
    log(`${provider} request (${turn.model}) for ${entry.payload.relativePath}:${entry.payload.range.startLine}`);

    let result;
    if (provider === 'anthropic') {
      const apiKey = await getAnthropicKey({ prompt: true });
      if (!apiKey) {
        throw new Error('No Claude API key set. Run "PReview: Set Claude API Key".');
      }
      result = await providers.streamAnthropic({
        apiKey,
        model: settings.anthropicModel,
        effort: settings.anthropicEffort,
        system,
        messages,
        signal: abort.signal,
        onText
      });
    } else {
      result = await providers.streamOllama({
        url: settings.ollamaUrl,
        model: settings.ollamaModel,
        system,
        messages,
        signal: abort.signal,
        onText
      });
    }

    turn.answer = result.text;
    turn.model = result.model || turn.model;
    turn.usage = result.usage || null;
    turn.status = result.text.trim() ? 'done' : 'error';
    turn.error = result.text.trim() ? '' : 'The model returned an empty answer.';
  } catch (error) {
    turn.status = 'error';
    if (error?.name === 'AbortError') {
      turn.error = timedOut ? `Timed out after ${REQUEST_TIMEOUT_MS / 1000}s.` : 'Cancelled.';
      turn.status = timedOut ? 'error' : 'cancelled';
    } else {
      turn.error = error.message;
    }
    log(`${provider} request failed: ${turn.error}`);
  } finally {
    clearTimeout(timer);
    activeRequests.delete(requestKey);
    turn.finishedAt = Date.now();
    updateStatusBar();
  }

  postEntry(entry);
  syncThread(entry);
}

// ------------------------------------------------------------------ comment thread

function syncThread(entry) {
  const thread = entry.thread;
  if (!thread || !getSettings().replyInThread) {
    return;
  }

  const comments = [];
  entry.turns.forEach((turn, index) => {
    if (index > 0 || entry.hasUserComment) {
      comments.push({
        body: new vscode.MarkdownString(turn.prompt),
        mode: vscode.CommentMode.Preview,
        author: { name: 'You' },
        contextValue: 'preview-user'
      });
    }

    let body;
    if (isBusy(turn)) {
      body = '$(loading~spin) _Thinking… the answer streams into the PReview panel._';
    } else if (turn.status === 'done') {
      body = turn.answer;
    } else {
      body = `$(error) ${turn.error || 'Failed.'}`;
    }
    const markdown = new vscode.MarkdownString(body, true);
    comments.push({
      body: markdown,
      mode: vscode.CommentMode.Preview,
      author: { name: `${AI_AUTHOR} · ${turn.provider === 'anthropic' ? 'Claude' : 'Ollama'}` },
      label: turn.model,
      contextValue: 'preview-ai'
    });
  });

  try {
    thread.comments = comments;
    thread.state = vscode.CommentThreadState?.Unresolved ?? thread.state;
  } catch (error) {
    log(`could not update comment thread: ${error.message}`);
  }
}

function removeThread(thread) {
  const entryId = thread && threadToEntry.get(thread);
  if (entryId) {
    removeEntry(entryId);
  } else {
    thread?.dispose?.();
  }
}

function removeEntry(entryId) {
  const entry = entries.find(item => item.id === entryId);
  if (!entry) {
    return;
  }
  for (const turn of entry.turns) {
    activeRequests.get(`${entry.id}:${turn.id}`)?.abort();
  }
  entries = entries.filter(item => item !== entry);
  try {
    entry.thread?.dispose();
  } catch {
    // Thread may already be disposed.
  }
  post({ type: 'removed', entryId });
}

// ------------------------------------------------------------------ webview

function showPanel(focus) {
  if (panel) {
    if (focus) {
      panel.reveal(vscode.ViewColumn.Beside);
    } else if (!panel.visible) {
      panel.reveal(vscode.ViewColumn.Beside, true);
    }
    return panel;
  }

  const mediaRoot = vscode.Uri.joinPath(host.context.extensionUri, 'media');
  panel = vscode.window.createWebviewPanel(
    'reviewCommentsPreview',
    'PReview',
    { viewColumn: vscode.ViewColumn.Beside, preserveFocus: !focus },
    { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [mediaRoot] }
  );
  panel.iconPath = vscode.Uri.joinPath(mediaRoot, 'icon.svg');
  panel.webview.html = renderShell(panel.webview, mediaRoot);
  panel.webview.onDidReceiveMessage(message => handleWebviewMessage(message).catch(error => {
    log(`webview message failed: ${error.stack || error.message}`);
  }));
  panel.onDidDispose(() => {
    // Entries (and in-flight requests) outlive the panel; their answers still
    // land in the comment threads and reappear when the panel is reopened.
    panel = undefined;
  });
  return panel;
}

function renderShell(webview, mediaRoot) {
  const nonce = crypto.randomBytes(16).toString('base64');
  const css = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'preview.css'));
  const js = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'preview.js'));
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource}; font-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
  <link rel="stylesheet" href="${css}">
  <title>PReview</title>
</head>
<body>
  <div id="app"></div>
  <script nonce="${nonce}" src="${js}"></script>
</body>
</html>`;
}

function post(message) {
  if (!panel) {
    return false;
  }
  try {
    panel.webview.postMessage(message);
    return true;
  } catch {
    return false;
  }
}

function postEntry(entry) {
  post({ type: 'entry', entry: toView(entry) });
}

function postProviderInfo() {
  post({ type: 'provider', provider: providerInfo() });
}

function toView(entry) {
  return {
    id: entry.id,
    mode: entry.mode,
    createdAt: entry.createdAt,
    file: entry.payload.relativePath,
    languageId: entry.payload.languageId,
    range: entry.payload.range,
    context: entry.payload.context.lines,
    turns: entry.turns.map(turn => ({
      id: turn.id,
      prompt: turn.prompt,
      answer: turn.answer,
      status: turn.status,
      error: turn.error,
      provider: turn.provider,
      model: turn.model,
      startedAt: turn.startedAt,
      finishedAt: turn.finishedAt,
      usage: turn.usage
    }))
  };
}

async function handleWebviewMessage(message) {
  if (!message?.type) {
    return;
  }
  const entry = message.entryId ? entries.find(item => item.id === message.entryId) : undefined;
  const turn = entry && message.turnId ? entry.turns.find(item => item.id === message.turnId) : undefined;

  switch (message.type) {
    case 'ready':
      post({ type: 'init', provider: providerInfo(), entries: entries.map(toView) });
      return;
    case 'webview-error':
      log(`webview error: ${message.message}`);
      return;
    case 'follow-up':
      if (entry && typeof message.prompt === 'string' && message.prompt.trim()) {
        await askFollowUp(entry, message.prompt.trim());
      }
      return;
    case 'retry':
    case 'ask-claude':
      if (entry && turn && !isBusy(turn)) {
        if (message.type === 'ask-claude' && !(await getAnthropicKey({ prompt: true }))) {
          return;
        }
        await runTurn(entry, turn, message.type === 'ask-claude' ? 'anthropic' : undefined);
      }
      return;
    case 'cancel':
      if (entry && turn) {
        activeRequests.get(`${entry.id}:${turn.id}`)?.abort();
      }
      return;
    case 'copy':
      if (typeof message.text === 'string' && message.text) {
        await vscode.env.clipboard.writeText(message.text);
      } else if (turn?.answer) {
        await vscode.env.clipboard.writeText(turn.answer);
      }
      return;
    case 'reveal':
      if (entry) {
        await revealEntry(entry);
      }
      return;
    case 'remove':
      if (entry) {
        removeEntry(entry.id);
      }
      return;
    case 'clear':
      for (const item of [...entries]) {
        removeEntry(item.id);
      }
      return;
    case 'select-provider':
      await selectProvider();
      return;
    default:
  }
}

async function revealEntry(entry) {
  const document = await vscode.workspace.openTextDocument(vscode.Uri.parse(entry.uri));
  const editor = await vscode.window.showTextDocument(document, { viewColumn: vscode.ViewColumn.One, preserveFocus: false });
  const start = entry.payload.range.startLine - 1;
  const end = Math.min(document.lineCount - 1, entry.payload.range.endLine - 1);
  const range = new vscode.Range(start, 0, end, document.lineAt(end).range.end.character);
  editor.selection = new vscode.Selection(range.start, range.end);
  editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
}

// ------------------------------------------------------------------ helpers

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

module.exports = {
  activate,
  deactivate,
  normalizeText
};
