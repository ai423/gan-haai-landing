import { db, fromJson, toJson, startRun, finishRun } from '../db/index.js';
import { createLogger } from '../lib/logger.js';
import { complete, hasApiKey, newUsage, addUsage, MODEL } from '../lib/claude.js';

const HE_MONTHS = ['ינואר','פברואר','מרץ','אפריל','מאי','יוני','יולי','אוגוסט','ספטמבר','אוקטובר','נובמבר','דצמבר'];
const periodLabel = (d = new Date()) => `${HE_MONTHS[d.getMonth()]} ${d.getFullYear()}`;

/** אוסף את כל מה שצריך לדוח — נתונים בלבד, בלי פרשנות. */
export function collectReportData({ topN = 20, minScore = 40 } = {}) {
  const d = db();

  const opportunities = d.prepare(`
    SELECT o.*, c.name_he AS client_name, c.industry, c.is_public, c.ticker,
           s.name_he AS subsidiary_name, v.name_he AS service_name
      FROM opportunities o
      JOIN clients c ON c.id = o.client_id
      JOIN subsidiaries s ON s.id = o.subsidiary_id
      LEFT JOIN services v ON v.id = o.service_id
     WHERE o.score >= ? AND o.status NOT IN ('dismissed','lost')
     ORDER BY o.score DESC LIMIT ?`).all(minScore, topN)
    .map((o) => ({ ...o, evidence: fromJson(o.evidence, []), warm_intro_via: fromJson(o.warm_intro_via, []) }));

  const shared = d.prepare('SELECT * FROM v_shared_clients ORDER BY subsidiary_count DESC LIMIT 25').all();

  const whitespace = d.prepare(`
    SELECT w.client_name, w.subsidiary_name,
           (SELECT COUNT(*) FROM signals g WHERE g.client_id = w.client_id AND g.status != 'dismissed') AS signal_count
      FROM v_whitespace w
     WHERE signal_count > 0
     ORDER BY signal_count DESC LIMIT 25`).all();

  const freshSignals = d.prepare(`
    SELECT g.title_he, g.summary_he, g.evidence_url, g.evidence_source, g.evidence_date,
           g.strength, c.name_he AS client_name, tt.name_he AS trigger_name
      FROM signals g JOIN clients c ON c.id = g.client_id
      LEFT JOIN trigger_types tt ON tt.id = g.trigger_type_id
     WHERE g.status != 'dismissed' AND g.detected_at > datetime('now','-35 days')
     ORDER BY g.strength DESC LIMIT 30`).all();

  const totals = {
    clients: d.prepare('SELECT COUNT(*) n FROM clients').get().n,
    subsidiaries: d.prepare(`SELECT COUNT(*) n FROM subsidiaries WHERE status = 'active'`).get().n,
    sharedClients: d.prepare('SELECT COUNT(*) n FROM v_shared_clients').get().n,
    signals: d.prepare(`SELECT COUNT(*) n FROM signals WHERE status != 'dismissed'`).get().n,
    opportunities: d.prepare(`SELECT COUNT(*) n FROM opportunities WHERE status NOT IN ('dismissed','lost')`).get().n,
    hot: d.prepare(`SELECT COUNT(*) n FROM opportunities WHERE score >= 65 AND status NOT IN ('dismissed','lost')`).get().n,
    avgSubsPerClient: d.prepare(`
      SELECT ROUND(AVG(k), 2) v FROM (
        SELECT COUNT(DISTINCT subsidiary_id) k FROM client_subsidiary GROUP BY client_id)`).get().v ?? 0,
    pipelineBySubsidiary: d.prepare(`
      SELECT s.name_he AS subsidiary, COUNT(o.id) n, ROUND(MAX(o.score),1) top_score
        FROM subsidiaries s JOIN opportunities o ON o.subsidiary_id = s.id
       WHERE o.status NOT IN ('dismissed','lost')
       GROUP BY s.id ORDER BY n DESC`).all(),
  };

  return { opportunities, shared, whitespace, freshSignals, totals };
}

// ── דוח דטרמיניסטי (עובד גם בלי מפתח API) ───────────────────────────────
export function buildDeterministicReport(data, label) {
  const { opportunities, shared, whitespace, totals } = data;
  const L = [];
  L.push(`# סיכום הזדמנויות חוצות-קבוצה — ${label}`);
  L.push('');
  L.push(`נכון ל-${new Date().toLocaleDateString('he-IL')}. הדוח נבנה אוטומטית ממאגר הלקוחות, האותות שנאספו מהרשת ומנוע ההצלבה.`);
  L.push('');
  L.push('## תמונת מצב');
  L.push('');
  L.push(`- **${totals.clients}** לקוחות במאגר, פרושים על **${totals.subsidiaries}** חברות בת פעילות.`);
  L.push(totals.sharedClients === 1
    ? `- **לקוח אחד** כבר עובד עם יותר מחברת בת אחת. ממוצע חברות בת ללקוח: **${totals.avgSubsPerClient}**.`
    : `- **${totals.sharedClients}** לקוחות כבר עובדים עם יותר מחברת בת אחת. ממוצע חברות בת ללקוח: **${totals.avgSubsPerClient}**.`);
  L.push(`- **${totals.signals}** אותות רכישה מתועדים, שהניבו **${totals.opportunities}** הזדמנויות — מתוכן **${totals.hot}** בציון 65+.`);
  L.push('');

  if (opportunities.length) {
    L.push('## ההזדמנויות המובילות');
    L.push('');
    opportunities.forEach((o, i) => {
      L.push(`### ${i + 1}. ${o.subsidiary_name} → ${o.client_name} · ציון ${Math.round(o.score)}`);
      L.push('');
      L.push(o.rationale_he);
      if (o.warm_intro_via?.length) {
        L.push('');
        L.push(`**דלת פתוחה:** הקבוצה כבר בפנים דרך ${o.warm_intro_via.join(', ')}.`);
      }
      if (o.evidence?.length) {
        L.push('');
        L.push('**ראיות:**');
        for (const e of o.evidence) {
          const q = e.quote ? ` — "${e.quote}"` : '';
          const label = `${e.source ?? 'מקור'}${e.date ? ', ' + e.date : ''}`;
          const cite = e.url ? `[${label}](${e.url})` : `_${label}, ללא קישור_`;
          L.push(`- ${e.title}${q} (${cite})`);
        }
      }
      L.push('');
    });
  } else {
    L.push('## ההזדמנויות המובילות');
    L.push('');
    L.push('_לא נמצאו הזדמנויות מעל סף הציון. הריצו מחקר (`npm run research`) כדי לאסוף אותות._');
    L.push('');
  }

  if (shared.length) {
    L.push('## לקוחות משותפים לכמה חברות בת');
    L.push('');
    L.push('| לקוח | מספר חברות | חברות הבת |');
    L.push('|---|---|---|');
    for (const s of shared) L.push(`| ${s.client_name} | ${s.subsidiary_count} | ${s.subsidiaries} |`);
    L.push('');
  }

  if (whitespace.length) {
    L.push('## שטח לבן — לקוחות קיימים שחברת בת נוספת עוד לא נכנסה אליהם');
    L.push('');
    L.push('| לקוח | חברת בת שטרם נכנסה | אותות פעילים |');
    L.push('|---|---|---|');
    for (const w of whitespace) L.push(`| ${w.client_name} | ${w.subsidiary_name} | ${w.signal_count} |`);
    L.push('');
  }

  if (totals.pipelineBySubsidiary.length) {
    L.push('## פייפליין לפי חברת בת');
    L.push('');
    L.push('| חברת בת | הזדמנויות | ציון מוביל |');
    L.push('|---|---|---|');
    for (const p of totals.pipelineBySubsidiary) L.push(`| ${p.subsidiary} | ${p.n} | ${p.top_score} |`);
    L.push('');
  }

  return L.join('\n');
}

// ═══════════════════════════════════════════════════════════════════════
export async function generateCeoReport({ triggerMode = 'manual', topN = 20, minScore = 40,
                                          useAi = true, title = null } = {}) {
  const log = createLogger('');
  const usage = newUsage();
  const runId = startRun('report', { triggerMode, scope: { topN, minScore } });
  const label = periodLabel();

  try {
    const data = collectReportData({ topN, minScore });
    log.info(`נאספו ${data.opportunities.length} הזדמנויות, ${data.shared.length} לקוחות משותפים, ${data.freshSignals.length} אותות טריים`);

    const deterministic = buildDeterministicReport(data, label);
    let content = deterministic;
    let mode = 'deterministic';

    if (useAi && hasApiKey() && data.opportunities.length) {
      try {
        const { text, message } = await complete({
          system: `אתה יועץ אסטרטגי שכותב למנכ"ל קבוצת IT ישראלית (קבוצת אמן). אתה כותב בעברית עסקית, ישירה וקצרה.
כללי ברזל:
- כל טענה חייבת להישען על ראיה שסופקה לך, עם קישור. אין לך רשות להוסיף עובדה, מספר, תאריך או שם שלא מופיע בנתונים.
- אתה לא מנפח. אם החומר דל — אתה אומר זאת.
- אתה כותב למנכ"ל: מסקנה קודם, פירוט אחר כך. בלי סיסמאות שיווקיות.`,
          prompt: `כתוב סיכום מנכ"ל בעברית לתקופת ${label}, בפורמט Markdown.

מבנה נדרש:
1. **שורה תחתונה** — 3-5 בולטים: מה ההזדמנויות הגדולות ומה צריך לקרות החודש.
2. **ההזדמנויות המובילות** — לכל אחת פסקה במבנה: חברת הבת X עובדת עם לקוח Y (או: יכולה להיכנס אליו), ואפשר להציע לה גם את שירות Z — כי [האירוע] [קישור למקור]. הוסף מה הצעד המעשי הבא.
3. **לקוחות משותפים ושטח לבן** — היכן הקבוצה כבר בפנים ואיזו חברת בת עוד לא נכנסה, ומה זה שווה.
4. **מה לעשות החודש** — רשימה קצרה של פעולות עם בעלים מוצע (חברת בת) ולקוח.
5. **הסתייגויות** — מה במידע חלש או לא מאומת, ומה צריך לבדוק ידנית.

שמור על קישורים כ-Markdown. אל תמציא כלום מעבר לנתונים שלהלן.

--- נתוני הדוח (JSON) ---
${JSON.stringify({
  totals: data.totals,
  opportunities: data.opportunities.map((o) => ({
    subsidiary: o.subsidiary_name, client: o.client_name, service: o.service_name,
    kind: o.kind, score: Math.round(o.score), industry: o.industry,
    rationale: o.rationale_he, warm_intro_via: o.warm_intro_via, evidence: o.evidence,
  })),
  shared_clients: data.shared,
  whitespace: data.whitespace,
  fresh_signals: data.freshSignals,
}, null, 1)}`,
          maxTokens: 32000,
        });
        addUsage(usage, message);
        if (text && text.length > 200) {
          content = `${text}\n\n---\n\n<details>\n<summary>נספח: הנתונים הגולמיים שמהם נגזר הדוח</summary>\n\n${deterministic}\n\n</details>\n`;
          mode = 'ai';
          log.ok('הדוח נכתב בעזרת Claude');
        } else {
          log.warn('תגובת המודל הייתה קצרה מדי — נשמר הדוח הדטרמיניסטי');
        }
      } catch (err) {
        log.warn(`כתיבה בעזרת AI נכשלה (${err.message}) — נשמר הדוח הדטרמיניסטי`);
      }
    } else if (useAi && !hasApiKey()) {
      log.warn('אין מפתח Claude API — נוצר דוח דטרמיניסטי בלבד');
    }

    const reportTitle = title || `סיכום הזדמנויות למנכ"ל — ${label}`;
    const info = db().prepare(`
      INSERT INTO reports (kind, title, period_label, content_md, meta, run_id)
      VALUES ('ceo_summary', ?, ?, ?, ?, ?)`)
      .run(reportTitle, label, content,
           toJson({ mode, model: mode === 'ai' ? MODEL : null, ...data.totals,
                    opportunities_included: data.opportunities.length, usage }), runId);

    finishRun(runId, { status: 'ok', itemsIn: data.opportunities.length, itemsOut: 1,
                       tokensIn: usage.tokens_in, tokensOut: usage.tokens_out, log: log.text() });
    log.ok(`דוח נשמר (#${info.lastInsertRowid})`);
    return { runId, reportId: info.lastInsertRowid, title: reportTitle, mode, content, log: log.text() };
  } catch (err) {
    log.error(err.message);
    finishRun(runId, { status: 'failed', log: log.text(), error: err.message });
    throw Object.assign(err, { runId, log: log.text() });
  }
}
