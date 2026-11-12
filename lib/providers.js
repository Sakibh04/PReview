'use strict';

// Model providers and prompt building. Pure Node: no `vscode` import, so the
// whole module is unit-testable.

const OLLAMA_URL = 'http://127.0.0.1:11434/api/chat';
const OLLAMA_MODEL = 'qwen2.5-coder:7b';
const ANTHROPIC_MODEL = 'claude-opus-5-5';
const ANTHROPIC_EFFORT = 'medium';
const ANTHROPIC_MAX_TOKENS = 64000;
const MAX_CODE_CONTEXT = 12000;
const MAX_PRIOR_ANSWER = 6000;

// Models that accept the server-side refusal fallback (`fallbacks: "default"`).
const FALLBACK_MODELS = new Set([
  'claude-fable-5-2',
  'claude-fable-5-1',
  'claude-opus-5-5',
  'claude-opus-5',
  'claude-sonnet-5-5'
]);

const SYSTEM_PROMPT = [
  'You are PReview, a senior engineer doing code review inside VS Code.',
  'The user anchored a comment to specific lines of a file. Treat their comment as the task.',
  'Be direct and specific: reference line numbers, quote the exact code you mean, and keep answers short.',
  'Use Markdown. Put code in fenced blocks with a language tag. Do not restate the code back unless you are changing it.'
].join(' ');

const MODE_INSTRUCTIONS = {
  review: [
    'Review the selected lines (use the surrounding lines only as context).',
    'List only real problems, most important first. Start each finding with a severity tag in bold, exactly one of **[high]**, **[medium]** or **[low]**, then the line number, the problem, and a concrete fix.',
    'If a fix is non-trivial, add a short fenced code block with the corrected code.',
    'If there are no meaningful problems, say so in one sentence. Do not pad with style nits.'
  ].join('\n'),
  explain: [
    'Explain what the selected code does, in plain language.',
    'Start with a one-sentence summary, then walk through it step by step. Mention any non-obvious behaviour, edge cases or side effects.'
  ].join('\n'),
  ask: 'Answer the comment directly, using the selected code and its context. If the comment asks for a change, show the changed code in a fenced block.'
};

function detectMode(commentText) {
  const text = String(commentText || '').trim();
  if (!text) {
    return 'review';
  }
  if (/\b(explain|what does|what is|how does|walk me through|why does)\b/i.test(text)) {
    return 'explain';
  }
  if (/\b(review|bugs?|issues?|problems?|wrong|improve|check|security|smell|refactor)\b/i.test(text)) {
    return 'review';
  }
  return 'ask';
}

function defaultQuestion(mode) {
  return mode === 'explain' ? 'Explain this code.' : 'Review this code.';
}

function truncateForModel(text, maxChars) {
  if (typeof text !== 'string' || text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, maxChars)}\n...[truncated for model context]`;
}

/** Zero-based start/end lines in; 1-based numbered lines out. */
function collectContextLines(document, startLine, endLine, radius) {
  const from = Math.max(0, startLine - radius);
  const to = Math.min(document.lineCount - 1, endLine + radius);
  const lines = [];
  for (let line = from; line <= to; line += 1) {
    lines.push({ n: line + 1, text: document.lineAt(line).text, selected: line >= startLine && line <= endLine });
  }
  return lines;
}

function formatContextBlock(payload) {
  const lines = payload.context?.lines ?? [];
  const numbered = lines
    .map(line => `${line.selected ? '>' : ' '} ${String(line.n).padStart(4)} | ${line.text}`)
    .join('\n');
  const { startLine, endLine } = payload.range ?? {};
  const where = startLine === endLine ? `line ${startLine}` : `lines ${startLine}-${endLine}`;

  return [
    `File: ${payload.relativePath} (${payload.languageId || 'plain text'})`,
    `Selected: ${where} (marked with ">")`,
    '```' + (payload.languageId || ''),
    truncateForModel(numbered, MAX_CODE_CONTEXT),
    '```'
  ].join('\n');
}

/**
 * Builds the chat transcript for a turn. Only completed earlier turns are
 * replayed so user/assistant roles always alternate; the code context rides on
 * the first user message.
 */
function buildMessages(entry, turnIndex) {
  const turns = entry.turns ?? [];
  const history = turns.slice(0, turnIndex).filter(turn => turn.status === 'done' && turn.answer);
  const current = turns[turnIndex];
  const exchanges = [...history.map(turn => ({ turn, answer: turn.answer })), { turn: current, answer: null }];

  const messages = [];
  exchanges.forEach(({ turn, answer }, index) => {
    const isInitial = turn === turns[0];
    const task = isInitial
      ? `${MODE_INSTRUCTIONS[entry.mode] ?? MODE_INSTRUCTIONS.ask}\n\nComment: ${turn.prompt}`
      : turn.prompt;
    const content = index === 0 ? `${formatContextBlock(entry.payload)}\n\n${task}` : task;
    messages.push({ role: 'user', content });
    if (answer !== null) {
      messages.push({ role: 'assistant', content: truncateForModel(answer, MAX_PRIOR_ANSWER) });
    }
  });

  return { system: SYSTEM_PROMPT, messages };
}

// ---------------------------------------------------------------- Ollama

function parseOllamaLine(line) {
  try {
    const data = JSON.parse(line);
    if (data?.error) {
      throw new OllamaStreamError(String(data.error));
    }
    return data?.message?.content ?? '';
  } catch (error) {
    if (error instanceof OllamaStreamError) {
      throw error;
    }
    return '';
  }
}

class OllamaStreamError extends Error {}

function buildOllamaRequestBody({ model, system, messages }) {
  return {
    model,
    stream: true,
    messages: [{ role: 'system', content: system }, ...messages]
  };
}

function getOllamaHealthUrl(url) {
  try {
    const parsed = new URL(url);
    parsed.pathname = parsed.pathname.replace(/\/api\/chat\/?$/, '/api/tags');
    return parsed.toString();
  } catch {
    return url;
  }
}

function formatOllamaError(error, url) {
  const message = error?.message || String(error);
  if (/fetch failed|failed to fetch|networkerror|connection refused|ECONNREFUSED/i.test(message)) {
    return `Could not reach Ollama at ${url}. Start it with \`ollama serve\`, or check the reviewComments.ollamaUrl setting.`;
  }
  return message;
}

async function checkOllama({ url, model, signal }) {
  const response = await fetch(getOllamaHealthUrl(url), { method: 'GET', signal });
  if (!response.ok) {
    throw new Error(`Ollama health check failed (${response.status})`);
  }
  const data = await response.json();
  const models = Array.isArray(data?.models) ? data.models.map(item => item?.name).filter(Boolean) : [];
  if (models.length > 0 && !models.includes(model)) {
    throw new Error(`Ollama model "${model}" is not installed. Run \`ollama pull ${model}\`, or pick another model in settings.`);
  }
}

async function streamOllama({ url, model, system, messages, signal, onText }) {
  if (typeof fetch !== 'function') {
    throw new Error('fetch is not available in this VS Code runtime.');
  }

  try {
    await checkOllama({ url, model, signal });
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal,
      body: JSON.stringify(buildOllamaRequestBody({ model, system, messages }))
    });

    if (!response.ok) {
      throw new Error(`Ollama request failed (${response.status}): ${await response.text()}`);
    }

    const text = await readNdjson(response, onText);
    return { text, model };
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw error;
    }
    throw new Error(formatOllamaError(error, url));
  }
}

async function readNdjson(response, onText) {
  if (!response.body || typeof response.body.getReader !== 'function') {
    const data = await response.json();
    const text = data?.message?.content ?? '';
    if (text) {
      onText(text);
    }
    return text;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let text = '';

  const consume = line => {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }
    const chunk = parseOllamaLine(trimmed);
    if (chunk) {
      text += chunk;
      onText(chunk);
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    let newline = buffer.indexOf('\n');
    while (newline !== -1) {
      consume(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf('\n');
    }
  }
  consume(buffer);
  return text;
}

// ---------------------------------------------------------------- Anthropic

function loadAnthropic() {
  const mod = require('@anthropic-ai/sdk');
  return mod.default || mod;
}

function buildAnthropicParams({ model, effort, system, messages }) {
  const params = {
    model,
    max_tokens: ANTHROPIC_MAX_TOKENS,
    system,
    messages,
    output_config: { effort }
  };
  // On a safety-classifier decline, let the API re-run the request on a
  // fallback model instead of returning an empty answer.
  if (FALLBACK_MODELS.has(model)) {
    params.betas = ['server-side-fallback-2026-07-01'];
    params.fallbacks = 'default';
  }
  return params;
}

function formatAnthropicError(error, Anthropic) {
  if (Anthropic && error instanceof Anthropic.AuthenticationError) {
    return 'Claude rejected the API key. Run "PReview: Set Claude API Key" to update it.';
  }
  if (Anthropic && error instanceof Anthropic.PermissionDeniedError) {
    return `Claude API key lacks permission for this request: ${error.message}`;
  }
  if (Anthropic && error instanceof Anthropic.NotFoundError) {
    return `Claude model not found. Check the reviewComments.anthropicModel setting. (${error.message})`;
  }
  if (Anthropic && error instanceof Anthropic.RateLimitError) {
    return 'Claude rate limit reached. Wait a moment and retry.';
  }
  if (Anthropic && error instanceof Anthropic.BadRequestError) {
    return `Claude rejected the request: ${error.message}`;
  }
  if (Anthropic && error instanceof Anthropic.APIConnectionError) {
    return 'Could not reach the Claude API. Check your network connection.';
  }
  if (Anthropic && error instanceof Anthropic.APIError) {
    return `Claude API error${error.status ? ` (${error.status})` : ''}: ${error.message}`;
  }
  const message = error?.message || String(error);
  if (/api[_ ]?key|authentication|credentials/i.test(message)) {
    return 'No Claude API key found. Run "PReview: Set Claude API Key" first.';
  }
  return message;
}

async function streamAnthropic({ apiKey, model, effort, system, messages, signal, onText, createClient }) {
  const Anthropic = createClient ? null : loadAnthropic();
  let stream;

  try {
    const client = createClient ? createClient({ apiKey }) : new Anthropic(apiKey ? { apiKey } : {});
    stream = client.beta.messages.stream(buildAnthropicParams({ model, effort, system, messages }), { signal });

    let text = '';
    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
        text += event.delta.text;
        onText(event.delta.text);
      }
    }

    const final = await stream.finalMessage();
    if (final.stop_reason === 'refusal' && !text.trim()) {
      const category = final.stop_details?.category;
      throw new Error(`Claude declined this request${category ? ` (${category})` : ''}.`);
    }
    if (final.stop_reason === 'max_tokens') {
      const note = '\n\n_[Answer cut off at the output limit.]_';
      text += note;
      onText(note);
    }

    return {
      text,
      model: final.model || model,
      usage: {
        inputTokens: final.usage?.input_tokens ?? 0,
        outputTokens: final.usage?.output_tokens ?? 0
      }
    };
  } catch (error) {
    if (signal?.aborted || (Anthropic && error instanceof Anthropic.APIUserAbortError)) {
      const abort = new Error('aborted');
      abort.name = 'AbortError';
      throw abort;
    }
    throw new Error(formatAnthropicError(error, Anthropic));
  }
}

module.exports = {
  OLLAMA_URL,
  OLLAMA_MODEL,
  ANTHROPIC_MODEL,
  ANTHROPIC_EFFORT,
  SYSTEM_PROMPT,
  detectMode,
  defaultQuestion,
  truncateForModel,
  collectContextLines,
  formatContextBlock,
  buildMessages,
  parseOllamaLine,
  buildOllamaRequestBody,
  getOllamaHealthUrl,
  formatOllamaError,
  streamOllama,
  buildAnthropicParams,
  formatAnthropicError,
  streamAnthropic
};
