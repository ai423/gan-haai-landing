/**
 * אותות הדגמה — כדי לראות את המנוע והדוח עובדים בלי מפתח API ובלי לחכות למחקר.
 *
 * ⚠️ הנתונים כאן **מומצאים לצורך הדגמה בלבד** ומסומנים ככאלה:
 *    כל כותרת מתחילה ב-"[הדגמה]" והמקור הוא "נתוני הדגמה" ללא קישור אמיתי.
 *    להסרה: `npm run demo:clear`
 */
import 'dotenv/config';
import { db } from './index.js';

const today = new Date();
const daysAgo = (n) => new Date(today.getTime() - n * 86400000).toISOString().slice(0, 10);

const DEMO = [
  ['bank-hapoalim',  'ai_initiative',           'הבנק מכריז על תוכנית AI רחבה לשירות לקוחות', 0.85, daysAgo(25)],
  ['bank-hapoalim',  'regulatory_pressure',     'דרישת רגולציה חדשה לניהול ותיעוד נתוני לקוח',  0.75, daysAgo(60)],
  ['shufersal',      'cyber_incident',          'אירוע אבטחת מידע בשרשרת האספקה של הרשת',      0.9,  daysAgo(18)],
  ['shufersal',      'cost_efficiency',         'תוכנית התייעלות רב-שנתית והפחתת עלויות תפעול', 0.7,  daysAgo(45)],
  ['cellcom',        'core_system_replacement', 'החלטה על החלפת מערכת ה-CRM הארגונית',         0.85, daysAgo(30)],
  ['cellcom',        'service_crisis',          'גל תלונות על זמני המתנה במוקד השירות',         0.7,  daysAgo(50)],
  ['clal-insurance', 'digital_transformation',  'תוכנית טרנספורמציה דיגיטלית תלת-שנתית',        0.8,  daysAgo(40)],
  ['ceva',           'funding_round',           'גיוס הון להאצת פיתוח דור השבבים הבא',          0.8,  daysAgo(35)],
  ['valens',         'hiring_surge_it',         'עשרות משרות VLSI פתוחות באתר החברה',           0.65, daysAgo(20)],
  ['ikea-israel',    'market_expansion',        'פתיחת מרכז לוגיסטי חדש והתרחבות פריסה',        0.75, daysAgo(28)],
  ['paz-yellow',     'new_digital_product',     'השקת אפליקציה ואזור אישי מחודשים',             0.7,  daysAgo(22)],
  ['bank-discount',  'exec_appointment',        'מינוי סמנכ"ל טכנולוגיות חדש',                  0.8,  daysAgo(15)],
];

export function loadDemoSignals() {
  const d = db();
  let n = 0;
  d.transaction(() => {
    for (const [clientSlug, code, title, strength, date] of DEMO) {
      const c = d.prepare('SELECT id FROM clients WHERE slug = ?').get(clientSlug);
      const t = d.prepare('SELECT id FROM trigger_types WHERE code = ?').get(code);
      if (!c || !t) continue;
      n += d.prepare(`
        INSERT OR IGNORE INTO signals
          (client_id, trigger_type_id, title_he, summary_he, evidence_quote, evidence_url,
           evidence_source, evidence_date, strength, sentiment, fingerprint, origin)
        VALUES (?, ?, ?, ?, NULL, NULL, 'נתוני הדגמה', ?, ?, 'neutral', ?, 'seed')`)
        .run(c.id, t.id, `[הדגמה] ${title}`,
             'רשומת הדגמה לבדיקת מנוע ההצלבה. אינה מבוססת על מקור אמיתי.',
             date, strength, `demo-${clientSlug}-${code}`).changes;
    }
  })();
  return n;
}

export function clearDemoSignals() {
  const d = db();
  const ids = d.prepare(`SELECT id FROM signals WHERE fingerprint LIKE 'demo-%'`).all().map((r) => r.id);
  if (!ids.length) return 0;
  d.transaction(() => {
    d.prepare(`DELETE FROM opportunities WHERE signal_id IN (${ids.map(() => '?').join(',')})`).run(...ids);
    d.prepare(`DELETE FROM signals WHERE fingerprint LIKE 'demo-%'`).run();
  })();
  return ids.length;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (process.argv.includes('--clear')) {
    console.log(`✓ הוסרו ${clearDemoSignals()} אותות הדגמה`);
  } else {
    console.log(`✓ נוספו ${loadDemoSignals()} אותות הדגמה (מסומנים ב-"[הדגמה]")`);
  }
}
