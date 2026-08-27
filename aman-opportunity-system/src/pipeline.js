import { startRun, finishRun } from './db/index.js';
import { createLogger } from './lib/logger.js';
import { researchClients } from './research/clientResearch.js';
import { runMatching } from './engine/matcher.js';
import { generateCeoReport } from './engine/report.js';

/**
 * הצינור החודשי המלא: מחקר על לקוחות → הצלבה → סיכום למנכ"ל.
 * זהו מה שרץ בתזמון, וגם מה שכפתור "הרץ עכשיו" מפעיל.
 */
export async function runPipeline({ triggerMode = 'manual', staleDays = 25, monthsBack = 12,
                                    limit = null, clientIds = null, skipResearch = false } = {}) {
  const log = createLogger('');
  const runId = startRun('pipeline', { triggerMode, scope: { staleDays, monthsBack, limit, clientIds } });
  const out = { research: null, match: null, report: null, errors: [] };

  try {
    if (!skipResearch) {
      log.info('שלב 1/3 — מחקר על לקוחות');
      try {
        out.research = await researchClients({ triggerMode, staleDays, monthsBack, limit, clientIds });
      } catch (err) {
        out.errors.push(`מחקר: ${err.message}`);
        log.warn(`המחקר נכשל (${err.message}) — ממשיכים עם האותות הקיימים`);
      }
    } else {
      log.info('שלב 1/3 — מחקר דולג לפי בקשה');
    }

    log.info('שלב 2/3 — הצלבה וייצור הזדמנויות');
    out.match = runMatching({ triggerMode });

    log.info('שלב 3/3 — סיכום למנכ"ל');
    out.report = await generateCeoReport({ triggerMode });

    const status = out.errors.length ? 'partial' : 'ok';
    log.ok(`הצינור הושלם: ${out.match.created + out.match.updated} הזדמנויות, דוח #${out.report.reportId}`);
    finishRun(runId, { status, itemsOut: out.match.created + out.match.updated,
                       log: log.text(), error: out.errors.join('; ') || null });
    return { runId, status, ...out, log: log.text() };
  } catch (err) {
    log.error(err.message);
    finishRun(runId, { status: 'failed', log: log.text(), error: err.message });
    throw Object.assign(err, { runId, log: log.text() });
  }
}
