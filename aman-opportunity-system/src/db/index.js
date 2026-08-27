import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..', '..');
export const DB_PATH = process.env.AMAN_DB_PATH || path.join(ROOT, 'data', 'aman.db');

let _db = null;

/** מחזיר חיבור יחיד (singleton) ל-SQLite, ויוצר את הסכימה אם חסרה. */
export function db() {
  if (_db) return _db;
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  _db = new Database(DB_PATH);
  _db.pragma('journal_mode = WAL');
  _db.pragma('foreign_keys = ON');
  _db.exec(fs.readFileSync(path.join(here, 'schema.sql'), 'utf8'));
  return _db;
}

/** עוטף פונקציה בטרנזקציה. */
export function tx(fn) {
  return db().transaction(fn);
}

// ── עזרי JSON ────────────────────────────────────────────────────────────
export const toJson = (v) => (v === undefined || v === null ? null : JSON.stringify(v));
export function fromJson(v, fallback = null) {
  if (v === null || v === undefined || v === '') return fallback;
  try { return JSON.parse(v); } catch { return fallback; }
}

/** slug יציב שתומך בעברית (משאיר אותיות, מחליף רווחים במקף). */
export function slugify(input) {
  return String(input || '')
    .trim()
    .toLowerCase()
    .replace(/["'׳״]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'item';
}

/** מוודא ייחודיות slug בטבלה נתונה. */
export function uniqueSlug(table, base, excludeId = null) {
  const d = db();
  let slug = slugify(base);
  let i = 1;
  const sql = excludeId
    ? `SELECT 1 FROM ${table} WHERE slug = ? AND id != ?`
    : `SELECT 1 FROM ${table} WHERE slug = ?`;
  const stmt = d.prepare(sql);
  while (excludeId ? stmt.get(slug, excludeId) : stmt.get(slug)) {
    slug = `${slugify(base)}-${++i}`;
  }
  return slug;
}

/** רישום ליומן השינויים. */
export function audit(entity, entityId, action, before, after, actor = 'ui') {
  db().prepare(
    `INSERT INTO audit_log (entity, entity_id, action, actor, before_json, after_json)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(entity, entityId ?? null, action, actor, toJson(before), toJson(after));
}

// ── הרצות ────────────────────────────────────────────────────────────────
export function startRun(kind, { triggerMode = 'manual', scope = null, model = null } = {}) {
  const info = db().prepare(
    `INSERT INTO research_runs (kind, trigger_mode, scope, model) VALUES (?, ?, ?, ?)`
  ).run(kind, triggerMode, toJson(scope), model);
  return info.lastInsertRowid;
}

export function finishRun(runId, { status = 'ok', itemsIn = 0, itemsOut = 0,
                                   tokensIn = 0, tokensOut = 0, log = null, error = null } = {}) {
  db().prepare(
    `UPDATE research_runs
        SET status = ?, items_in = ?, items_out = ?, tokens_in = ?, tokens_out = ?,
            log = ?, error = ?, finished_at = datetime('now')
      WHERE id = ?`
  ).run(status, itemsIn, itemsOut, tokensIn, tokensOut,
        Array.isArray(log) ? log.join('\n') : log, error, runId);
}

/** מסמן הרצות שנתקעו (למשל אחרי קריסת תהליך) כנכשלות. */
export function reapStaleRuns(maxMinutes = 180) {
  return db().prepare(
    `UPDATE research_runs
        SET status = 'failed',
            error = COALESCE(error, 'ההרצה נקטעה — התהליך ככל הנראה נסגר באמצע'),
            finished_at = datetime('now')
      WHERE status = 'running'
        AND started_at < datetime('now', ?)`
  ).run(`-${maxMinutes} minutes`).changes;
}
