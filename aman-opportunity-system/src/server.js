import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { router } from './routes/api.js';
import { db, reapStaleRuns } from './db/index.js';
import { seed } from './db/seed.js';
import { startScheduler } from './scheduler.js';
import { hasApiKey, MODEL } from './lib/claude.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = Number(process.env.PORT || 3000);

app.use(express.json({ limit: '5mb' }));
app.use('/api', router);
app.use(express.static(path.join(here, '..', 'public')));

// כל נתיב שאינו API מוגש על ידי ה-SPA
app.get(/^(?!\/api).*/, (req, res) => res.sendFile(path.join(here, '..', 'public', 'index.html')));

app.use((err, req, res, _next) => {
  console.error('[server]', err);
  res.status(500).json({ ok: false, error: err.message ?? 'שגיאת שרת' });
});

// ── עלייה ────────────────────────────────────────────────────────────────
db();                                   // יוצר סכימה אם צריך
const empty = db().prepare('SELECT COUNT(*) n FROM subsidiaries').get().n === 0;
if (empty) {
  console.log('בסיס נתונים ריק — מריץ זריעה ראשונית');
  seed({ verbose: false });
}
reapStaleRuns();

app.listen(PORT, () => {
  console.log('');
  console.log('  מערכת ההזדמנויות של קבוצת אמן');
  console.log(`  ▸ ממשק:  http://localhost:${PORT}`);
  console.log(`  ▸ מודל:  ${MODEL}`);
  console.log(`  ▸ מפתח Claude API: ${hasApiKey() ? 'מוגדר ✓' : 'חסר ✗ — סריקה ומחקר לא יעבדו'}`);
  if ((process.env.ENABLE_SCHEDULER ?? 'true') !== 'false') startScheduler();
  else console.log('  ⏱  התזמון האוטומטי כבוי (ENABLE_SCHEDULER=false)');
  console.log('');
});
