import cron from 'node-cron';
import { runPipeline } from './pipeline.js';
import { reapStaleRuns } from './db/index.js';

const EXPR = process.env.RESEARCH_CRON || '0 3 1 * *';   // ה-1 בכל חודש, 03:00
const TZ = process.env.TZ || 'Asia/Jerusalem';

let task = null;
let state = { enabled: false, expression: EXPR, timezone: TZ, lastRun: null, lastStatus: null, running: false };

export function schedulerState() {
  return { ...state, nextRun: task ? describeNext() : null };
}

/** node-cron לא חושף "מתי הריצה הבאה", לכן מציגים את הביטוי בלבד. */
function describeNext() {
  return `לפי הביטוי «${state.expression}» (אזור זמן ${state.timezone})`;
}

async function fire() {
  if (state.running) { console.log('⚠ הרצה מתוזמנת דולגה — הרצה קודמת עדיין פעילה'); return; }
  state.running = true;
  console.log(`▶ הרצה חודשית מתוזמנת מתחילה (${new Date().toISOString()})`);
  try {
    const r = await runPipeline({ triggerMode: 'scheduled', staleDays: 25 });
    state.lastStatus = r.status;
    console.log(`✓ ההרצה החודשית הסתיימה (${r.status})`);
  } catch (err) {
    state.lastStatus = 'failed';
    console.error(`✗ ההרצה החודשית נכשלה: ${err.message}`);
  } finally {
    state.lastRun = new Date().toISOString();
    state.running = false;
  }
}

export function startScheduler() {
  if (task) return schedulerState();
  if (!cron.validate(EXPR)) {
    console.error(`✗ ביטוי cron לא תקין: "${EXPR}" — התזמון לא הופעל`);
    return schedulerState();
  }
  reapStaleRuns();
  task = cron.schedule(EXPR, fire, { scheduled: true, timezone: TZ });
  state.enabled = true;
  console.log(`⏱  תזמון חודשי פעיל: ${EXPR} (${TZ})`);
  return schedulerState();
}

export function stopScheduler() {
  task?.stop();
  task = null;
  state.enabled = false;
  return schedulerState();
}

/** הרצה ידנית מיידית של אותו צינור שהתזמון מריץ. */
export function triggerNow(opts = {}) {
  return runPipeline({ triggerMode: 'manual', ...opts });
}
