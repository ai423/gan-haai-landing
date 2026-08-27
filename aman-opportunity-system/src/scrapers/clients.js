import { db, toJson, fromJson, uniqueSlug, audit, startRun, finishRun } from '../db/index.js';
import { fetchPage } from '../lib/http.js';
import { pageText, logoCandidates, findClientPageLinks } from '../lib/html.js';
import { createLogger } from '../lib/logger.js';
import { structure, hasApiKey, newUsage, addUsage, z } from '../lib/claude.js';

const ClientSchema = z.object({
  clients: z.array(z.object({
    name_he: z.string().describe('שם הלקוח בעברית; אם החברה מוכרת רק באנגלית, כתוב את השם האנגלי'),
    name_en: z.string().describe('שם הלקוח באנגלית, או מחרוזת ריקה'),
    industry: z.string().describe('ענף בעברית: פיננסים, ביטוח, קמעונאות, תקשורת, בריאות, ביטחון, ממשלה, היי-טק, תעשייה, אנרגיה, לוגיסטיקה, חינוך, אחר'),
    relationship: z.string().describe('אחד מ: customer, case_study, partner — case_study רק אם יש עמוד מקרה בוחן ייעודי'),
    evidence_text: z.string().describe('ציטוט קצר או תיאור מדויק ממה בעמוד מעיד על הקשר'),
    confidence: z.number().describe('0 עד 1 — עד כמה ברור שזה לקוח של החברה ולא ספק/שותף/פרס'),
  })),
});

const norm = (s) => String(s || '').toLowerCase()
  .replace(/\b(ltd|inc|corp|co|group|israel|ישראל|בע"מ|בעמ)\b/gi, '')
  .replace(/[^\p{L}\p{N}]/gu, '');
const host = (u) => { try { return new URL(u).hostname.replace(/^www\./, '').toLowerCase(); } catch { return null; } };

/**
 * מאתר לקוח קיים לפי שם, שם חלופי או אתר — כך שלקוח של שתי חברות בת
 * יהיה שורה אחת עם שני קשרים, ולא שתי כפילויות.
 */
export function resolveClient(name_he, name_en, website = null) {
  const d = db();
  const h = host(website);
  const all = d.prepare('SELECT * FROM clients').all();
  if (h) {
    const byHost = all.find((c) => host(c.website) === h);
    if (byHost) return byHost;
  }
  const targets = [norm(name_he), norm(name_en)].filter((s) => s.length >= 2);
  return all.find((c) => {
    const names = [norm(c.name_he), norm(c.name_en), ...(fromJson(c.aliases, []) || []).map(norm)];
    return names.some((n) => n.length >= 2 && targets.includes(n));
  }) ?? null;
}

/** מוסיף שם חלופי ללקוח קיים אם הוא חדש. */
function addAlias(clientId, name) {
  if (!name) return;
  const d = db();
  const row = d.prepare('SELECT aliases, name_he, name_en FROM clients WHERE id = ?').get(clientId);
  const known = new Set([...(fromJson(row.aliases, []) || []), row.name_he, row.name_en].filter(Boolean));
  if (known.has(name)) return;
  known.delete(row.name_he); known.delete(row.name_en);
  d.prepare(`UPDATE clients SET aliases = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(toJson([...known, name]), clientId);
}

// ═══════════════════════════════════════════════════════════════════════
//  סריקת לקוחות מאתרי חברות הבת
// ═══════════════════════════════════════════════════════════════════════
export async function scrapeClients({ subsidiaryIds = null, triggerMode = 'manual' } = {}) {
  const log = createLogger('');
  const usage = newUsage();
  const runId = startRun('scrape_clients', { triggerMode, scope: { subsidiaryIds }, model: process.env.AMAN_MODEL });
  const result = { clientsCreated: 0, linksCreated: 0, linksUpdated: 0, perSubsidiary: [], errors: [] };

  try {
    if (!hasApiKey()) {
      throw new Error('סריקת לקוחות דורשת מפתח Claude API לניקוי וזיהוי שמות. הגדירו ANTHROPIC_API_KEY.');
    }
    const d = db();
    const subs = subsidiaryIds?.length
      ? d.prepare(`SELECT * FROM subsidiaries WHERE id IN (${subsidiaryIds.map(() => '?').join(',')})`).all(...subsidiaryIds)
      : d.prepare(`SELECT * FROM subsidiaries WHERE status = 'active' AND website IS NOT NULL`).all();

    log.info(`סורק לקוחות מ-${subs.length} חברות בת`);

    for (const sub of subs) {
      const entry = { subsidiary: sub.name_he, found: 0, created: 0, linked: 0, error: null };
      try {
        if (!sub.website) throw new Error('לא הוגדר אתר לחברה');
        const home = await fetchPage(sub.website);
        if (!home.ok) throw new Error(`אתר לא נגיש (${home.error})`);

        const pages = [home];
        for (const l of findClientPageLinks(home.html, home.url)) {
          const p = await fetchPage(l.url);
          if (p.ok) pages.push(p);
        }
        log.dim(`  ${sub.name_he}: ${pages.length} עמודים`);

        // לוגואים הם האות החזק ביותר לרשימת לקוחות
        const logos = new Map();
        for (const p of pages) for (const c of logoCandidates(p.html, p.url)) {
          if (!logos.has(c.name.toLowerCase())) logos.set(c.name.toLowerCase(), { ...c, page: p.url });
        }
        const corpus = pages.map((p) => `### ${p.url}\n${pageText(p.html, 6000)}`).join('\n\n');
        const logoList = [...logos.values()].map((l) => `- ${l.name}  (מקור: ${l.how}, עמוד: ${l.page})`).join('\n');

        if (!logoList && corpus.length < 300) throw new Error('לא נמצא תוכן לניתוח');

        const { data, message } = await structure({
          system: 'אתה מחלץ רשימות לקוחות מאתרי חברות טכנולוגיה. אתה זהיר: לא כל לוגו בעמוד הוא לקוח — יש גם ספקים, שותפים טכנולוגיים, תקנים ופרסים. הסתמך אך ורק על החומר שקיבלת.',
          prompt: `להלן תוכן עמודים מאתר של החברה "${sub.name_he}" (${sub.name_en ?? ''}), ורשימת שמות שחולצו מלוגואים בעמודים.

חלץ את **הלקוחות של החברה** בלבד.
אל תכלול: ספקי טכנולוגיה שהחברה מוכרת (Microsoft, Salesforce, Citrix, Informatica וכדומה) אלא אם נאמר במפורש שהם לקוח, תקנים, פרסים, רשתות חברתיות, או את החברה עצמה.
אם משהו מופיע כלוגו בלי הקשר ברור — תן לו confidence נמוך.

--- שמות מלוגואים ---
${logoList || '(לא נמצאו)'}

--- תוכן העמודים ---
${corpus}`,
          schema: ClientSchema,
          maxTokens: 14000,
        });
        addUsage(usage, message);

        const candidates = (data.clients ?? []).filter((c) => (c.confidence ?? 0) >= 0.5 && c.name_he);
        entry.found = candidates.length;

        for (const c of candidates) {
          let client = resolveClient(c.name_he, c.name_en);
          if (client) {
            addAlias(client.id, c.name_he);
            addAlias(client.id, c.name_en);
          } else {
            const slug = uniqueSlug('clients', c.name_en || c.name_he);
            const info = d.prepare(`INSERT INTO clients (slug, name_he, name_en, industry, source_url, confidence, origin)
                                    VALUES (?, ?, ?, ?, ?, ?, 'scrape')`)
              .run(slug, c.name_he, c.name_en || null, c.industry || null, sub.website, Math.min(0.9, c.confidence));
            client = d.prepare('SELECT * FROM clients WHERE id = ?').get(info.lastInsertRowid);
            audit('clients', client.id, 'create', null, { name: c.name_he, via: sub.name_he }, 'scraper');
            result.clientsCreated++; entry.created++;
          }

          const rel = ['customer', 'case_study', 'partner'].includes(c.relationship) ? c.relationship : 'customer';
          const existing = d.prepare('SELECT * FROM client_subsidiary WHERE client_id = ? AND subsidiary_id = ?')
            .get(client.id, sub.id);
          if (existing) {
            if (existing.origin !== 'manual') {
              d.prepare(`UPDATE client_subsidiary SET relationship=?, evidence_url=?, evidence_text=?,
                         confidence=?, origin='scrape', updated_at=datetime('now') WHERE id=?`)
                .run(rel, sub.website, c.evidence_text || null, Math.min(0.9, c.confidence), existing.id);
              result.linksUpdated++;
            }
          } else {
            d.prepare(`INSERT INTO client_subsidiary (client_id, subsidiary_id, relationship, evidence_url, evidence_text, confidence, origin)
                       VALUES (?, ?, ?, ?, ?, ?, 'scrape')`)
              .run(client.id, sub.id, rel, sub.website, c.evidence_text || null, Math.min(0.9, c.confidence));
            result.linksCreated++; entry.linked++;
          }
        }
        d.prepare(`UPDATE subsidiaries SET last_scraped_at = datetime('now') WHERE id = ?`).run(sub.id);
        log.ok(`  ${sub.name_he}: ${entry.found} לקוחות (${entry.created} חדשים)`);
      } catch (err) {
        entry.error = err.message;
        result.errors.push(`${sub.name_he}: ${err.message}`);
        log.warn(`  ${sub.name_he}: ${err.message}`);
      }
      result.perSubsidiary.push(entry);
    }

    const shared = d.prepare('SELECT COUNT(*) n FROM v_shared_clients').get().n;
    log.ok(`סיום: ${result.clientsCreated} לקוחות חדשים, ${result.linksCreated} קשרים חדשים, ${shared} לקוחות משותפים לכמה חברות`);

    finishRun(runId, {
      status: result.errors.length ? 'partial' : 'ok',
      itemsIn: subs.length, itemsOut: result.clientsCreated + result.linksCreated,
      tokensIn: usage.tokens_in, tokensOut: usage.tokens_out,
      log: log.text(), error: result.errors.join('; ') || null,
    });
    return { runId, ...result, sharedClients: shared, log: log.text() };
  } catch (err) {
    log.error(err.message);
    finishRun(runId, { status: 'failed', tokensIn: usage.tokens_in, tokensOut: usage.tokens_out,
                       log: log.text(), error: err.message });
    throw Object.assign(err, { runId, log: log.text() });
  }
}
