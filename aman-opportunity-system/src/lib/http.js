import { setTimeout as sleep } from 'node:timers/promises';

const UA = process.env.SCRAPE_USER_AGENT ||
  'AmanOpportunityBot/1.0 (+internal sales-intelligence tool)';
const TIMEOUT = Number(process.env.SCRAPE_TIMEOUT_MS || 25000);
const DELAY = Number(process.env.SCRAPE_DELAY_MS || 1200);
const RESPECT_ROBOTS = (process.env.RESPECT_ROBOTS ?? 'true') !== 'false';

const robotsCache = new Map();   // origin -> {disallow: string[]}
const lastHit = new Map();       // origin -> timestamp

/** השהיה מנומסת: לא יותר מבקשה אחת ל-origin בכל DELAY מילישניות. */
async function throttle(origin) {
  const prev = lastHit.get(origin) ?? 0;
  const wait = DELAY - (Date.now() - prev);
  if (wait > 0) await sleep(wait);
  lastHit.set(origin, Date.now());
}

async function loadRobots(origin) {
  if (robotsCache.has(origin)) return robotsCache.get(origin);
  const rules = { disallow: [] };
  try {
    const res = await fetch(`${origin}/robots.txt`, {
      headers: { 'user-agent': UA },
      signal: AbortSignal.timeout(8000),
    });
    if (res.ok) {
      let applies = false;
      for (const raw of (await res.text()).split('\n')) {
        const line = raw.split('#')[0].trim();
        if (!line) continue;
        const [k, ...rest] = line.split(':');
        const key = k.trim().toLowerCase();
        const val = rest.join(':').trim();
        if (key === 'user-agent') applies = val === '*' || UA.toLowerCase().includes(val.toLowerCase());
        else if (key === 'disallow' && applies && val) rules.disallow.push(val);
      }
    }
  } catch { /* אין robots.txt או שלא נגיש — ממשיכים */ }
  robotsCache.set(origin, rules);
  return rules;
}

/** האם ה-URL מותר לסריקה לפי robots.txt. */
export async function isAllowed(url) {
  if (!RESPECT_ROBOTS) return true;
  try {
    const u = new URL(url);
    const { disallow } = await loadRobots(u.origin);
    return !disallow.some((p) => u.pathname.startsWith(p));
  } catch { return false; }
}

/**
 * מוריד עמוד HTML בצורה מנומסת, עם ניסיונות חוזרים ו-backoff.
 * מחזיר { ok, status, html, url, error }.
 */
export async function fetchPage(url, { retries = 2 } = {}) {
  let u;
  try { u = new URL(url); } catch { return { ok: false, url, error: 'כתובת לא תקינה' }; }
  if (!/^https?:$/.test(u.protocol)) return { ok: false, url, error: 'פרוטוקול לא נתמך' };

  if (!(await isAllowed(url))) {
    return { ok: false, url, status: 0, error: 'חסום ב-robots.txt' };
  }

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      await throttle(u.origin);
      const res = await fetch(url, {
        headers: {
          'user-agent': UA,
          'accept': 'text/html,application/xhtml+xml',
          'accept-language': 'he-IL,he;q=0.9,en;q=0.8',
        },
        redirect: 'follow',
        signal: AbortSignal.timeout(TIMEOUT),
      });
      if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
      if (!res.ok) return { ok: false, url, status: res.status, error: `HTTP ${res.status}` };
      const type = res.headers.get('content-type') ?? '';
      if (!/html|xml|text/.test(type)) return { ok: false, url, status: res.status, error: `סוג תוכן לא נתמך: ${type}` };
      return { ok: true, url: res.url, status: res.status, html: await res.text() };
    } catch (err) {
      if (attempt === retries) {
        return { ok: false, url, error: err.name === 'TimeoutError' ? 'פסק זמן' : String(err.message ?? err) };
      }
      await sleep(1500 * 2 ** attempt);
    }
  }
  return { ok: false, url, error: 'לא ידוע' };
}

/** מוריד כמה עמודים ומחזיר רק את המוצלחים. */
export async function fetchMany(urls, opts = {}) {
  const out = [];
  for (const url of urls) {
    const r = await fetchPage(url, opts);
    if (r.ok) out.push(r);
  }
  return out;
}
