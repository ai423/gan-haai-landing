import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';

export const MODEL = process.env.AMAN_MODEL || 'claude-opus-5';
export const EFFORT = process.env.AMAN_EFFORT || 'high';

let _client = null;

export function hasApiKey() {
  return Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
}

export function claude() {
  if (_client) return _client;
  if (!hasApiKey()) {
    throw new Error(
      'לא הוגדר מפתח Claude API. הוסיפו ANTHROPIC_API_KEY לקובץ .env ' +
      '(להשגה: https://console.anthropic.com/settings/keys)'
    );
  }
  _client = new Anthropic();
  return _client;
}

/** צובר שימוש בטוקנים על פני קריאות. */
export function newUsage() { return { tokens_in: 0, tokens_out: 0, calls: 0 }; }
export function addUsage(acc, message) {
  acc.calls += 1;
  acc.tokens_in += message?.usage?.input_tokens ?? 0;
  acc.tokens_out += message?.usage?.output_tokens ?? 0;
  return acc;
}

const textOf = (message) =>
  (message?.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();

/** שולף את כל התוצאות שמנוע החיפוש החזיר, כדי שיישמרו כמקורות. */
function sourcesOf(message) {
  const out = [];
  for (const block of message?.content ?? []) {
    if (block.type !== 'web_search_tool_result') continue;
    // בשגיאה content הוא אובייקט יחיד ולא מערך — יש לבדוק לפני איטרציה
    if (!Array.isArray(block.content)) continue;
    for (const r of block.content) {
      if (r.type === 'web_search_result') {
        out.push({ url: r.url, title: r.title, page_age: r.page_age ?? null });
      }
    }
  }
  return out;
}

/** מזהה שגיאת "סוג כלי לא נתמך" כדי ליפול חזרה לגרסה הישנה של כלי החיפוש. */
const isUnsupportedTool = (err) =>
  err?.status === 400 && /web_search|tool.*type|unsupported/i.test(err?.message ?? '');

/**
 * קריאה עם כלי חיפוש ווב מובנה של Anthropic.
 * מחזירה { text, sources, message }.
 */
export async function searchAndAnswer({ system, prompt, maxUses = 8, maxTokens = 16000,
                                        allowedDomains = null, effort = EFFORT }) {
  const client = claude();
  const build = (toolType) => {
    const tool = { type: toolType, name: 'web_search', max_uses: maxUses };
    if (allowedDomains?.length) tool.allowed_domains = allowedDomains;
    return {
      model: MODEL,
      max_tokens: maxTokens,
      system,
      thinking: { type: 'adaptive' },
      output_config: { effort },
      tools: [tool],
      messages: [{ role: 'user', content: prompt }],
    };
  };

  let message;
  try {
    const stream = client.messages.stream(build('web_search_20260209'));
    message = await stream.finalMessage();
  } catch (err) {
    if (!isUnsupportedTool(err)) throw err;
    const stream = client.messages.stream(build('web_search_20250305'));
    message = await stream.finalMessage();
  }

  if (message.stop_reason === 'refusal') {
    const reason = message.stop_details?.explanation || message.stop_details?.category || 'לא צוינה סיבה';
    throw new Error(`המודל סירב לענות על הבקשה (${reason})`);
  }
  return { text: textOf(message), sources: sourcesOf(message), message };
}

/**
 * הופכת טקסט חופשי לאובייקט מובנה לפי סכימת zod.
 * שלב נפרד מהחיפוש בכוונה — פלט מובנה ומצטטים לא משתלבים היטב באותה קריאה.
 */
export async function structure({ system, prompt, schema, maxTokens = 16000, effort = 'medium' }) {
  const client = claude();
  const res = await client.messages.parse({
    model: MODEL,
    max_tokens: maxTokens,
    system,
    thinking: { type: 'adaptive' },
    output_config: { effort, format: zodOutputFormat(schema) },
    messages: [{ role: 'user', content: prompt }],
  });
  if (res.stop_reason === 'refusal') {
    throw new Error('המודל סירב לבנות את הפלט המובנה');
  }
  if (!res.parsed_output) {
    throw new Error('הפלט המובנה לא נפרס. תוכן שהתקבל: ' + textOf(res).slice(0, 400));
  }
  return { data: res.parsed_output, message: res };
}

/** קריאת טקסט רגילה (לסיכום המנכ"ל). */
export async function complete({ system, prompt, maxTokens = 32000, effort = EFFORT }) {
  const client = claude();
  const stream = client.messages.stream({
    model: MODEL,
    max_tokens: maxTokens,
    system,
    thinking: { type: 'adaptive' },
    output_config: { effort },
    messages: [{ role: 'user', content: prompt }],
  });
  const message = await stream.finalMessage();
  if (message.stop_reason === 'refusal') throw new Error('המודל סירב לייצר את הדוח');
  return { text: textOf(message), message };
}

export { z };
