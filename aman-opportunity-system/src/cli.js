#!/usr/bin/env node
import 'dotenv/config';
import { scrapeGroup } from './scrapers/amanGroup.js';
import { scrapeClients } from './scrapers/clients.js';
import { researchClients } from './research/clientResearch.js';
import { runMatching } from './engine/matcher.js';
import { generateCeoReport } from './engine/report.js';
import { runPipeline } from './pipeline.js';

const [, , command, ...rest] = process.argv;

/** --key=value → {key: value} */
const flags = Object.fromEntries(rest
  .filter((a) => a.startsWith('--'))
  .map((a) => { const [k, v = 'true'] = a.slice(2).split('='); return [k, v]; }));
const num = (v) => (v === undefined ? undefined : Number(v));
const ids = (v) => (v ? String(v).split(',').map(Number).filter(Boolean) : null);

const HELP = `
מערכת ההזדמנויות של קבוצת אמן — שורת פקודה

  npm run scrape:group                     סריקת אתר הקבוצה → חברות בת + שירותים
  npm run scrape:clients                   סריקת אתרי חברות הבת → לקוחות
  npm run research                         מחקר ווב על לקוחות → אותות רכישה
  npm run match                            הצלבה → הזדמנויות מדורגות
  npm run report                           סיכום למנכ"ל
  npm run pipeline                         מחקר + הצלבה + דוח (מה שרץ בתזמון)

דגלים נפוצים:
  --clients=1,2,3     הגבלה ללקוחות מסוימים (מזהים)
  --subsidiaries=1,2  הגבלה לחברות בת מסוימות (בסריקת לקוחות)
  --limit=5           מספר מקסימלי של לקוחות למחקר
  --stale=25          לחקור רק לקוחות שלא נחקרו N ימים
  --months=12         כמה חודשים אחורה לחפש
  --min-score=40      סף ציון לדוח
  --no-ai             דוח דטרמיניסטי בלבד, בלי Claude
  --skip-research     בצינור: לדלג על שלב המחקר
`;

try {
  switch (command) {
    case 'scrape-group':
      await scrapeGroup({ includeServices: flags['no-services'] !== 'true' });
      break;
    case 'scrape-clients':
      await scrapeClients({ subsidiaryIds: ids(flags.subsidiaries) });
      break;
    case 'research':
      await researchClients({
        clientIds: ids(flags.clients),
        limit: num(flags.limit),
        staleDays: num(flags.stale),
        monthsBack: num(flags.months) ?? 12,
      });
      break;
    case 'match':
      runMatching({ minScore: num(flags['min-score']) ?? 12 });
      break;
    case 'report':
      console.log('\n' + (await generateCeoReport({
        minScore: num(flags['min-score']) ?? 40,
        useAi: flags['no-ai'] !== 'true',
      })).content);
      break;
    case 'pipeline':
      await runPipeline({
        staleDays: num(flags.stale) ?? 25,
        monthsBack: num(flags.months) ?? 12,
        limit: num(flags.limit),
        clientIds: ids(flags.clients),
        skipResearch: flags['skip-research'] === 'true',
      });
      break;
    default:
      console.log(HELP);
      process.exit(command ? 1 : 0);
  }
  process.exit(0);
} catch (err) {
  console.error(`\n✗ ${err.message}`);
  process.exit(1);
}
