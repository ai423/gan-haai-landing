import crypto from 'node:crypto';

/**
 * הגנת סיסמה בסיסית (HTTP Basic Auth).
 * מופעלת רק אם הוגדר APP_PASSWORD — כך שהרצה מקומית נשארת נוחה,
 * אבל פריסה לכתובת ציבורית בלי סיסמה נעצרת בעליית השרת.
 */
const USER = process.env.APP_USER || 'aman';
const PASSWORD = process.env.APP_PASSWORD || '';

/** השוואה בזמן קבוע — מונעת דליפת מידע דרך מדידת זמן. */
function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

export const authEnabled = () => PASSWORD.length > 0;

export function requireAuth(req, res, next) {
  if (!authEnabled()) return next();

  const header = req.headers.authorization ?? '';
  const [scheme, encoded] = header.split(' ');
  if (scheme === 'Basic' && encoded) {
    const [user, ...passParts] = Buffer.from(encoded, 'base64').toString('utf8').split(':');
    if (safeEqual(user, USER) && safeEqual(passParts.join(':'), PASSWORD)) return next();
  }

  res.set('WWW-Authenticate', 'Basic realm="Aman Opportunity System", charset="UTF-8"');
  res.status(401).type('text/html; charset=utf-8')
     .send('<html lang="he" dir="rtl"><body style="font-family:sans-serif;padding:40px">' +
           '<h1>נדרשת הזדהות</h1><p>המערכת מוגנת בסיסמה.</p></body></html>');
}

/**
 * בדיקת שפיות בעלייה: אם השרת חשוף לרשת ואין סיסמה — נעצרים.
 * ניתן לעקוף במפורש עם ALLOW_NO_AUTH=true (למשל מאחורי VPN של הארגון).
 */
export function assertAuthConfigured() {
  const isLocal = ['localhost', '127.0.0.1'].includes(process.env.HOST ?? 'localhost')
    && !process.env.VERCEL && !process.env.RAILWAY_ENVIRONMENT && !process.env.RENDER
    && !process.env.FLY_APP_NAME && process.env.NODE_ENV !== 'production';

  if (authEnabled() || isLocal) return;
  if ((process.env.ALLOW_NO_AUTH ?? '') === 'true') {
    console.warn('⚠  המערכת רצה ללא סיסמה (ALLOW_NO_AUTH=true). ודאו שהיא מאחורי רשת פנימית.');
    return;
  }
  console.error('');
  console.error('✗ סירוב לעלות: המערכת נפרסת לסביבת ייצור בלי סיסמה.');
  console.error('  המאגר מכיל את רשימת הלקוחות של הקבוצה, וכל מבקר יוכל לשרוף את מכסת ה-API.');
  console.error('  הגדירו APP_PASSWORD במשתני הסביבה של הפלטפורמה, או ALLOW_NO_AUTH=true');
  console.error('  אם המערכת כבר מוגנת ברשת פנימית.');
  console.error('');
  process.exit(1);
}
