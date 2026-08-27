import { db, toJson, slugify, uniqueSlug, audit, startRun, finishRun } from '../db/index.js';
import { fetchPage } from '../lib/http.js';
import { pageText, pageMeta, links, externalLinks, findServicePageLinks } from '../lib/html.js';
import { createLogger } from '../lib/logger.js';
import { structure, hasApiKey, newUsage, addUsage, z } from '../lib/claude.js';

const GROUP_URL = process.env.AMAN_GROUP_URL || 'https://www.aman-global.com/';

// ── סכימות פלט מובנה ────────────────────────────────────────────────────
const SubsidiarySchema = z.object({
  companies: z.array(z.object({
    name_en: z.string().describe('שם החברה באנגלית כפי שמופיע באתר'),
    name_he: z.string().describe('שם החברה בעברית; אם אין, תעתיק סביר של השם האנגלי'),
    website: z.string().describe('כתובת אתר החברה, או מחרוזת ריקה אם לא נמצאה'),
    description: z.string().describe('משפט או שניים בעברית על תחום הפעילות'),
    domains: z.array(z.string()).describe('2-4 תגיות תחום באנגלית, למשל data, cyber, digital'),
    hq_country: z.string().describe('קוד מדינה בן שתי אותיות, למשל IL'),
    confidence: z.number().describe('0 עד 1 — עד כמה ברור שזו חברת בת של הקבוצה'),
  })),
});

const ServiceSchema = z.object({
  services: z.array(z.object({
    name_he: z.string().describe('שם השירות בעברית'),
    name_en: z.string().describe('שם השירות באנגלית, או מחרוזת ריקה'),
    category: z.string().describe('אחת מ: data, cyber, cloud, infrastructure, digital, marketing, crm, cx, ai, hr, consulting, product'),
    description: z.string().describe('משפט קצר בעברית שמסביר מה השירות נותן ללקוח'),
    keywords: z.array(z.string()).describe('4-8 מילות מפתח (עברית ואנגלית) שמופיעות כשלקוח זקוק לשירות הזה'),
  })),
});

// ── עזרי התאמה למסד קיים ────────────────────────────────────────────────
const host = (url) => { try { return new URL(url).hostname.replace(/^www\./, '').toLowerCase(); } catch { return null; } };
const norm = (s) => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

/** מאתר חברת בת קיימת לפי אתר, slug או שם — כדי לא ליצור כפילויות. */
function findSubsidiary(name_en, name_he, website) {
  const d = db();
  const h = host(website);
  if (h) {
    const byHost = d.prepare('SELECT * FROM subsidiaries WHERE website IS NOT NULL').all()
      .find((r) => host(r.website) === h);
    if (byHost) return byHost;
  }
  const bySlug = d.prepare('SELECT * FROM subsidiaries WHERE slug = ?').get(slugify(name_en || name_he));
  if (bySlug) return bySlug;
  const targets = [norm(name_en), norm(name_he)].filter(Boolean);
  return d.prepare('SELECT * FROM subsidiaries').all()
    .find((r) => targets.includes(norm(r.name_en)) || targets.includes(norm(r.name_he))) ?? null;
}

/** גילוי עמודים באתר הקבוצה שסביר שמכילים את רשימת החברות. */
function discoverCompanyPages(html, baseUrl) {
  const PATTERNS = /(companies|our[- ]companies|group|subsidiar|portfolio|brands|about[- ]us|החברות|קבוצת|אודות)/i;
  const found = links(html, baseUrl)
    .filter((l) => {
      try {
        const u = new URL(l.url);
        return u.hostname.replace(/^www\./, '') === new URL(baseUrl).hostname.replace(/^www\./, '')
          && (PATTERNS.test(u.pathname) || PATTERNS.test(l.text));
      } catch { return false; }
    })
    .map((l) => l.url);
  // ניחושים נפוצים גם אם לא נמצא קישור
  const guesses = ['companies/', 'our-companies/', 'group/', 'about/'].map((p) => new URL(p, baseUrl).toString());
  return [...new Set([...found, ...guesses])].slice(0, 8);
}

// ═══════════════════════════════════════════════════════════════════════
//  סריקת אתר הקבוצה → חברות בת
// ═══════════════════════════════════════════════════════════════════════
export async function scrapeGroup({ triggerMode = 'manual', includeServices = true, groupUrl = GROUP_URL } = {}) {
  const log = createLogger('');
  const usage = newUsage();
  const runId = startRun('scrape_group', { triggerMode, scope: { groupUrl }, model: process.env.AMAN_MODEL });
  const result = { created: 0, updated: 0, servicesCreated: 0, errors: [], companies: [] };

  try {
    log.info(`סורק את אתר הקבוצה: ${groupUrl}`);
    const home = await fetchPage(groupUrl);
    if (!home.ok) throw new Error(`לא ניתן להוריד את ${groupUrl} — ${home.error}`);

    const pages = [home];
    for (const url of discoverCompanyPages(home.html, home.url)) {
      if (url === home.url) continue;
      const p = await fetchPage(url);
      if (p.ok) { pages.push(p); log.dim(`  נסרק: ${url}`); }
    }
    log.ok(`הורדו ${pages.length} עמודים מאתר הקבוצה`);

    // כל הקישורים היוצאים הם המועמדים החזקים ביותר להיות אתרי חברות בת
    const outbound = new Map();
    for (const p of pages) {
      for (const l of externalLinks(p.html, p.url)) {
        if (/facebook|linkedin|twitter|x\.com|instagram|youtube|google|wikipedia|w3\.org|gov\.il/i.test(l.url)) continue;
        if (!outbound.has(host(l.url))) outbound.set(host(l.url), l);
      }
    }
    log.info(`${outbound.size} דומיינים חיצוניים מועמדים`);

    if (!hasApiKey()) {
      throw new Error('סריקת האתר דורשת מפתח Claude API כדי לזהות אילו קישורים הם חברות בת. הגדירו ANTHROPIC_API_KEY.');
    }

    const corpus = pages.map((p) => {
      const m = pageMeta(p.html);
      return `### עמוד: ${p.url}\nכותרת: ${m.title ?? ''}\n${pageText(p.html, 9000)}`;
    }).join('\n\n');
    const linkList = [...outbound.values()].map((l) => `- ${l.text || '(ללא טקסט)'} → ${l.url}`).join('\n');

    const { data, message } = await structure({
      system: 'אתה מנתח אתרי תאגידים ומחלץ מהם מבנה קבוצתי. אתה מסתמך אך ורק על מה שמופיע בטקסט שקיבלת, ולא על ידע קודם. אם חברה לא מוזכרת בטקסט — אל תמציא אותה.',
      prompt: `להלן תוכן עמודים מאתר קבוצת אמן מחשוב, ורשימת הקישורים היוצאים מהם.

זהה את **חברות הבת של הקבוצה** בלבד (לא ספקי טכנולוגיה, לא שותפים, לא לקוחות, לא רשתות חברתיות).
לכל חברת בת החזר שם, אתר (אם מופיע בקישורים), תיאור קצר בעברית ותחומי פעילות.
דרג confidence נמוך אם אינך בטוח שמדובר בחברת בת.

--- תוכן העמודים ---
${corpus}

--- קישורים יוצאים ---
${linkList}`,
      schema: SubsidiarySchema,
      maxTokens: 16000,
    });
    addUsage(usage, message);

    const companies = (data.companies ?? []).filter((c) => (c.confidence ?? 0) >= 0.5);
    log.ok(`זוהו ${companies.length} חברות בת (מתוך ${data.companies?.length ?? 0} מועמדות)`);

    // ── שמירה ─────────────────────────────────────────────────────────
    const d = db();
    for (const c of companies) {
      const existing = findSubsidiary(c.name_en, c.name_he, c.website);
      const payload = {
        name_he: c.name_he || c.name_en,
        name_en: c.name_en || null,
        website: c.website || null,
        description: c.description || null,
        domains: toJson(c.domains ?? []),
        hq_country: c.hq_country || null,
        source_url: groupUrl,
        confidence: Math.min(0.95, c.confidence ?? 0.7),
      };
      if (existing) {
        if (existing.origin === 'manual') {
          log.dim(`  ${existing.name_he}: נערך ידנית — לא נדרס`);
          result.companies.push({ ...existing, action: 'skipped_manual' });
          continue;
        }
        d.prepare(`UPDATE subsidiaries SET name_he=@name_he, name_en=@name_en,
                     website=COALESCE(@website, website), description=@description, domains=@domains,
                     hq_country=COALESCE(@hq_country, hq_country), source_url=@source_url,
                     confidence=@confidence, origin='scrape', last_scraped_at=datetime('now'),
                     updated_at=datetime('now') WHERE id=@id`).run({ ...payload, id: existing.id });
        audit('subsidiaries', existing.id, 'update', existing, payload, 'scraper');
        result.updated++;
        result.companies.push({ id: existing.id, ...payload, action: 'updated' });
        log.dim(`  עודכן: ${payload.name_he}`);
      } else {
        const slug = uniqueSlug('subsidiaries', c.name_en || c.name_he);
        const info = d.prepare(`INSERT INTO subsidiaries
          (slug, name_he, name_en, website, description, domains, hq_country, source_url, confidence, origin, last_scraped_at)
          VALUES (@slug, @name_he, @name_en, @website, @description, @domains, @hq_country, @source_url, @confidence, 'scrape', datetime('now'))`)
          .run({ slug, ...payload });
        audit('subsidiaries', info.lastInsertRowid, 'create', null, payload, 'scraper');
        result.created++;
        result.companies.push({ id: info.lastInsertRowid, slug, ...payload, action: 'created' });
        log.ok(`  נוצר: ${payload.name_he}`);
      }
    }

    // ── שירותים לכל חברת בת ───────────────────────────────────────────
    if (includeServices) {
      for (const c of result.companies) {
        if (!c.website || c.action === 'skipped_manual') continue;
        try {
          const n = await scrapeServicesFor(c.id, c.website, { log, usage });
          result.servicesCreated += n;
        } catch (err) {
          log.warn(`  שירותים עבור ${c.name_he}: ${err.message}`);
          result.errors.push(`שירותים/${c.name_he}: ${err.message}`);
        }
      }
    }

    finishRun(runId, {
      status: result.errors.length ? 'partial' : 'ok',
      itemsIn: pages.length, itemsOut: result.created + result.updated,
      tokensIn: usage.tokens_in, tokensOut: usage.tokens_out,
      log: log.text(), error: result.errors.join('; ') || null,
    });
    log.ok(`סיום: ${result.created} חדשות, ${result.updated} עודכנו, ${result.servicesCreated} שירותים`);
    return { runId, ...result, log: log.text() };
  } catch (err) {
    log.error(err.message);
    finishRun(runId, { status: 'failed', tokensIn: usage.tokens_in, tokensOut: usage.tokens_out,
                       log: log.text(), error: err.message });
    throw Object.assign(err, { runId, log: log.text() });
  }
}

/** סורק את אתר חברת הבת ומחלץ ממנו את רשימת השירותים. */
export async function scrapeServicesFor(subsidiaryId, website, { log = createLogger(''), usage = newUsage() } = {}) {
  const home = await fetchPage(website);
  if (!home.ok) throw new Error(`אתר לא נגיש (${home.error})`);

  const pages = [home];
  for (const l of findServicePageLinks(home.html, home.url).slice(0, 5)) {
    const p = await fetchPage(l.url);
    if (p.ok) pages.push(p);
  }
  const corpus = pages.map((p) => `### ${p.url}\n${pageText(p.html, 7000)}`).join('\n\n');

  const { data, message } = await structure({
    system: 'אתה מחלץ קטלוג שירותים מאתר של חברת טכנולוגיה. הסתמך רק על הטקסט שקיבלת.',
    prompt: `להלן תוכן מאתר של חברה. חלץ את **השירותים או הפתרונות שהחברה מוכרת ללקוחות**.
עד 8 שירותים, ברמת פירוט שימושית למכירות (לא סיסמאות שיווקיות).
לכל שירות ציין מילות מפתח שיעזרו לזהות בכתבה חדשותית שלקוח זקוק לשירות הזה.

${corpus}`,
    schema: ServiceSchema,
    maxTokens: 12000,
  });
  addUsage(usage, message);

  const d = db();
  let created = 0;
  for (const s of data.services ?? []) {
    if (!s.name_he) continue;
    let slug = slugify(s.name_en || s.name_he), i = 1;
    const taken = d.prepare('SELECT id, origin FROM services WHERE subsidiary_id = ? AND slug = ?');
    let existing = taken.get(subsidiaryId, slug);
    while (existing && existing.origin === 'manual') { slug = `${slugify(s.name_en || s.name_he)}-${++i}`; existing = taken.get(subsidiaryId, slug); }

    const payload = {
      subsidiary_id: subsidiaryId, slug,
      name_he: s.name_he, name_en: s.name_en || null,
      category: s.category || null, description: s.description || null,
      keywords: toJson(s.keywords ?? []), source_url: website,
    };
    if (existing) {
      d.prepare(`UPDATE services SET name_he=@name_he, name_en=@name_en, category=@category,
                 description=@description, keywords=@keywords, source_url=@source_url,
                 origin='scrape', updated_at=datetime('now')
                 WHERE subsidiary_id=@subsidiary_id AND slug=@slug`).run(payload);
    } else {
      d.prepare(`INSERT INTO services (subsidiary_id, slug, name_he, name_en, category, description, keywords, source_url, origin)
                 VALUES (@subsidiary_id, @slug, @name_he, @name_en, @category, @description, @keywords, @source_url, 'scrape')`)
        .run(payload);
      created++;
    }
  }
  log.dim(`  שירותים: ${data.services?.length ?? 0} נמצאו, ${created} חדשים`);
  return created;
}
