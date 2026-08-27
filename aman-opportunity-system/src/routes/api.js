import express from 'express';
import * as repo from '../db/repo.js';
import { db, reapStaleRuns } from '../db/index.js';
import { scrapeGroup } from '../scrapers/amanGroup.js';
import { scrapeClients } from '../scrapers/clients.js';
import { researchClients } from '../research/clientResearch.js';
import { runMatching } from '../engine/matcher.js';
import { generateCeoReport } from '../engine/report.js';
import { runPipeline } from '../pipeline.js';
import { schedulerState, startScheduler, stopScheduler } from '../scheduler.js';
import { hasApiKey, MODEL } from '../lib/claude.js';
import { importClients } from '../lib/import.js';

export const router = express.Router();

// ── עזרים ────────────────────────────────────────────────────────────────
const ok = (res, data) => res.json({ ok: true, data });
const asInt = (v) => (v === undefined || v === '' ? null : Number(v));

/** עוטף handler ומחזיר שגיאה בפורמט אחיד. */
const h = (fn) => async (req, res) => {
  try { await fn(req, res); }
  catch (err) {
    console.error('[api]', err);
    res.status(err.status ?? 400).json({ ok: false, error: err.message || 'שגיאה לא צפויה' });
  }
};

/** בונה נתיבי CRUD סטנדרטיים עבור אוסף. */
function crud(path, collection, { listArgs = () => [] } = {}) {
  router.get(path, h((req, res) => ok(res, collection.list(...listArgs(req)))));
  if (collection.get) router.get(`${path}/:id`, h((req, res) => {
    const row = collection.get(Number(req.params.id));
    if (!row) return res.status(404).json({ ok: false, error: 'לא נמצא' });
    ok(res, row);
  }));
  router.post(path, h((req, res) => ok(res, collection.create(req.body, 'ui'))));
  router.put(`${path}/:id`, h((req, res) => {
    const row = collection.update(Number(req.params.id), req.body, 'ui');
    if (!row) return res.status(404).json({ ok: false, error: 'לא נמצא' });
    ok(res, row);
  }));
  router.delete(`${path}/:id`, h((req, res) => ok(res, { deleted: collection.remove(Number(req.params.id), 'ui') })));
}

// ── מצב ──────────────────────────────────────────────────────────────────
router.get('/stats', h((req, res) => ok(res, repo.dashboardStats())));
router.get('/health', h((req, res) => ok(res, {
  hasApiKey: hasApiKey(), model: MODEL, scheduler: schedulerState(),
  jobs: [...jobs.values()].filter((j) => j.status === 'running').map((j) => j.kind),
})));

// ── CRUD ─────────────────────────────────────────────────────────────────
crud('/subsidiaries', repo.subsidiaries);
crud('/services', repo.services, { listArgs: (req) => [asInt(req.query.subsidiaryId)] });
crud('/clients', repo.clients, {
  listArgs: (req) => [{
    q: req.query.q ?? '',
    subsidiaryId: asInt(req.query.subsidiaryId),
    sharedOnly: req.query.shared === 'true',
    limit: asInt(req.query.limit) ?? 500,
  }],
});
crud('/trigger-types', repo.triggerTypes);
crud('/subsidiary-triggers', repo.subsidiaryTriggers, { listArgs: (req) => [asInt(req.query.subsidiaryId)] });
crud('/signals', repo.signals, {
  listArgs: (req) => [{ clientId: asInt(req.query.clientId), status: req.query.status || null }],
});
crud('/opportunities', repo.opportunities, {
  listArgs: (req) => [{
    status: req.query.status || null,
    subsidiaryId: asInt(req.query.subsidiaryId),
    clientId: asInt(req.query.clientId),
    minScore: asInt(req.query.minScore) ?? 0,
  }],
});

// ── קשרי לקוח ↔ חברת בת ─────────────────────────────────────────────────
router.post('/links', h((req, res) => {
  const { client_id, subsidiary_id } = req.body;
  if (!client_id || !subsidiary_id) throw new Error('נדרשים client_id ו-subsidiary_id');
  ok(res, repo.links.upsert(Number(client_id), Number(subsidiary_id), req.body, 'ui'));
}));
router.delete('/links/:id', h((req, res) => ok(res, { deleted: repo.links.remove(Number(req.params.id), 'ui') })));

// ── מיזוג לקוחות כפולים ─────────────────────────────────────────────────
router.post('/clients/:id/merge', h((req, res) => {
  const { sourceId } = req.body;
  if (!sourceId) throw new Error('נדרש sourceId — הלקוח שיימוזג לתוך הלקוח הנוכחי');
  ok(res, repo.clients.merge(Number(req.params.id), Number(sourceId), 'ui'));
}));

// ── ייבוא מרשימה ────────────────────────────────────────────────────────
router.post('/import/clients', h((req, res) => {
  const { text, subsidiaryId = null, relationship = 'customer', dryRun = false } = req.body;
  if (!text || !String(text).trim()) throw new Error('לא התקבל טקסט לייבוא');
  ok(res, importClients(String(text), { subsidiaryId: asInt(subsidiaryId), relationship, dryRun }));
}));

// ── תצוגות ──────────────────────────────────────────────────────────────
router.get('/shared-clients', h((req, res) => ok(res, repo.sharedClients())));
router.get('/whitespace', h((req, res) => ok(res, repo.whitespace())));
router.get('/audit', h((req, res) => ok(res, repo.auditLog.list(asInt(req.query.limit) ?? 200))));

// ── הרצות ודוחות ────────────────────────────────────────────────────────
router.get('/runs', h((req, res) => { reapStaleRuns(); ok(res, repo.runs.list(asInt(req.query.limit) ?? 50)); }));
router.get('/runs/:id', h((req, res) => ok(res, repo.runs.get(Number(req.params.id)))));
router.get('/reports', h((req, res) => ok(res, repo.reports.list())));
router.get('/reports/:id', h((req, res) => {
  const r = repo.reports.get(Number(req.params.id));
  if (!r) return res.status(404).json({ ok: false, error: 'הדוח לא נמצא' });
  ok(res, r);
}));
router.get('/reports/:id/markdown', h((req, res) => {
  const r = repo.reports.get(Number(req.params.id));
  if (!r) return res.status(404).send('לא נמצא');
  res.type('text/markdown; charset=utf-8')
     .set('content-disposition', `attachment; filename="aman-report-${r.id}.md"`)
     .send(r.content_md);
}));
router.delete('/reports/:id', h((req, res) => ok(res, { deleted: repo.reports.remove(Number(req.params.id), 'ui') })));

// ── משימות רקע ──────────────────────────────────────────────────────────
const jobs = new Map();
let jobSeq = 0;

/** מריץ פעולה ארוכה ברקע ומחזיר מזהה מעקב. */
function launch(kind, fn) {
  const id = ++jobSeq;
  const job = { id, kind, status: 'running', startedAt: new Date().toISOString(), result: null, error: null };
  jobs.set(id, job);
  Promise.resolve()
    .then(fn)
    .then((result) => { job.status = 'ok'; job.result = result; })
    .catch((err) => { job.status = 'failed'; job.error = err.message; job.result = { log: err.log ?? null }; })
    .finally(() => { job.finishedAt = new Date().toISOString(); });
  return job;
}

router.get('/jobs', h((req, res) => ok(res, [...jobs.values()].slice(-30).reverse())));
router.get('/jobs/:id', h((req, res) => {
  const job = jobs.get(Number(req.params.id));
  if (!job) return res.status(404).json({ ok: false, error: 'המשימה לא נמצאה' });
  ok(res, job);
}));

const ACTIONS = {
  'scrape-group':   (b) => scrapeGroup({ includeServices: b.includeServices !== false }),
  'scrape-clients': (b) => scrapeClients({ subsidiaryIds: b.subsidiaryIds ?? null }),
  'research':       (b) => researchClients({
                            clientIds: b.clientIds ?? null, limit: b.limit ?? null,
                            staleDays: b.staleDays ?? null, monthsBack: b.monthsBack ?? 12 }),
  'match':          (b) => runMatching({ minScore: b.minScore ?? 12 }),
  'report':         (b) => generateCeoReport({ minScore: b.minScore ?? 40, useAi: b.useAi !== false }),
  'pipeline':       (b) => runPipeline({ staleDays: b.staleDays ?? 25, monthsBack: b.monthsBack ?? 12,
                                         limit: b.limit ?? null, skipResearch: b.skipResearch === true }),
};

router.post('/actions/:action', h((req, res) => {
  const fn = ACTIONS[req.params.action];
  if (!fn) throw new Error(`פעולה לא מוכרת: ${req.params.action}`);
  const needsKey = ['scrape-group', 'scrape-clients', 'research'].includes(req.params.action);
  if (needsKey && !hasApiKey()) {
    throw new Error('הפעולה דורשת מפתח Claude API. הוסיפו ANTHROPIC_API_KEY לקובץ .env והפעילו מחדש את השרת.');
  }
  ok(res, launch(req.params.action, () => fn(req.body ?? {})));
}));

// ── תזמון ───────────────────────────────────────────────────────────────
router.get('/scheduler', h((req, res) => ok(res, schedulerState())));
router.post('/scheduler/start', h((req, res) => ok(res, startScheduler())));
router.post('/scheduler/stop', h((req, res) => ok(res, stopScheduler())));

// ── ייצוא מלא ───────────────────────────────────────────────────────────
router.get('/export', h((req, res) => {
  const d = db();
  const table = (t) => d.prepare(`SELECT * FROM ${t}`).all();
  res.set('content-disposition', `attachment; filename="aman-export-${new Date().toISOString().slice(0, 10)}.json"`);
  res.json({
    exported_at: new Date().toISOString(),
    subsidiaries: table('subsidiaries'), services: table('services'),
    clients: table('clients'), client_subsidiary: table('client_subsidiary'),
    trigger_types: table('trigger_types'), subsidiary_triggers: table('subsidiary_triggers'),
    signals: table('signals'), opportunities: table('opportunities'), reports: table('reports'),
  });
}));
