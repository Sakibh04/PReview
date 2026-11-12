'use strict';

const Module = require('node:module');

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'vscode') {
    return {};
  }
  return originalLoad.call(this, request, parent, isMain);
};

const test = require('node:test');
const assert = require('node:assert/strict');

const ext = require('../extension.js');
const providers = require('../lib/providers.js');
const { renderMarkdown } = require('../media/preview.js');

function makeDocument(lines) {
  return { lineCount: lines.length, lineAt: index => ({ text: lines[index] }) };
}

function makeEntry(overrides = {}) {
  return {
    mode: 'review',
    payload: {
      relativePath: 'src/app.js',
      languageId: 'javascript',
      range: { startLine: 2, endLine: 2 },
      context: { lines: [{ n: 1, text: 'const a = 1;', selected: false }, { n: 2, text: 'eval(a);', selected: true }] }
    },
    turns: [{ prompt: 'any bugs?', answer: '', status: 'pending' }],
    ...overrides
  };
}

// ------------------------------------------------------------ host helpers

test('normalizeText handles strings, MarkdownStrings and nullish values', () => {
  assert.equal(ext.normalizeText('plain'), 'plain');
  assert.equal(ext.normalizeText({ value: 'markdown' }), 'markdown');
  assert.equal(ext.normalizeText(42), '42');
  assert.equal(ext.normalizeText(null), '');
  assert.equal(ext.normalizeText(undefined), '');
});

// ------------------------------------------------------------ prompts

test('detectMode picks explain, review or ask from the comment', () => {
  assert.equal(providers.detectMode(''), 'review');
  assert.equal(providers.detectMode('explain this function'), 'explain');
  assert.equal(providers.detectMode('What does this do?'), 'explain');
  assert.equal(providers.detectMode('any bugs here?'), 'review');
  assert.equal(providers.detectMode('rename x to count'), 'ask');
});

test('collectContextLines marks selected lines and clamps to the document', () => {
  const lines = providers.collectContextLines(makeDocument(['a', 'b', 'c', 'd', 'e']), 2, 2, 1);
  assert.deepEqual(lines, [
    { n: 2, text: 'b', selected: false },
    { n: 3, text: 'c', selected: true },
    { n: 4, text: 'd', selected: false }
  ]);
  assert.equal(providers.collectContextLines(makeDocument(['a', 'b']), 0, 1, 100).length, 2);
});

test('buildMessages puts code context and mode instructions on the first user turn', () => {
  const { system, messages } = providers.buildMessages(makeEntry(), 0);
  assert.match(system, /PReview/);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].role, 'user');
  assert.match(messages[0].content, /File: src\/app\.js/);
  assert.match(messages[0].content, />\s+2 \| eval\(a\);/);
  assert.match(messages[0].content, /\*\*\[high\]\*\*/);
  assert.match(messages[0].content, /Comment: any bugs\?/);
});

test('buildMessages replays completed turns as an alternating conversation', () => {
  const entry = makeEntry({
    turns: [
      { prompt: 'any bugs?', answer: 'eval is unsafe', status: 'done' },
      { prompt: 'failed one', answer: '', status: 'error' },
      { prompt: 'how do I fix it?', answer: '', status: 'pending' }
    ]
  });
  const { messages } = providers.buildMessages(entry, 2);
  assert.deepEqual(messages.map(message => message.role), ['user', 'assistant', 'user']);
  assert.equal(messages[1].content, 'eval is unsafe');
  assert.equal(messages[2].content, 'how do I fix it?');
});

test('buildMessages keeps the code context when the first turn failed', () => {
  const entry = makeEntry({
    turns: [
      { prompt: 'any bugs?', answer: '', status: 'error' },
      { prompt: 'try again: is eval ok?', answer: '', status: 'pending' }
    ]
  });
  const { messages } = providers.buildMessages(entry, 1);
  assert.equal(messages.length, 1);
  assert.match(messages[0].content, /File: src\/app\.js/);
  assert.match(messages[0].content, /try again: is eval ok\?$/);
});

test('buildMessages truncates very long earlier answers', () => {
  const entry = makeEntry({
    turns: [
      { prompt: 'q', answer: 'r'.repeat(100000), status: 'done' },
      { prompt: 'why?', answer: '', status: 'pending' }
    ]
  });
  const { messages } = providers.buildMessages(entry, 1);
  assert.match(messages[1].content, /\[truncated for model context\]/);
  assert.ok(messages[1].content.length < 10000);
});

test('truncateForModel leaves short text alone', () => {
  assert.equal(providers.truncateForModel('short', 100), 'short');
});

// ------------------------------------------------------------ ollama

test('parseOllamaLine returns content, ignores junk, surfaces stream errors', () => {
  assert.equal(providers.parseOllamaLine(JSON.stringify({ message: { content: 'hi' } })), 'hi');
  assert.equal(providers.parseOllamaLine('not json'), '');
  assert.equal(providers.parseOllamaLine(JSON.stringify({ done: true })), '');
  assert.throws(() => providers.parseOllamaLine(JSON.stringify({ error: 'model crashed' })), /model crashed/);
});

test('buildOllamaRequestBody prepends the system prompt and streams', () => {
  const body = providers.buildOllamaRequestBody({ model: 'm', system: 'sys', messages: [{ role: 'user', content: 'u' }] });
  assert.equal(body.stream, true);
  assert.deepEqual(body.messages.map(message => message.role), ['system', 'user']);
});

test('formatOllamaError explains how to recover from a connection failure', () => {
  const message = providers.formatOllamaError(new Error('fetch failed'), 'http://127.0.0.1:11434/api/chat');
  assert.match(message, /Could not reach Ollama/);
  assert.match(message, /ollama serve/);
});

test('streamOllama checks the model, then streams NDJSON chunks split across reads', async t => {
  const encoder = new TextEncoder();
  const parts = ['{"message":{"content":"Hel"}}\n{"message":{"con', 'tent":"lo"}}\n{"done":true}'];
  t.mock.method(globalThis, 'fetch', async url => {
    if (String(url).endsWith('/api/tags')) {
      return { ok: true, json: async () => ({ models: [{ name: 'm' }] }) };
    }
    let index = 0;
    return {
      ok: true,
      body: { getReader: () => ({ read: async () => (index < parts.length ? { done: false, value: encoder.encode(parts[index++]) } : { done: true }) }) }
    };
  });

  const chunks = [];
  const result = await providers.streamOllama({
    url: 'http://127.0.0.1:11434/api/chat',
    model: 'm',
    system: 's',
    messages: [],
    onText: chunk => chunks.push(chunk)
  });
  assert.equal(result.text, 'Hello');
  assert.deepEqual(chunks, ['Hel', 'lo']);
});

test('streamOllama reports a missing model with the pull command', async t => {
  t.mock.method(globalThis, 'fetch', async () => ({ ok: true, json: async () => ({ models: [{ name: 'other' }] }) }));
  await assert.rejects(
    providers.streamOllama({ url: 'http://x/api/chat', model: 'm', system: '', messages: [], onText() {} }),
    /ollama pull m/
  );
});

// ------------------------------------------------------------ anthropic (no network)

function fakeClient(events, final) {
  const calls = [];
  return {
    calls,
    createClient: () => ({
      beta: {
        messages: {
          stream(params, options) {
            calls.push({ params, options });
            return {
              async *[Symbol.asyncIterator]() {
                yield* events;
              },
              finalMessage: async () => final
            };
          }
        }
      }
    })
  };
}

const textDelta = text => ({ type: 'content_block_delta', delta: { type: 'text_delta', text } });

test('buildAnthropicParams sets effort and opts into refusal fallbacks on supported models', () => {
  const params = providers.buildAnthropicParams({ model: 'claude-opus-5-5', effort: 'medium', system: 's', messages: [] });
  assert.equal(params.model, 'claude-opus-5-5');
  assert.deepEqual(params.output_config, { effort: 'medium' });
  assert.equal(params.fallbacks, 'default');
  assert.deepEqual(params.betas, ['server-side-fallback-2026-07-01']);
  assert.equal(params.thinking, undefined);

  const haiku = providers.buildAnthropicParams({ model: 'claude-haiku-5-5', effort: 'low', system: 's', messages: [] });
  assert.equal(haiku.fallbacks, undefined);
  assert.equal(haiku.betas, undefined);
});

test('streamAnthropic streams text deltas and reports usage', async () => {
  const fake = fakeClient(
    [{ type: 'message_start' }, textDelta('Looks '), { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'x' } }, textDelta('good.')],
    { stop_reason: 'end_turn', model: 'claude-opus-5-5', usage: { input_tokens: 1200, output_tokens: 40 } }
  );
  const chunks = [];
  const signal = new AbortController().signal;
  const result = await providers.streamAnthropic({
    apiKey: 'sk-ant-test',
    model: 'claude-opus-5-5',
    effort: 'medium',
    system: 'sys',
    messages: [{ role: 'user', content: 'hi' }],
    signal,
    onText: chunk => chunks.push(chunk),
    createClient: fake.createClient
  });

  assert.equal(result.text, 'Looks good.');
  assert.deepEqual(chunks, ['Looks ', 'good.']);
  assert.deepEqual(result.usage, { inputTokens: 1200, outputTokens: 40 });
  assert.equal(fake.calls[0].options.signal, signal);
  assert.equal(fake.calls[0].params.system, 'sys');
});

test('streamAnthropic turns an empty refusal into a readable error', async () => {
  const fake = fakeClient([], { stop_reason: 'refusal', stop_details: { category: 'cyber' }, usage: {} });
  await assert.rejects(
    providers.streamAnthropic({ apiKey: 'k', model: 'claude-opus-5-5', effort: 'low', system: '', messages: [], onText() {}, createClient: fake.createClient }),
    /declined this request \(cyber\)/
  );
});

test('streamAnthropic marks answers cut off by max_tokens', async () => {
  const fake = fakeClient([textDelta('partial')], { stop_reason: 'max_tokens', usage: {} });
  const result = await providers.streamAnthropic({ apiKey: 'k', model: 'm', effort: 'low', system: '', messages: [], onText() {}, createClient: fake.createClient });
  assert.match(result.text, /^partial[\s\S]*cut off/);
});

test('streamAnthropic rethrows aborts as AbortError', async () => {
  const controller = new AbortController();
  controller.abort();
  const createClient = () => ({ beta: { messages: { stream() { throw new Error('Request was aborted.'); } } } });
  await assert.rejects(
    providers.streamAnthropic({ apiKey: 'k', model: 'm', effort: 'low', system: '', messages: [], signal: controller.signal, onText() {}, createClient }),
    error => error.name === 'AbortError'
  );
});

test('formatAnthropicError maps SDK error classes to actionable messages', () => {
  const Anthropic = require('@anthropic-ai/sdk').default;
  const auth = new Anthropic.AuthenticationError(401, { type: 'error' }, 'invalid x-api-key', new Headers());
  assert.match(providers.formatAnthropicError(auth, Anthropic), /Set Claude API Key/);
  const rate = new Anthropic.RateLimitError(429, { type: 'error' }, 'slow down', new Headers());
  assert.match(providers.formatAnthropicError(rate, Anthropic), /rate limit/i);
});

// ------------------------------------------------------------ webview markdown

test('renderMarkdown escapes HTML from the model', () => {
  const html = renderMarkdown('<img src=x onerror=alert(1)> and `<b>`');
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /&lt;img/);
  assert.match(html, /<code>&lt;b&gt;<\/code>/);
});

test('renderMarkdown renders severity badges, lists and fenced code with a copy button', () => {
  const html = renderMarkdown('- **[high]** Line 2: `eval` runs arbitrary code\n- **[low]** naming\n\n```js\nconst x = "<y>";\n```');
  assert.match(html, /<ul><li><span class="sev high">high<\/span> Line 2: <code>eval<\/code>/);
  assert.match(html, /<span class="sev low">low<\/span>/);
  assert.match(html, /<div class="codeblock"><div class="codeblock-head"><span>js<\/span>/);
  assert.match(html, /data-action="copy-code"/);
  assert.match(html, /const x = &quot;&lt;y&gt;&quot;;/);
});

test('renderMarkdown closes an unterminated code fence while streaming', () => {
  const html = renderMarkdown('Fix:\n```python\nprint(1)');
  assert.match(html, /<pre><code>print\(1\)<\/code><\/pre>/);
});

test('renderMarkdown does not italicise multiplication or bullets', () => {
  assert.match(renderMarkdown('use a*b*c here'), /a\*b\*c/);
  assert.match(renderMarkdown('*emphasis* works'), /<em>emphasis<\/em>/);
});
