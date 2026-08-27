import crypto from 'node:crypto';
import { db, fromJson, startRun, finishRun, audit } from '../db/index.js';
import { createLogger } from '../lib/logger.js';
import { searchAndAnswer, structure, hasApiKey, newUsage, addUsage, z } from '../lib/claude.js';

// ── סכימת האותות שמוחזרים מהמחקר ────────────────────────────────────────
const ResearchSchema = z.object({
  profile: z.object({
    industry: z.string().describe('ענף בעברית, או מחרוזת ריקה אם לא ידוע'),
    is_public: z.boolean().describe('האם החברה נסחרת בבורסה'),
    ticker: z.string().describe('סימול המניה, או מחרוזת ריקה'),
    exchange: z.string().describe('TASE / NASDAQ / NYSE וכדומה, או מחרוזת ריקה'),
    size_band: z.string().describe('SMB, Mid או Enterprise'),
    summary_he: z.string().describe('2-4 משפטים בעברית: מה החברה עושה ומה מצבה העסקי כרגע'),
  }),
  signals: z.array(z.object({
    trigger_code: z.string().describe('קוד הטריגר מתוך הקטלוג שסופק. אם שום קוד לא מתאים — כתוב other'),
    title_he: z.string().describe('כותרת קצרה בעברית לאירוע'),
    summary_he: z.string().describe('1-3 משפטים בעברית: מה קרה ולמה זה רלוונטי לרכש טכנולוגי'),
    evidence_quote: z.string().describe('ציטוט מדויק מהמקור שמוכיח את האירוע. אם אין ציטוט מדויק — תיאור עובדתי צמוד למקור'),
    evidence_url: z.string().describe('כתובת המקור המדויקת'),
    evidence_source: z.string().describe('שם המקור, למשל גלובס, כלכליסט, אנשים ומחשבים, מאי"ה, אתר החברה'),
    evidence_date: z.string().describe('תאריך הפרסום בפורמט YYYY-MM-DD. אם ידוע רק חודש, השתמש ב-01 ליום'),
    strength: z.number().describe('0 עד 1 — עד כמה האירוע מנבא צורך ברכש טכנולוגי בחודשים הקרובים'),
    sentiment: z.string().describe('positive, neutral או negative'),
  })),
});

const fingerprint = (clientId, code, title, url) =>
  crypto.createHash('sha1')
    .update(`${clientId}|${code}|${String(title).toLowerCase().replace(/\s+/g, ' ').trim()}|${url ?? ''}`)
    .digest('hex').slice(0, 20);

const isoDate = (s) => (/^\d{4}-\d{2}-\d{2}$/.test(String(s ?? '')) ? s : null);

/** בונה את קטלוג הטריגרים כטקסט להזרקה לפרומפט. */
function triggerCatalogText() {
  return db().prepare(`SELECT code, name_he, description, keywords FROM trigger_types WHERE is_active = 1
                       ORDER BY category, code`).all()
    .map((t) => {
      const kw = (fromJson(t.keywords, []) || []).slice(0, 8).join(', ');
      return `- ${t.code} — ${t.name_he}: ${t.description ?? ''}${kw ? ` [מילות מפתח: ${kw}]` : ''}`;
    }).join('\n');
}

// ═══════════════════════════════════════════════════════════════════════
//  מחקר על לקוח בודד
// ═══════════════════════════════════════════════════════════════════════
export async function researchOne(client, { log = createLogger(''), usage = newUsage(), monthsBack = 12, runId = null } = {}) {
  const d = db();
  const catalog = triggerCatalogText();
  const known = d.prepare(`
    SELECT s.name_he FROM client_subsidiary cs JOIN subsidiaries s ON s.id = cs.subsidiary_id
     WHERE cs.client_id = ?`).all(client.id).map((r) => r.name_he);

  const names = [client.name_he, client.name_en, ...(fromJson(client.aliases, []) || [])]
    .filter(Boolean).join(' / ');

  // ── שלב 1: חיפוש ווב ────────────────────────────────────────────────
  const research = await searchAndAnswer({
    system: `אתה אנליסט מודיעין עסקי לצוות מכירות של קבוצת IT ישראלית. אתה מחפש ברשת אירועים אמיתיים ומתועדים, ומצטט מקורות מדויקים. אתה לעולם לא ממציא עובדה, תאריך או ציטוט. אם לא מצאת מידע — אתה אומר זאת במפורש.`,
    prompt: `חקור את החברה: **${names}**${client.industry ? ` (ענף: ${client.industry})` : ''}${client.ticker ? ` (סימול: ${client.ticker}${client.exchange ? ' ב' + client.exchange : ''})` : ''}${client.website ? `\nאתר: ${client.website}` : ''}

חפש אירועים מ-${monthsBack} החודשים האחרונים בלבד, במקורות האלה:
1. עיתונות כלכלית ישראלית — גלובס, כלכליסט, TheMarker, ynet כלכלה
2. עיתונות טכנולוגית — אנשים ומחשבים (pc.co.il), Geektime, CTech
3. דיווחי בורסה — מאי"ה / TASE אם החברה ציבורית בישראל, או SEC/דוחות רבעוניים אם היא נסחרת בחו"ל
4. אתר החברה עצמה — הודעות לעיתונות, בלוג, עמוד קריירה (משרות פתוחות)
5. LinkedIn — מינויים של בכירים בטכנולוגיה

מצא במיוחד אירועים שמתאימים לקטגוריות הבאות (סימני רכישה):
${catalog}

לכל אירוע שמצאת דווח: מה קרה, מתי בדיוק, מה המקור המדויק (כתובת), וציטוט קצר מהמקור.
אל תדווח על אירועים שאתה לא מצליח לקשר למקור ספציפי.
אם לא מצאת כלום — כתוב זאת במפורש במקום להמציא.

בנוסף, סכם את פרופיל החברה: מה היא עושה, גודל, מצב עסקי נוכחי, והאם היא ציבורית.`,
    maxUses: 10,
    maxTokens: 16000,
  });
  addUsage(usage, research.message);

  if (!research.text || research.text.length < 80) {
    log.warn(`  ${client.name_he}: החיפוש לא החזיר תוכן`);
    return { signals: 0, sources: research.sources.length };
  }

  // ── שלב 2: מבנה ─────────────────────────────────────────────────────
  const { data, message } = await structure({
    system: 'אתה ממיר דוח מחקר לרשומות מובנות. אתה מעביר רק אירועים שמופיעים בדוח עם מקור. אירוע בלי כתובת מקור — אל תכלול אותו.',
    prompt: `להלן דוח מחקר על החברה "${client.name_he}".
המר אותו לרשומות מובנות. השתמש אך ורק בקודי הטריגר האלה:

${catalog}

חוקים:
- אל תמציא אירועים שלא מופיעים בדוח.
- אל תכלול אירוע ללא evidence_url.
- strength גבוה (0.8+) רק לאירוע טרי ומשמעותי עם השלכה ברורה על רכש טכנולוגי.
- אם הדוח אומר שלא נמצא מידע — החזר מערך signals ריק.

--- הדוח ---
${research.text}

--- מקורות שהתקבלו מהחיפוש ---
${research.sources.map((s) => `- ${s.title ?? ''} → ${s.url}`).join('\n')}`,
    schema: ResearchSchema,
    maxTokens: 14000,
  });
  addUsage(usage, message);

  // ── שמירה ───────────────────────────────────────────────────────────
  const getTrig = d.prepare('SELECT id FROM trigger_types WHERE code = ?');
  const insSignal = d.prepare(`
    INSERT OR IGNORE INTO signals
      (client_id, trigger_type_id, title_he, summary_he, evidence_quote, evidence_url,
       evidence_source, evidence_date, strength, sentiment, fingerprint, run_id, origin)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'research')`);

  let saved = 0, skipped = 0;
  for (const s of data.signals ?? []) {
    if (!s.evidence_url || !s.title_he) { skipped++; continue; }
    const trig = getTrig.get(s.trigger_code);
    const fp = fingerprint(client.id, s.trigger_code, s.title_he, s.evidence_url);
    const sentiment = ['positive', 'neutral', 'negative'].includes(s.sentiment) ? s.sentiment : 'neutral';
    const r = insSignal.run(
      client.id, trig?.id ?? null, s.title_he, s.summary_he || null, s.evidence_quote || null,
      s.evidence_url, s.evidence_source || null, isoDate(s.evidence_date),
      Math.max(0, Math.min(1, s.strength ?? 0.5)), sentiment, fp, runId);
    saved += r.changes;
  }

  // ── העשרת פרופיל הלקוח (לא דורס ערכים שהוזנו ידנית) ─────────────────
  const p = data.profile ?? {};
  const before = d.prepare('SELECT * FROM clients WHERE id = ?').get(client.id);
  d.prepare(`
    UPDATE clients
       SET industry   = CASE WHEN origin = 'manual' THEN industry ELSE COALESCE(NULLIF(?, ''), industry) END,
           is_public  = CASE WHEN origin = 'manual' THEN is_public ELSE ? END,
           ticker     = CASE WHEN origin = 'manual' THEN ticker ELSE COALESCE(NULLIF(?, ''), ticker) END,
           exchange   = CASE WHEN origin = 'manual' THEN exchange ELSE COALESCE(NULLIF(?, ''), exchange) END,
           size_band  = CASE WHEN origin = 'manual' THEN size_band ELSE COALESCE(NULLIF(?, ''), size_band) END,
           notes      = COALESCE(NULLIF(?, ''), notes),
           last_researched_at = datetime('now'),
           updated_at = datetime('now')
     WHERE id = ?`)
    .run(p.industry ?? '', p.is_public ? 1 : (before.is_public ?? 0), p.ticker ?? '',
         p.exchange ?? '', p.size_band ?? '', p.summary_he ?? '', client.id);

  log.ok(`  ${client.name_he}: ${saved} אותות חדשים (${data.signals?.length ?? 0} נמצאו, ${skipped} ללא מקור)` +
         (known.length ? ` | עובד עם: ${known.join(', ')}` : ''));
  return { signals: saved, found: data.signals?.length ?? 0, sources: research.sources.length };
}

// ═══════════════════════════════════════════════════════════════════════
//  מחקר על קבוצת לקוחות
// ═══════════════════════════════════════════════════════════════════════
export async function researchClients({ clientIds = null, triggerMode = 'manual',
                                        monthsBack = 12, staleDays = null, limit = null } = {}) {
  const log = createLogger('');
  const usage = newUsage();
  const runId = startRun('research', { triggerMode, scope: { clientIds, monthsBack, staleDays }, model: process.env.AMAN_MODEL });
  const result = { researched: 0, signals: 0, errors: [] };

  try {
    if (!hasApiKey()) throw new Error('המחקר דורש מפתח Claude API. הגדירו ANTHROPIC_API_KEY בקובץ .env');
    const d = db();

    let clients;
    if (clientIds?.length) {
      clients = d.prepare(`SELECT * FROM clients WHERE id IN (${clientIds.map(() => '?').join(',')})`).all(...clientIds);
    } else if (staleDays) {
      clients = d.prepare(`SELECT * FROM clients
                            WHERE last_researched_at IS NULL
                               OR last_researched_at < datetime('now', ?)
                            ORDER BY last_researched_at IS NOT NULL, last_researched_at`)
        .all(`-${staleDays} days`);
    } else {
      clients = d.prepare('SELECT * FROM clients ORDER BY name_he').all();
    }
    if (limit) clients = clients.slice(0, limit);

    log.info(`מחקר על ${clients.length} לקוחות (${monthsBack} חודשים אחורה)`);

    for (const c of clients) {
      try {
        const r = await researchOne(c, { log, usage, monthsBack, runId });
        result.researched++;
        result.signals += r.signals;
      } catch (err) {
        result.errors.push(`${c.name_he}: ${err.message}`);
        log.warn(`  ${c.name_he}: ${err.message}`);
      }
    }

    log.ok(`סיום מחקר: ${result.researched} לקוחות, ${result.signals} אותות חדשים ` +
           `(${usage.calls} קריאות, ${usage.tokens_in + usage.tokens_out} טוקנים)`);
    audit('research', runId, 'bulk_import', null, result, 'research');
    finishRun(runId, {
      status: result.errors.length ? (result.researched ? 'partial' : 'failed') : 'ok',
      itemsIn: clients.length, itemsOut: result.signals,
      tokensIn: usage.tokens_in, tokensOut: usage.tokens_out,
      log: log.text(), error: result.errors.join('; ') || null,
    });
    return { runId, ...result, usage, log: log.text() };
  } catch (err) {
    log.error(err.message);
    finishRun(runId, { status: 'failed', tokensIn: usage.tokens_in, tokensOut: usage.tokens_out,
                       log: log.text(), error: err.message });
    throw Object.assign(err, { runId, log: log.text() });
  }
}
