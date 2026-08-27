import * as cheerio from 'cheerio';

/** ממיר HTML לטקסט נקי (ללא סקריפטים/סגנונות/ניווט), עם תקרת אורך. */
export function pageText(html, maxChars = 14000) {
  const $ = cheerio.load(html);
  $('script, style, noscript, svg, iframe, nav, footer').remove();
  const text = $('body').text().replace(/[ \t ]+/g, ' ').replace(/\n\s*\n\s*\n+/g, '\n\n').trim();
  return text.slice(0, maxChars);
}

/** כותרת העמוד + תיאור המטא. */
export function pageMeta(html) {
  const $ = cheerio.load(html);
  return {
    title: $('title').first().text().trim() || null,
    description: $('meta[name="description"]').attr('content')?.trim()
              || $('meta[property="og:description"]').attr('content')?.trim() || null,
  };
}

/** כל הקישורים בעמוד, מנורמלים לכתובת מוחלטת. */
export function links(html, baseUrl) {
  const $ = cheerio.load(html);
  const seen = new Map();
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href');
    if (!href || /^(mailto:|tel:|javascript:|#)/i.test(href)) return;
    let abs;
    try { abs = new URL(href, baseUrl).toString().split('#')[0]; } catch { return; }
    const text = $(el).text().replace(/\s+/g, ' ').trim();
    const prev = seen.get(abs);
    // שומרים את טקסט העוגן הארוך ביותר — לרוב האינפורמטיבי ביותר
    if (!prev || text.length > prev.text.length) {
      seen.set(abs, { url: abs, text, title: $(el).attr('title') ?? null });
    }
  });
  return [...seen.values()];
}

/** קישורים יוצאים (דומיין שונה מהבסיס). */
export function externalLinks(html, baseUrl) {
  const base = new URL(baseUrl).hostname.replace(/^www\./, '');
  return links(html, baseUrl).filter((l) => {
    try { return new URL(l.url).hostname.replace(/^www\./, '') !== base; } catch { return false; }
  });
}

/**
 * חילוץ מועמדים לשמות לקוחות מלוגואים.
 * לוגואים באתרי לקוחות מופיעים כמעט תמיד כתמונות עם alt/title/שם קובץ משמעותי.
 */
export function logoCandidates(html, baseUrl) {
  const $ = cheerio.load(html);
  const out = new Map();
  const add = (name, src, how) => {
    const clean = cleanBrandName(name);
    if (!clean) return;
    if (!out.has(clean.toLowerCase())) out.set(clean.toLowerCase(), { name: clean, src, how });
  };

  $('img').each((_, el) => {
    const $el = $(el);
    const src = $el.attr('src') || $el.attr('data-src') || $el.attr('data-lazy-src') || '';
    let abs = null;
    try { abs = src ? new URL(src, baseUrl).toString() : null; } catch { /* התעלם */ }
    const alt = ($el.attr('alt') || '').trim();
    const title = ($el.attr('title') || '').trim();
    if (alt) add(alt, abs, 'alt');
    else if (title) add(title, abs, 'title');
    else if (abs) {
      const file = decodeURIComponent(abs.split('/').pop() || '')
        .replace(/\.(png|jpe?g|svg|webp|gif|avif)$/i, '')
        .replace(/[-_]+/g, ' ')
        .replace(/\b(logo|logos|client|customer|לוגו|לקוח)\b/gi, '')
        .trim();
      if (file.length >= 3 && !/^\d+$/.test(file)) add(file, abs, 'filename');
    }
  });

  // גם רשימות טקסטואליות של לקוחות
  $('li, figcaption, .client, .customer, .logo').each((_, el) => {
    const t = $(el).text().replace(/\s+/g, ' ').trim();
    if (t && t.length >= 2 && t.length <= 60 && !/\.(com|co\.il)$/i.test(t)) add(t, null, 'text');
  });

  return [...out.values()];
}

const NOISE = /^(logo|home|menu|search|close|icon|image|banner|slider|arrow|next|prev|facebook|linkedin|twitter|instagram|youtube|whatsapp|placeholder|avatar|thumbnail|תמונה|לוגו|חיפוש|תפריט|דף הבית)$/i;

/** מנקה טקסט לוגו לשם מותג סביר, או מחזיר null אם זה רעש. */
export function cleanBrandName(raw) {
  let s = String(raw || '')
    .replace(/\s+/g, ' ')
    .replace(/^(logo of|logo|client|customer|לוגו של|לוגו|לקוח)\s*[:\-–]?\s*/i, '')
    .replace(/\s*[-–|]\s*(logo|לוגו)\s*$/i, '')
    .trim();
  if (!s || s.length < 2 || s.length > 60) return null;
  if (NOISE.test(s)) return null;
  if (/^[\d\W_]+$/.test(s)) return null;
  if (/^(https?:|www\.|data:)/i.test(s)) return null;
  return s;
}

/** מאתר קישורים שנראים כמו עמוד לקוחות / מקרי בוחן. */
export function findClientPageLinks(html, baseUrl) {
  const PATTERNS = /(customers?|clients?|case[- ]?stud(y|ies)|success[- ]?stor|portfolio|references?|our[- ]work|partners?|לקוחות|לקוחותינו|מקרי[- ]בוחן|סיפורי[- ]הצלחה|פרויקטים|ממליצים)/i;
  return links(html, baseUrl)
    .filter((l) => {
      try {
        const u = new URL(l.url);
        const sameHost = u.hostname.replace(/^www\./, '') === new URL(baseUrl).hostname.replace(/^www\./, '');
        return sameHost && (PATTERNS.test(u.pathname) || PATTERNS.test(l.text));
      } catch { return false; }
    })
    .slice(0, 8);
}

/** מאתר קישורים שנראים כמו עמוד שירותים / פתרונות. */
export function findServicePageLinks(html, baseUrl) {
  const PATTERNS = /(services?|solutions?|what[- ]we[- ]do|expertise|capabilit|products?|offerings?|שירותים|פתרונות|תחומי[- ]פעילות|מה[- ]אנחנו[- ]עושים)/i;
  return links(html, baseUrl)
    .filter((l) => {
      try {
        const u = new URL(l.url);
        const sameHost = u.hostname.replace(/^www\./, '') === new URL(baseUrl).hostname.replace(/^www\./, '');
        return sameHost && (PATTERNS.test(u.pathname) || PATTERNS.test(l.text));
      } catch { return false; }
    })
    .slice(0, 8);
}
