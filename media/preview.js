// PReview webview. Renders entirely from data posted by the extension host:
//   host -> webview: init, entry (upsert), chunk, removed, provider
//   webview -> host: ready, follow-up, retry, ask-claude, cancel, copy,
//                    reveal, remove, clear, select-provider, webview-error
(function () {
  'use strict';

  // ------------------------------------------------------------ markdown

  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function inline(text) {
    const codeSpans = [];
    let html = escapeHtml(text).replace(/`([^`]+)`/g, (_, code) => {
      codeSpans.push(code);
      return '\u0000' + (codeSpans.length - 1) + '\u0000';
    });
    html = html
      .replace(/\*\*\[(high|medium|low)\]\*\*/gi, (_, level) => '<span class="sev ' + level.toLowerCase() + '">' + level + '</span>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*\w])\*([^*\s][^*]*)\*(?!\w)/g, '$1<em>$2</em>')
      .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2">$1</a>');
    return html.replace(/\u0000(\d+)\u0000/g, (_, index) => '<code>' + codeSpans[Number(index)] + '</code>');
  }

  function renderMarkdown(source) {
    const lines = String(source ?? '').replace(/\r\n/g, '\n').split('\n');
    const out = [];
    let paragraph = [];
    let list = null;
    let quote = [];
    let code = null;

    const flushParagraph = () => {
      if (paragraph.length) {
        out.push('<p>' + inline(paragraph.join(' ')) + '</p>');
        paragraph = [];
      }
    };
    const flushList = () => {
      if (list) {
        out.push('<' + list.type + '>' + list.items.map(item => '<li>' + inline(item) + '</li>').join('') + '</' + list.type + '>');
        list = null;
      }
    };
    const flushQuote = () => {
      if (quote.length) {
        out.push('<blockquote>' + inline(quote.join(' ')) + '</blockquote>');
        quote = [];
      }
    };
    const flushAll = () => {
      flushParagraph();
      flushList();
      flushQuote();
    };
    const flushCode = () => {
      const body = code.lines.join('\n');
      out.push(
        '<div class="codeblock"><div class="codeblock-head"><span>' + escapeHtml(code.lang || 'code') + '</span>' +
        '<button class="btn" data-action="copy-code" title="Copy code">' + ICONS.copy + 'Copy</button></div>' +
        '<pre><code>' + escapeHtml(body) + '</code></pre></div>'
      );
      code = null;
    };

    for (const line of lines) {
      if (code) {
        if (/^\s*```/.test(line)) {
          flushCode();
        } else {
          code.lines.push(line);
        }
        continue;
      }

      const fence = line.match(/^\s*```\s*([\w+#.-]*)/);
      const heading = line.match(/^(#{1,4})\s+(.+)$/);
      const bullet = line.match(/^\s*[-*+]\s+(.+)$/);
      const ordered = line.match(/^\s*\d+[.)]\s+(.+)$/);
      const blockquote = line.match(/^\s*>\s?(.*)$/);

      if (fence) {
        flushAll();
        code = { lang: fence[1], lines: [] };
      } else if (!line.trim()) {
        flushAll();
      } else if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
        flushAll();
        out.push('<hr>');
      } else if (heading) {
        flushAll();
        const level = Math.min(4, heading[1].length + 1);
        out.push('<h' + level + '>' + inline(heading[2]) + '</h' + level + '>');
      } else if (bullet || ordered) {
        flushParagraph();
        flushQuote();
        const type = bullet ? 'ul' : 'ol';
        if (list && list.type !== type) {
          flushList();
        }
        list = list || { type, items: [] };
        list.items.push((bullet || ordered)[1]);
      } else if (blockquote) {
        flushParagraph();
        flushList();
        quote.push(blockquote[1]);
      } else if (list && /^\s{2,}\S/.test(line)) {
        list.items[list.items.length - 1] += ' ' + line.trim();
      } else {
        flushList();
        flushQuote();
        paragraph.push(line.trim());
      }
    }

    if (code) {
      flushCode();
    }
    flushAll();
    return out.join('');
  }

  // ------------------------------------------------------------ icons

  const svg = path => '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + path + '</svg>';
  const ICONS = {
    copy: svg('<rect x="5" y="5" width="8.5" height="8.5" rx="1.5"/><path d="M10.5 5V3.5A1.5 1.5 0 0 0 9 2H3.5A1.5 1.5 0 0 0 2 3.5V9A1.5 1.5 0 0 0 3.5 10.5H5"/>'),
    check: svg('<path d="M3 8.5l3 3 7-7"/>'),
    retry: svg('<path d="M13 8a5 5 0 1 1-1.5-3.5"/><path d="M13 2.5v3h-3"/>'),
    stop: svg('<rect x="4" y="4" width="8" height="8" rx="1"/>'),
    close: svg('<path d="M4 4l8 8M12 4l-8 8"/>'),
    sparkle: svg('<path d="M8 2l1.4 3.6L13 7l-3.6 1.4L8 12l-1.4-3.6L3 7l3.6-1.4z"/>'),
    send: svg('<path d="M2.5 8h10M9 4.5L12.5 8 9 11.5"/>'),
    logo: svg('<path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z"/><path d="M5.5 6.5l1.5 1.5 3-3"/>')
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { renderMarkdown, escapeHtml };
    return;
  }

  // ------------------------------------------------------------ state

  const vscode = acquireVsCodeApi();
  const saved = vscode.getState() || {};
  const drafts = saved.drafts || {};
  const expanded = new Set(saved.expanded || []);
  const entries = new Map();
  let provider = { id: 'ollama', label: 'Ollama', model: '' };
  const pendingRender = new Set();

  function saveState() {
    vscode.setState({ drafts, expanded: [...expanded] });
  }

  window.addEventListener('error', event => {
    vscode.postMessage({ type: 'webview-error', message: String(event.message || event.error) });
  });

  // ------------------------------------------------------------ shell

  const app = document.getElementById('app');
  app.innerHTML =
    '<header class="topbar">' +
    '<div class="brand">' + ICONS.logo + '<span>PReview</span><span class="count" id="count">0</span></div>' +
    '<span class="spacer"></span>' +
    '<button class="provider-pill" data-action="select-provider" id="provider" title="Switch AI provider"></button>' +
    '<button class="btn danger" data-action="clear" id="clear-all" title="Dismiss all reviews">Clear</button>' +
    '</header>' +
    '<main id="entries"></main>';
  const list = document.getElementById('entries');

  function renderProvider() {
    const el = document.getElementById('provider');
    el.innerHTML =
      '<span class="dot ' + escapeHtml(provider.id) + '"></span><span>' + escapeHtml(provider.label) + '</span>' +
      '<span class="model">' + escapeHtml(provider.model) + '</span>';
  }

  function renderEmpty() {
    const count = entries.size;
    document.getElementById('count').textContent = String(count);
    document.getElementById('clear-all').hidden = count === 0;
    const empty = document.getElementById('empty');
    if (count === 0 && !empty) {
      list.innerHTML =
        '<section class="empty" id="empty"><h2>No reviews yet</h2>' +
        '<p>Ask about any line of code and the answer shows up here and in the editor.</p><ol>' +
        '<li>Click the <strong>+</strong> in the editor gutter, type a question (or leave it blank for a review), then press <strong>Send comment</strong>.</li>' +
        '<li>Or select code, right-click, and choose <strong>PReview: Review Selection</strong>.</li>' +
        '<li>Ask follow-ups below each answer, or reply in the editor thread.</li></ol></section>';
    } else if (count > 0 && empty) {
      empty.remove();
    }
  }

  // ------------------------------------------------------------ cards

  function rangeLabel(range) {
    return range.startLine === range.endLine ? ':' + range.startLine : ':' + range.startLine + '–' + range.endLine;
  }

  function ago(timestamp) {
    const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
    if (seconds < 45) return 'just now';
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return minutes + 'm ago';
    const hours = Math.round(minutes / 60);
    return hours < 24 ? hours + 'h ago' : Math.round(hours / 24) + 'd ago';
  }

  function duration(turn) {
    if (!turn.startedAt) return '';
    const end = turn.finishedAt || Date.now();
    const seconds = (end - turn.startedAt) / 1000;
    return seconds < 10 ? seconds.toFixed(1) + 's' : Math.round(seconds) + 's';
  }

  function tokens(count) {
    return count >= 1000 ? (count / 1000).toFixed(1) + 'k' : String(count);
  }

  function upsertEntry(entry) {
    entries.set(entry.id, entry);
    let card = document.getElementById('entry-' + entry.id);
    if (!card) {
      card = buildCard(entry);
      // Newest first.
      list.prepend(card);
    }
    renderHead(card, entry);
    renderThread(card, entry);
    updateComposer(card, entry);
    renderEmpty();
  }

  function buildCard(entry) {
    const card = document.createElement('article');
    card.className = 'card';
    card.id = 'entry-' + entry.id;
    card.dataset.entryId = entry.id;

    const hasContext = entry.context.some(line => !line.selected);
    const code = entry.context
      .map(line => '<div class="code-row ' + (line.selected ? 'sel' : 'ctx') + '"><span class="no">' + line.n + '</span><span class="tx">' + escapeHtml(line.text || ' ') + '</span></div>')
      .join('');

    card.innerHTML =
      '<header class="card-head"></header>' +
      '<section class="code' + (expanded.has(entry.id) ? ' expanded' : '') + '" aria-label="Code under review">' +
      '<div class="code-lines">' + code + '</div>' +
      (hasContext ? '<button class="code-toggle" data-action="toggle-context"></button>' : '') +
      '</section>' +
      '<section class="thread" aria-live="polite"></section>' +
      '<form class="composer"><textarea rows="1" aria-label="Follow-up question" placeholder="Ask a follow-up…"></textarea>' +
      '<button class="primary" type="submit" title="Send (Enter)">Send</button></form>' +
      '<div class="hint">Enter to send · Shift+Enter for a new line</div>';

    const textarea = card.querySelector('textarea');
    textarea.value = drafts[entry.id] || '';
    textarea.dataset.entryId = entry.id;
    autosize(textarea);
    updateToggle(card);
    return card;
  }

  function updateToggle(card) {
    const toggle = card.querySelector('.code-toggle');
    if (toggle) {
      toggle.textContent = card.querySelector('.code').classList.contains('expanded') ? 'Hide surrounding code' : 'Show surrounding code';
    }
  }

  function renderHead(card, entry) {
    const modeLabel = { review: 'Review', explain: 'Explain', ask: 'Ask' }[entry.mode] || 'Ask';
    card.querySelector('.card-head').innerHTML =
      '<span class="mode ' + escapeHtml(entry.mode) + '">' + modeLabel + '</span>' +
      '<button class="file-link" data-action="reveal" title="Go to code">' + escapeHtml(entry.file) +
      '<span class="lines">' + rangeLabel(entry.range) + '</span></button>' +
      '<span class="spacer"></span>' +
      '<span class="ago" data-ts="' + entry.createdAt + '">' + ago(entry.createdAt) + '</span>' +
      '<button class="btn danger" data-action="remove" title="Dismiss this review">' + ICONS.close + '</button>';
  }

  function renderThread(card, entry) {
    const thread = card.querySelector('.thread');
    thread.innerHTML = entry.turns.map((turn, index) => turnHtml(entry, turn, index === entry.turns.length - 1)).join('');
    entry.turns.forEach(turn => paintAnswer(entry.id, turn));
  }

  function turnHtml(entry, turn, isLast) {
    const busy = turn.status === 'pending' || turn.status === 'streaming';
    const by = turn.provider === 'anthropic' ? 'Claude' : 'Ollama';
    const statusText = { pending: 'Thinking', streaming: 'Writing', error: 'Failed', cancelled: 'Cancelled', done: '' }[turn.status] || '';
    const meta = [];
    if (turn.status === 'done' || turn.status === 'streaming') meta.push(duration(turn));
    if (turn.usage) meta.push(tokens(turn.usage.inputTokens) + ' in · ' + tokens(turn.usage.outputTokens) + ' out');

    const actions = [];
    if (busy) {
      actions.push('<button class="btn" data-action="cancel" title="Stop generating">' + ICONS.stop + 'Stop</button>');
    } else {
      if (turn.answer && turn.status === 'done') {
        actions.push('<button class="btn" data-action="copy" title="Copy answer as Markdown">' + ICONS.copy + 'Copy</button>');
      }
      if (isLast && turn.provider !== 'anthropic') {
        actions.push('<button class="btn claude" data-action="ask-claude" title="Re-run this question with Claude (uses API credits)">' + ICONS.sparkle + 'Ask Claude</button>');
      }
      if (isLast && turn.status !== 'done') {
        actions.push('<button class="btn" data-action="retry" title="Try again">' + ICONS.retry + 'Retry</button>');
      }
    }

    return (
      '<div class="turn" data-turn-id="' + escapeHtml(turn.id) + '">' +
      '<div class="prompt"><span class="who">You</span><span class="prompt-text">' + escapeHtml(turn.prompt) + '</span></div>' +
      '<div class="answer-head">' +
      '<span class="by"><span class="dot ' + escapeHtml(turn.provider) + '"></span>' + by + ' · ' + escapeHtml(turn.model) + '</span>' +
      (statusText ? '<span class="status ' + escapeHtml(turn.status) + '">' + statusText + '</span>' : '') +
      (meta.length ? '<span class="meta">' + escapeHtml(meta.join(' · ')) + '</span>' : '') +
      '<span class="actions">' + actions.join('') + '</span>' +
      '</div>' +
      '<div class="answer-body"></div>' +
      '</div>'
    );
  }

  function paintAnswer(entryId, turn) {
    const node = document.querySelector('#entry-' + CSS.escape(entryId) + ' [data-turn-id="' + CSS.escape(turn.id) + '"] .answer-body');
    if (!node) return;

    if (turn.status === 'pending' && !turn.answer) {
      node.innerHTML = '<div class="skeleton" aria-label="Waiting for the model"><span></span><span></span><span></span></div>';
      return;
    }
    if ((turn.status === 'error' || turn.status === 'cancelled') && !turn.answer) {
      node.innerHTML = '<div class="error-box">' + escapeHtml(turn.error || 'Failed.') + '</div>';
      return;
    }

    let html = '<div class="md' + (turn.status === 'streaming' ? ' streaming' : '') + '">' + renderMarkdown(turn.answer) + '</div>';
    if (turn.status === 'error' && turn.error) {
      html += '<div class="error-box">' + escapeHtml(turn.error) + '</div>';
    }
    node.innerHTML = html;
  }

  function updateComposer(card, entry) {
    const busy = entry.turns.some(turn => turn.status === 'pending' || turn.status === 'streaming');
    const textarea = card.querySelector('textarea');
    card.querySelector('.composer .primary').disabled = busy || !textarea.value.trim();
    textarea.placeholder = busy ? 'Wait for the answer, then ask a follow-up…' : 'Ask a follow-up…';
  }

  function autosize(textarea) {
    textarea.style.height = 'auto';
    textarea.style.height = Math.min(200, textarea.scrollHeight + 2) + 'px';
  }

  function scheduleRender(entryId, turnId) {
    const key = entryId + '|' + turnId;
    if (pendingRender.has(key)) return;
    pendingRender.add(key);
    requestAnimationFrame(() => {
      pendingRender.delete(key);
      const entry = entries.get(entryId);
      const turn = entry && entry.turns.find(item => item.id === turnId);
      if (turn) paintAnswer(entryId, turn);
    });
  }

  function removeEntry(entryId) {
    entries.delete(entryId);
    delete drafts[entryId];
    expanded.delete(entryId);
    saveState();
    document.getElementById('entry-' + entryId)?.remove();
    renderEmpty();
  }

  // ------------------------------------------------------------ events

  function context(target) {
    const card = target.closest('.card');
    const turnEl = target.closest('[data-turn-id]');
    return {
      card,
      entryId: card ? card.dataset.entryId : undefined,
      turnId: turnEl ? turnEl.dataset.turnId : undefined
    };
  }

  function flash(button) {
    const original = button.innerHTML;
    button.innerHTML = ICONS.check + 'Copied';
    button.classList.add('done');
    setTimeout(() => {
      button.innerHTML = original;
      button.classList.remove('done');
    }, 1400);
  }

  function sendFollowUp(card) {
    const textarea = card.querySelector('textarea');
    const entry = entries.get(card.dataset.entryId);
    const prompt = textarea.value.trim();
    if (!prompt || !entry || entry.turns.some(turn => turn.status === 'pending' || turn.status === 'streaming')) return;
    vscode.postMessage({ type: 'follow-up', entryId: entry.id, prompt });
    textarea.value = '';
    drafts[entry.id] = '';
    saveState();
    autosize(textarea);
    updateComposer(card, entry);
  }

  document.addEventListener('click', event => {
    const button = event.target.closest('[data-action]');
    if (!button) return;
    const { card, entryId, turnId } = context(button);
    const action = button.dataset.action;

    switch (action) {
      case 'toggle-context': {
        const section = card.querySelector('.code');
        section.classList.toggle('expanded');
        if (section.classList.contains('expanded')) expanded.add(entryId);
        else expanded.delete(entryId);
        saveState();
        updateToggle(card);
        return;
      }
      case 'copy-code': {
        const code = button.closest('.codeblock').querySelector('code').textContent;
        vscode.postMessage({ type: 'copy', text: code });
        flash(button);
        return;
      }
      case 'copy':
        vscode.postMessage({ type: 'copy', entryId, turnId });
        flash(button);
        return;
      case 'clear':
        vscode.postMessage({ type: 'clear' });
        return;
      case 'select-provider':
        vscode.postMessage({ type: 'select-provider' });
        return;
      default:
        vscode.postMessage({ type: action, entryId, turnId });
    }
  });

  document.addEventListener('submit', event => {
    event.preventDefault();
    const card = event.target.closest('.card');
    if (card) sendFollowUp(card);
  });

  document.addEventListener('keydown', event => {
    if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
    const textarea = event.target.closest('.composer textarea');
    if (!textarea) return;
    event.preventDefault();
    sendFollowUp(textarea.closest('.card'));
  });

  document.addEventListener('input', event => {
    const textarea = event.target.closest('.composer textarea');
    if (!textarea) return;
    drafts[textarea.dataset.entryId] = textarea.value;
    saveState();
    autosize(textarea);
    const card = textarea.closest('.card');
    const entry = entries.get(card.dataset.entryId);
    if (entry) updateComposer(card, entry);
  });

  window.addEventListener('message', event => {
    const message = event.data;
    if (!message || !message.type) return;

    switch (message.type) {
      case 'init':
        provider = message.provider || provider;
        renderProvider();
        entries.clear();
        list.innerHTML = '';
        [...(message.entries || [])].sort((a, b) => a.createdAt - b.createdAt).forEach(upsertEntry);
        renderEmpty();
        return;
      case 'provider':
        provider = message.provider || provider;
        renderProvider();
        return;
      case 'entry': {
        const isNew = !entries.has(message.entry.id);
        upsertEntry(message.entry);
        if (isNew) {
          document.getElementById('entry-' + message.entry.id)?.scrollIntoView({ block: 'start', behavior: 'smooth' });
        }
        return;
      }
      case 'chunk': {
        const entry = entries.get(message.entryId);
        const turn = entry && entry.turns.find(item => item.id === message.turnId);
        if (!turn) return;
        turn.answer += message.text;
        if (turn.status === 'pending') turn.status = 'streaming';
        scheduleRender(entry.id, turn.id);
        return;
      }
      case 'removed':
        removeEntry(message.entryId);
        return;
      default:
    }
  });

  // Keep relative timestamps and running timers fresh.
  setInterval(() => {
    document.querySelectorAll('.ago[data-ts]').forEach(node => {
      node.textContent = ago(Number(node.dataset.ts));
    });
    entries.forEach(entry => {
      const card = document.getElementById('entry-' + entry.id);
      entry.turns.forEach(turn => {
        if (turn.status !== 'streaming') return;
        const meta = card && card.querySelector('[data-turn-id="' + CSS.escape(turn.id) + '"] .meta');
        if (meta) meta.textContent = duration(turn);
      });
    });
  }, 1000);

  renderProvider();
  renderEmpty();
  vscode.postMessage({ type: 'ready' });
})();
