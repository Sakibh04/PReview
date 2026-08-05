'use strict';

const Module = require('node:module');

const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (request === 'vscode') {
    return {};
  }
  return originalLoad.call(this, request, parent, isMain);
};

const test = require('node:test');
const assert = require('node:assert/strict');

const ext = require('../extension.js');

function makeDocument(lines) {
  return {
    lineCount: lines.length,
    lineAt(index) {
      return { text: lines[index] };
    }
  };
}

test('parseOllamaLine returns message content', () => {
  const line = JSON.stringify({ message: { content: 'hello' } });
  assert.equal(ext.parseOllamaLine(line), 'hello');
});

test('parseOllamaLine returns empty string for non-JSON', () => {
  assert.equal(ext.parseOllamaLine('not json'), '');
});

test('parseOllamaLine returns empty string when no message content', () => {
  assert.equal(ext.parseOllamaLine(JSON.stringify({ done: true })), '');
});

test('escapeHtml escapes all special characters', () => {
  assert.equal(ext.escapeHtml(`<a>"x"&'y'</a>`), '&lt;a&gt;&quot;x&quot;&amp;&#39;y&#39;&lt;/a&gt;');
});

test('normalizeText handles plain strings', () => {
  assert.equal(ext.normalizeText('plain'), 'plain');
});

test('normalizeText unwraps MarkdownString value objects', () => {
  assert.equal(ext.normalizeText({ value: 'markdown' }), 'markdown');
});

test('normalizeText stringifies other values and empties nullish', () => {
  assert.equal(ext.normalizeText(42), '42');
  assert.equal(ext.normalizeText(null), '');
  assert.equal(ext.normalizeText(undefined), '');
});

test('buildOllamaRequestBody uses model, streams, and adds review instructions', () => {
  const body = ext.buildOllamaRequestBody({ commentText: 'check for bugs', code: 'x' }, 'qwen2.5-coder:7b');
  assert.equal(body.model, 'qwen2.5-coder:7b');
  assert.equal(body.stream, true);
  assert.equal(body.messages[0].role, 'system');
  assert.equal(body.messages[1].role, 'user');
  assert.match(body.messages[1].content, /check for bugs/);
  assert.match(body.messages[1].content, /If you find issues/);
});

test('buildOllamaRequestBody switches to explanation for explain prompts', () => {
  const body = ext.buildOllamaRequestBody({ commentText: 'explain this function', code: 'x' }, 'm');
  assert.match(body.messages[1].content, /Explain what the selected function does/);
});

test('buildFollowUpRequestBody truncates long previous answers', () => {
  const entry = {
    question: 'q',
    lineNumber: 3,
    lineText: 'x',
    review: 'r'.repeat(100000),
    payload: { code: 'x' }
  };
  const body = ext.buildFollowUpRequestBody(entry, 'why?', 'm');
  assert.match(body.messages[1].content, /\[truncated for model context\]/);
  assert.match(body.messages[1].content, /why\?/);
});

test('collectContext partitions before/selected/after with 1-based line numbers', () => {
  const document = makeDocument(['a', 'b', 'c', 'd', 'e']);
  const range = { start: { line: 2, character: 0 }, end: { line: 2, character: 1 } };
  const context = ext.collectContext(document, range, 10);
  assert.deepEqual(context.before, ['1: a', '2: b']);
  assert.deepEqual(context.selected, ['3: c']);
  assert.deepEqual(context.after, ['4: d', '5: e']);
});

test('collectContext clamps radius to document bounds', () => {
  const document = makeDocument(['a', 'b', 'c']);
  const range = { start: { line: 1, character: 0 }, end: { line: 1, character: 1 } };
  const context = ext.collectContext(document, range, 100);
  assert.deepEqual(context.before, ['1: a']);
  assert.deepEqual(context.selected, ['2: b']);
  assert.deepEqual(context.after, ['3: c']);
});

test('truncateForModel returns short text unchanged', () => {
  assert.equal(ext.truncateForModel('short', 100), 'short');
});

test('truncateForModel annotates truncated text', () => {
  const result = ext.truncateForModel('x'.repeat(200), 100);
  assert.match(result, /\[truncated for model context\]/);
  assert.ok(result.length < 200);
});
