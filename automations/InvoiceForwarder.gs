/**
 * העברת חשבוניות אוטומטית להנהלת חשבונות
 * ------------------------------------------------
 * סורק את התיבה פעם ביום, מאתר חשבוניות הוצאה שהתקבלו מספקים,
 * מעביר אותן להנהלת החשבונות, ושולח מייל סיכום.
 *
 * הסקריפט רץ בתוך התיבה שבה הוא מותקן ואינו נוגע בתיבות אחרות.
 * מתקינים אותו בנפרד בכל תיבה שרוצים לכסות.
 *
 * התקנה:
 *   1. היכנס ל-script.google.com עם החשבון של התיבה
 *   2. פרויקט חדש → הדבק את הקובץ הזה
 *   3. הרץ את setup() פעם אחת — יאשר הרשאות ויתקין טריגר יומי
 *
 * מומלץ להשאיר DRY_RUN=true בהרצה הראשונה, לבדוק את מייל הסיכום,
 * ורק אז להעביר ל-false.
 */

const CONFIG = {
  // כתובת הנהלת החשבונות
  BOOKKEEPER: 'maven381604392@invoice-maven.com',

  // לאן לשלוח את הסיכום. ריק = בעל התיבה עצמו
  SUMMARY_TO: '',

  // false = שולח סיכום רק כשיש מה לדווח
  SUMMARY_WHEN_EMPTY: false,

  // כמה ימים אחורה לסרוק. חלון רחב מריצה אחת, כדי שריצה
  // שהוחמצה תשלים את עצמה. כפילויות נמנעות בנפרד.
  LOOKBACK_DAYS: 4,

  // שעת הריצה היומית (שעון מקומי של החשבון)
  RUN_HOUR: 8,

  // true = מדווח מה היה עושה בלי להעביר בפועל
  DRY_RUN: true,

  LABEL_DONE: 'חשבוניות/הועבר',
  LABEL_REVIEW: 'חשבוניות/לבדיקה',
};

/** ספקים מוכרים — חשבונית מהם עוברת אוטומטית */
const KNOWN_SUPPLIERS = [
  'payments-noreply@google.com',
  'accounting@finbot.co.il',
  '@ampa.co.il',
  'billing.no-reply@wework.co.il',
  'invoice-maven.co.il',
  'notify@morning.co',
  'info@sabonmichal.co.il',
  'out.cardcom.co.il',
  'invoice+statements@mail.anthropic.com',
  'invoice+statements@vercel.com',
];

/** שולחים שלעולם לא מעבירים — תשלומים פרטיים */
const EXCLUDED_SENDERS = [
  'metro-mail.co.il',   // ParentPay — תשלומי בית ספר
];

/** מסמך שנראה כמו חשבונית */
const INVOICE_TERMS = /חשבונית|קבלה|מסמך ממוחשב|חתום דיגיטלית|אישור תשלום|דרישת תשלום|invoice|receipt|billing/i;

/**
 * מסמכים שאינם חשבונית ולכן לא מעבירים.
 * "אישור קבלת" / "נקלטו" מסננים את הודעות אישור הקליטה של מייבן —
 * הן מגיעות מספק מוכר ומזכירות מסמכי הוצאות, אבל הן דיווח על קליטה
 * ולא חשבונית, והחזרתן למייבן היא רעש.
 */
const NOT_INVOICE_TERMS = /הצעת מחיר|הצעה מספר|quote|proposal|estimate|טיוטה|אישור קבלת|נקלטו/i;

/** חשבונית יוצאת שהעסק הנפיק ללקוח — כבר קיימת במערכת ההנפקה */
const OUTGOING_INVOICE = /מ-\s*גורדון יזמות|מ-\s*Gr8Minds/i;


/** מתקין את הטריגר היומי. להריץ פעם אחת. */
function setup() {
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'forwardInvoices')
    .forEach(t => ScriptApp.deleteTrigger(t));

  ScriptApp.newTrigger('forwardInvoices')
    .timeBased()
    .atHour(CONFIG.RUN_HOUR)
    .everyDays(1)
    .create();

  const mode = CONFIG.DRY_RUN ? 'DRY RUN — לא יעביר בפועל' : 'פעיל';
  Logger.log(`הותקן טריגר יומי בשעה ${CONFIG.RUN_HOUR}:00 עבור ${me_()} (${mode})`);
}


/** הפונקציה הראשית — זו שהטריגר מריץ */
function forwardInvoices() {
  const query = [
    `newer_than:${CONFIG.LOOKBACK_DAYS}d`,
    '-in:sent -in:draft -in:trash -in:spam',
    '(חשבונית OR קבלה OR invoice OR receipt OR "מסמך ממוחשב"',
    'OR "חתום דיגיטלית" OR billing OR "אישור תשלום")',
  ].join(' ');

  const doneLabel = getOrCreateLabel_(CONFIG.LABEL_DONE);
  const reviewLabel = getOrCreateLabel_(CONFIG.LABEL_REVIEW);

  const forwarded = [];
  const review = [];

  for (const thread of GmailApp.search(query, 0, 100)) {
    if (hasLabel_(thread, CONFIG.LABEL_DONE) || hasLabel_(thread, CONFIG.LABEL_REVIEW)) continue;
    if (alreadyForwarded_(thread)) continue;

    const message = firstIncoming_(thread);
    if (!message) continue;

    const item = {
      from: message.getFrom(),
      subject: message.getSubject() || '(ללא נושא)',
      date: Utilities.formatDate(message.getDate(), Session.getScriptTimeZone(), 'dd/MM/yyyy'),
    };

    switch (classify_(message)) {
      case 'forward':
        if (!CONFIG.DRY_RUN) {
          message.forward(CONFIG.BOOKKEEPER);
          thread.addLabel(doneLabel);
        }
        forwarded.push(item);
        break;

      case 'review':
        if (!CONFIG.DRY_RUN) thread.addLabel(reviewLabel);
        review.push(item);
        break;
    }
  }

  sendSummary_(forwarded, review);
}


/**
 * מחליט מה לעשות עם הודעה.
 * מחזיר 'forward', 'review' או 'skip'.
 */
function classify_(message) {
  const from = message.getFrom().toLowerCase();
  const subject = message.getSubject() || '';
  const body = message.getPlainBody().slice(0, 2000);
  const text = subject + '\n' + body;

  if (EXCLUDED_SENDERS.some(s => from.includes(s))) return 'skip';
  if (NOT_INVOICE_TERMS.test(subject)) return 'skip';
  if (OUTGOING_INVOICE.test(subject)) return 'skip';
  if (!INVOICE_TERMS.test(text)) return 'skip';

  // ספק מוכר — מעבירים. אחרת מסמנים לבדיקה ידנית,
  // כדי שספק חדש ייקלט בלי להעביר משהו שגוי אוטומטית.
  return KNOWN_SUPPLIERS.some(s => from.includes(s)) ? 'forward' : 'review';
}


/**
 * האם השרשור כבר נשלח להנהלת החשבונות.
 * מכסה גם העברות ידניות שנעשו בעבר, ולכן אין צורך
 * לתייג רטרואקטיבית שום דבר לפני ההפעלה הראשונה.
 */
function alreadyForwarded_(thread) {
  const bookkeeper = CONFIG.BOOKKEEPER.toLowerCase();
  return thread.getMessages().some(m =>
    (m.getTo() + ' ' + m.getCc() + ' ' + m.getBcc()).toLowerCase().includes(bookkeeper)
  );
}


/** ההודעה המקורית מהספק — לא תשובה ולא הודעה שנשלחה מהתיבה */
function firstIncoming_(thread) {
  const self = me_().toLowerCase();
  return thread.getMessages().find(m => !m.getFrom().toLowerCase().includes(self)) || null;
}


function sendSummary_(forwarded, review) {
  if (!forwarded.length && !review.length && !CONFIG.SUMMARY_WHEN_EMPTY) return;

  const today = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'dd/MM/yyyy');
  const lines = [];

  if (CONFIG.DRY_RUN) {
    lines.push('*** מצב בדיקה — לא בוצעה העברה בפועל ***', '');
  }

  if (forwarded.length) {
    lines.push(`הועברו להנהלת החשבונות (${forwarded.length}):`, '');
    forwarded.forEach((it, i) => lines.push(`${i + 1}. ${it.subject}`, `   מאת ${it.from} · ${it.date}`, ''));
  }

  if (review.length) {
    lines.push(`לבדיקה — ספק לא מוכר, לא הועבר (${review.length}):`, '');
    review.forEach((it, i) => lines.push(`${i + 1}. ${it.subject}`, `   מאת ${it.from} · ${it.date}`, ''));
    lines.push('הפריטים האלה מתויגים ב-' + CONFIG.LABEL_REVIEW + '.');
    lines.push('כדי שספק ייקלט אוטומטית בעתיד, הוסף את כתובתו ל-KNOWN_SUPPLIERS בסקריפט.', '');
  }

  if (!forwarded.length && !review.length) {
    lines.push('לא נמצאו חשבוניות חדשות להעברה.');
  }

  GmailApp.sendEmail(
    CONFIG.SUMMARY_TO || me_(),
    `סיכום העברת חשבוניות — ${today}`,
    lines.join('\n')
  );
}


function getOrCreateLabel_(name) {
  return GmailApp.getUserLabelByName(name) || GmailApp.createLabel(name);
}

function hasLabel_(thread, name) {
  return thread.getLabels().some(l => l.getName() === name);
}

function me_() {
  return Session.getEffectiveUser().getEmail();
}
