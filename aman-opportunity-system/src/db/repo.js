import { db, toJson, fromJson, audit, uniqueSlug } from './index.js';

// ═══════════════════════════════════════════════════════════════════════
//  שכבת גישה לנתונים — כל פעולת כתיבה נרשמת ביומן השינויים
// ═══════════════════════════════════════════════════════════════════════

const JSON_FIELDS = {
  subsidiaries: ['domains'],
  services: ['keywords'],
  clients: ['aliases'],
  client_subsidiary: ['service_ids'],
  trigger_types: ['keywords'],
  opportunities: ['evidence', 'warm_intro_via', 'score_breakdown'],
  reports: ['meta'],
  research_runs: ['scope'],
};

/** ממיר שדות JSON משמורים למבנה אמיתי. */
export function hydrate(table, row) {
  if (!row) return row;
  for (const f of JSON_FIELDS[table] ?? []) row[f] = fromJson(row[f], Array.isArray(row[f]) ? [] : null);
  return row;
}
const hydrateAll = (table, rows) => rows.map((r) => hydrate(table, r));

/** מסנן את גוף הבקשה לעמודות שקיימות בטבלה, וממיר מערכים/אובייקטים ל-JSON. */
function sanitize(table, body, allowed) {
  const out = {};
  for (const k of allowed) {
    if (!(k in body)) continue;
    let v = body[k];
    if ((JSON_FIELDS[table] ?? []).includes(k)) v = toJson(v ?? []);
    else if (v === '') v = null;
    out[k] = v;
  }
  return out;
}

function insertRow(table, data, actor) {
  const keys = Object.keys(data);
  if (!keys.length) throw new Error('אין שדות לשמירה');
  const sql = `INSERT INTO ${table} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`;
  const info = db().prepare(sql).run(...keys.map((k) => data[k]));
  const row = db().prepare(`SELECT * FROM ${table} WHERE id = ?`).get(info.lastInsertRowid);
  audit(table, info.lastInsertRowid, 'create', null, row, actor);
  return hydrate(table, row);
}

function updateRow(table, id, data, actor) {
  const before = db().prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id);
  if (!before) return null;
  const keys = Object.keys(data);
  if (keys.length) {
    const sql = `UPDATE ${table} SET ${keys.map((k) => `${k} = ?`).join(', ')},
                 updated_at = datetime('now') WHERE id = ?`;
    db().prepare(sql).run(...keys.map((k) => data[k]), id);
  }
  const after = db().prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id);
  audit(table, id, 'update', before, after, actor);
  return hydrate(table, after);
}

function deleteRow(table, id, actor) {
  const before = db().prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id);
  if (!before) return false;
  db().prepare(`DELETE FROM ${table} WHERE id = ?`).run(id);
  audit(table, id, 'delete', before, null, actor);
  return true;
}

// ── חברות בת ────────────────────────────────────────────────────────────
const SUB_FIELDS = ['name_he', 'name_en', 'website', 'description', 'domains', 'hq_country',
                    'founded_year', 'joined_year', 'status', 'source_url', 'confidence'];

export const subsidiaries = {
  list() {
    return hydrateAll('subsidiaries', db().prepare(`
      SELECT s.*,
             (SELECT COUNT(*) FROM services v WHERE v.subsidiary_id = s.id) AS service_count,
             (SELECT COUNT(*) FROM client_subsidiary cs WHERE cs.subsidiary_id = s.id) AS client_count,
             (SELECT COUNT(*) FROM subsidiary_triggers t WHERE t.subsidiary_id = s.id) AS trigger_count
        FROM subsidiaries s ORDER BY s.name_he`).all());
  },
  get(id) {
    const row = hydrate('subsidiaries', db().prepare('SELECT * FROM subsidiaries WHERE id = ?').get(id));
    if (!row) return null;
    row.services = hydrateAll('services', db().prepare(
      'SELECT * FROM services WHERE subsidiary_id = ? ORDER BY name_he').all(id));
    row.triggers = db().prepare(`
      SELECT st.*, tt.code, tt.name_he AS trigger_name, tt.category, v.name_he AS service_name
        FROM subsidiary_triggers st
        JOIN trigger_types tt ON tt.id = st.trigger_type_id
        LEFT JOIN services v ON v.id = st.service_id
       WHERE st.subsidiary_id = ? ORDER BY st.weight DESC`).all(id);
    row.clients = db().prepare(`
      SELECT c.id, c.name_he, c.industry, cs.relationship, cs.confidence, cs.evidence_url
        FROM client_subsidiary cs JOIN clients c ON c.id = cs.client_id
       WHERE cs.subsidiary_id = ? ORDER BY c.name_he`).all(id);
    return row;
  },
  create(body, actor) {
    const data = sanitize('subsidiaries', body, SUB_FIELDS);
    if (!data.name_he) throw new Error('שם חברת הבת (name_he) הוא שדה חובה');
    data.slug = body.slug ? uniqueSlug('subsidiaries', body.slug) : uniqueSlug('subsidiaries', data.name_en || data.name_he);
    data.origin = 'manual';
    return insertRow('subsidiaries', data, actor);
  },
  update(id, body, actor) {
    const data = sanitize('subsidiaries', body, SUB_FIELDS);
    if (body.slug) data.slug = uniqueSlug('subsidiaries', body.slug, id);
    data.origin = 'manual';
    return updateRow('subsidiaries', id, data, actor);
  },
  remove: (id, actor) => deleteRow('subsidiaries', id, actor),
};

// ── שירותים ─────────────────────────────────────────────────────────────
const SVC_FIELDS = ['subsidiary_id', 'name_he', 'name_en', 'category', 'description', 'keywords', 'source_url'];

export const services = {
  list(subsidiaryId = null) {
    const sql = `SELECT v.*, s.name_he AS subsidiary_name, s.slug AS subsidiary_slug
                   FROM services v JOIN subsidiaries s ON s.id = v.subsidiary_id
                  ${subsidiaryId ? 'WHERE v.subsidiary_id = ?' : ''}
                  ORDER BY s.name_he, v.name_he`;
    return hydrateAll('services', subsidiaryId ? db().prepare(sql).all(subsidiaryId) : db().prepare(sql).all());
  },
  create(body, actor) {
    const data = sanitize('services', body, SVC_FIELDS);
    if (!data.subsidiary_id) throw new Error('יש לבחור חברת בת');
    if (!data.name_he) throw new Error('שם השירות הוא שדה חובה');
    data.slug = uniqueSlugInSub(data.subsidiary_id, body.slug || data.name_en || data.name_he);
    data.origin = 'manual';
    return insertRow('services', data, actor);
  },
  update(id, body, actor) {
    const data = sanitize('services', body, SVC_FIELDS);
    data.origin = 'manual';
    return updateRow('services', id, data, actor);
  },
  remove: (id, actor) => deleteRow('services', id, actor),
};

function uniqueSlugInSub(subId, base) {
  const { slugify } = { slugify: (s) => String(s).trim().toLowerCase()
    .replace(/["'׳״]/g, '').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'service' };
  let slug = slugify(base), i = 1;
  const stmt = db().prepare('SELECT 1 FROM services WHERE subsidiary_id = ? AND slug = ?');
  while (stmt.get(subId, slug)) slug = `${slugify(base)}-${++i}`;
  return slug;
}

// ── לקוחות ──────────────────────────────────────────────────────────────
const CLIENT_FIELDS = ['name_he', 'name_en', 'aliases', 'website', 'industry', 'sector', 'country',
                       'is_public', 'ticker', 'exchange', 'size_band', 'employees_est', 'logo_url',
                       'notes', 'source_url', 'confidence'];

export const clients = {
  list({ q = '', subsidiaryId = null, sharedOnly = false, limit = 500, offset = 0 } = {}) {
    const where = [], params = [];
    if (q) { where.push('(c.name_he LIKE ? OR c.name_en LIKE ? OR c.aliases LIKE ?)');
             params.push(`%${q}%`, `%${q}%`, `%${q}%`); }
    if (subsidiaryId) { where.push('EXISTS (SELECT 1 FROM client_subsidiary x WHERE x.client_id = c.id AND x.subsidiary_id = ?)');
                        params.push(subsidiaryId); }
    const having = sharedOnly ? 'HAVING subsidiary_count > 1' : '';
    const rows = db().prepare(`
      SELECT c.*,
             (SELECT COUNT(DISTINCT cs.subsidiary_id) FROM client_subsidiary cs WHERE cs.client_id = c.id) AS subsidiary_count,
             (SELECT GROUP_CONCAT(s.name_he, ' • ') FROM client_subsidiary cs
                JOIN subsidiaries s ON s.id = cs.subsidiary_id WHERE cs.client_id = c.id) AS subsidiary_names,
             (SELECT COUNT(*) FROM signals g WHERE g.client_id = c.id AND g.status != 'dismissed') AS signal_count,
             (SELECT COUNT(*) FROM opportunities o WHERE o.client_id = c.id AND o.status NOT IN ('dismissed','lost')) AS opportunity_count
        FROM clients c
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ${having}
       ORDER BY subsidiary_count DESC, c.name_he
       LIMIT ? OFFSET ?`).all(...params, limit, offset);
    return hydrateAll('clients', rows);
  },
  get(id) {
    const row = hydrate('clients', db().prepare('SELECT * FROM clients WHERE id = ?').get(id));
    if (!row) return null;
    row.subsidiaries = hydrateAll('client_subsidiary', db().prepare(`
      SELECT cs.*, s.name_he AS subsidiary_name, s.slug AS subsidiary_slug
        FROM client_subsidiary cs JOIN subsidiaries s ON s.id = cs.subsidiary_id
       WHERE cs.client_id = ? ORDER BY s.name_he`).all(id));
    row.signals = db().prepare(`
      SELECT g.*, tt.code AS trigger_code, tt.name_he AS trigger_name, tt.category AS trigger_category
        FROM signals g LEFT JOIN trigger_types tt ON tt.id = g.trigger_type_id
       WHERE g.client_id = ? ORDER BY g.evidence_date DESC, g.strength DESC`).all(id);
    row.opportunities = hydrateAll('opportunities', db().prepare(`
      SELECT o.*, s.name_he AS subsidiary_name, v.name_he AS service_name
        FROM opportunities o JOIN subsidiaries s ON s.id = o.subsidiary_id
        LEFT JOIN services v ON v.id = o.service_id
       WHERE o.client_id = ? ORDER BY o.score DESC`).all(id));
    return row;
  },
  create(body, actor) {
    const data = sanitize('clients', body, CLIENT_FIELDS);
    if (!data.name_he) throw new Error('שם הלקוח הוא שדה חובה');
    data.slug = uniqueSlug('clients', body.slug || data.name_en || data.name_he);
    data.origin = 'manual';
    const row = insertRow('clients', data, actor);
    if (Array.isArray(body.subsidiary_ids)) {
      for (const sid of body.subsidiary_ids) links.upsert(row.id, sid, {}, actor);
    }
    return row;
  },
  update(id, body, actor) {
    const data = sanitize('clients', body, CLIENT_FIELDS);
    if (body.slug) data.slug = uniqueSlug('clients', body.slug, id);
    data.origin = 'manual';
    return updateRow('clients', id, data, actor);
  },
  remove: (id, actor) => deleteRow('clients', id, actor),

  /** מיזוג לקוח כפול לתוך לקוח יעד: מעביר קשרים, אותות והזדמנויות. */
  merge(targetId, sourceId, actor) {
    if (Number(targetId) === Number(sourceId)) throw new Error('לא ניתן למזג לקוח לעצמו');
    const d = db();
    const target = d.prepare('SELECT * FROM clients WHERE id = ?').get(targetId);
    const source = d.prepare('SELECT * FROM clients WHERE id = ?').get(sourceId);
    if (!target || !source) throw new Error('אחד הלקוחות לא נמצא');
    d.transaction(() => {
      d.prepare(`UPDATE OR IGNORE client_subsidiary SET client_id = ? WHERE client_id = ?`).run(targetId, sourceId);
      d.prepare(`UPDATE OR IGNORE signals SET client_id = ? WHERE client_id = ?`).run(targetId, sourceId);
      d.prepare(`UPDATE OR IGNORE opportunities SET client_id = ? WHERE client_id = ?`).run(targetId, sourceId);
      const aliases = new Set([...(fromJson(target.aliases, []) || []), source.name_he, source.name_en].filter(Boolean));
      d.prepare(`UPDATE clients SET aliases = ?, updated_at = datetime('now') WHERE id = ?`)
        .run(toJson([...aliases]), targetId);
      d.prepare('DELETE FROM clients WHERE id = ?').run(sourceId);
    })();
    audit('clients', targetId, 'merge', source, { merged_into: targetId }, actor);
    return clients.get(targetId);
  },
};

// ── קשרי לקוח ↔ חברת בת ─────────────────────────────────────────────────
const LINK_FIELDS = ['relationship', 'since_year', 'service_ids', 'evidence_url', 'evidence_text', 'confidence'];

export const links = {
  upsert(clientId, subsidiaryId, body = {}, actor = 'ui') {
    const data = sanitize('client_subsidiary', body, LINK_FIELDS);
    const existing = db().prepare(
      'SELECT * FROM client_subsidiary WHERE client_id = ? AND subsidiary_id = ?').get(clientId, subsidiaryId);
    if (existing) return updateRow('client_subsidiary', existing.id, { ...data, origin: 'manual' }, actor);
    return insertRow('client_subsidiary',
      { client_id: clientId, subsidiary_id: subsidiaryId, relationship: 'customer', ...data, origin: 'manual' }, actor);
  },
  remove: (id, actor) => deleteRow('client_subsidiary', id, actor),
};

// ── טריגרים ─────────────────────────────────────────────────────────────
const TRIG_FIELDS = ['name_he', 'name_en', 'category', 'description', 'keywords',
                     'base_weight', 'decay_days', 'is_active'];

export const triggerTypes = {
  list() {
    return hydrateAll('trigger_types', db().prepare(`
      SELECT tt.*,
             (SELECT COUNT(*) FROM subsidiary_triggers st WHERE st.trigger_type_id = tt.id) AS mapping_count,
             (SELECT COUNT(*) FROM signals g WHERE g.trigger_type_id = tt.id) AS signal_count
        FROM trigger_types tt ORDER BY tt.category, tt.base_weight DESC`).all());
  },
  create(body, actor) {
    const data = sanitize('trigger_types', body, TRIG_FIELDS);
    if (!data.name_he) throw new Error('שם הטריגר הוא שדה חובה');
    data.code = body.code || uniqueSlug('trigger_types', data.name_en || data.name_he).replace(/-/g, '_');
    data.category = data.category || 'market';
    data.origin = 'manual';
    return insertRow('trigger_types', data, actor);
  },
  update(id, body, actor) {
    const data = sanitize('trigger_types', body, TRIG_FIELDS);
    data.origin = 'manual';
    return updateRow('trigger_types', id, data, actor);
  },
  remove: (id, actor) => deleteRow('trigger_types', id, actor),
};

const MAP_FIELDS = ['subsidiary_id', 'trigger_type_id', 'service_id', 'weight', 'rationale_he'];

export const subsidiaryTriggers = {
  list(subsidiaryId = null) {
    const sql = `SELECT st.*, s.name_he AS subsidiary_name, tt.name_he AS trigger_name,
                        tt.code AS trigger_code, tt.category, v.name_he AS service_name
                   FROM subsidiary_triggers st
                   JOIN subsidiaries s ON s.id = st.subsidiary_id
                   JOIN trigger_types tt ON tt.id = st.trigger_type_id
                   LEFT JOIN services v ON v.id = st.service_id
                  ${subsidiaryId ? 'WHERE st.subsidiary_id = ?' : ''}
                  ORDER BY s.name_he, st.weight DESC`;
    return subsidiaryId ? db().prepare(sql).all(subsidiaryId) : db().prepare(sql).all();
  },
  create(body, actor) {
    const data = sanitize('subsidiary_triggers', body, MAP_FIELDS);
    if (!data.subsidiary_id || !data.trigger_type_id) throw new Error('יש לבחור חברת בת וטריגר');
    data.origin = 'manual';
    return insertRow('subsidiary_triggers', data, actor);
  },
  update(id, body, actor) {
    const data = sanitize('subsidiary_triggers', body, MAP_FIELDS);
    data.origin = 'manual';
    return updateRow('subsidiary_triggers', id, data, actor);
  },
  remove: (id, actor) => deleteRow('subsidiary_triggers', id, actor),
};

// ── אותות ───────────────────────────────────────────────────────────────
const SIGNAL_FIELDS = ['client_id', 'trigger_type_id', 'title_he', 'summary_he', 'evidence_quote',
                       'evidence_url', 'evidence_source', 'evidence_date', 'strength', 'sentiment', 'status'];

export const signals = {
  list({ clientId = null, status = null, limit = 500 } = {}) {
    const where = [], params = [];
    if (clientId) { where.push('g.client_id = ?'); params.push(clientId); }
    if (status) { where.push('g.status = ?'); params.push(status); }
    return db().prepare(`
      SELECT g.*, c.name_he AS client_name, tt.name_he AS trigger_name,
             tt.code AS trigger_code, tt.category AS trigger_category
        FROM signals g
        JOIN clients c ON c.id = g.client_id
        LEFT JOIN trigger_types tt ON tt.id = g.trigger_type_id
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY g.evidence_date DESC, g.strength DESC LIMIT ?`).all(...params, limit);
  },
  create(body, actor) {
    const data = sanitize('signals', body, SIGNAL_FIELDS);
    if (!data.client_id || !data.title_he) throw new Error('יש לציין לקוח וכותרת');
    data.origin = 'manual';
    return insertRow('signals', data, actor);
  },
  update: (id, body, actor) => updateRow('signals', id, sanitize('signals', body, SIGNAL_FIELDS), actor),
  remove: (id, actor) => deleteRow('signals', id, actor),
};

// ── הזדמנויות ───────────────────────────────────────────────────────────
const OPP_FIELDS = ['client_id', 'subsidiary_id', 'service_id', 'signal_id', 'kind',
                    'score', 'rationale_he', 'status', 'owner'];

export const opportunities = {
  list({ status = null, subsidiaryId = null, clientId = null, minScore = 0, limit = 300 } = {}) {
    const where = ['o.score >= ?'], params = [minScore];
    if (status) { where.push('o.status = ?'); params.push(status); }
    if (subsidiaryId) { where.push('o.subsidiary_id = ?'); params.push(subsidiaryId); }
    if (clientId) { where.push('o.client_id = ?'); params.push(clientId); }
    return hydrateAll('opportunities', db().prepare(`
      SELECT o.*, c.name_he AS client_name, c.industry, s.name_he AS subsidiary_name,
             v.name_he AS service_name, g.title_he AS signal_title, g.evidence_url AS signal_url,
             g.evidence_date AS signal_date, g.evidence_source AS signal_source
        FROM opportunities o
        JOIN clients c ON c.id = o.client_id
        JOIN subsidiaries s ON s.id = o.subsidiary_id
        LEFT JOIN services v ON v.id = o.service_id
        LEFT JOIN signals g ON g.id = o.signal_id
       WHERE ${where.join(' AND ')}
       ORDER BY o.score DESC LIMIT ?`).all(...params, limit));
  },
  create(body, actor) {
    const data = sanitize('opportunities', body, OPP_FIELDS);
    if (!data.client_id || !data.subsidiary_id) throw new Error('יש לציין לקוח וחברת בת');
    data.origin = 'manual';
    return insertRow('opportunities', data, actor);
  },
  update: (id, body, actor) => updateRow('opportunities', id, sanitize('opportunities', body, OPP_FIELDS), actor),
  remove: (id, actor) => deleteRow('opportunities', id, actor),
};

// ── הרצות, דוחות, יומן ──────────────────────────────────────────────────
export const runs = {
  list: (limit = 50) => hydrateAll('research_runs',
    db().prepare('SELECT * FROM research_runs ORDER BY started_at DESC LIMIT ?').all(limit)),
  get: (id) => hydrate('research_runs', db().prepare('SELECT * FROM research_runs WHERE id = ?').get(id)),
};

export const reports = {
  list: (limit = 50) => hydrateAll('reports', db().prepare(
    'SELECT id, kind, title, period_label, meta, generated_at FROM reports ORDER BY generated_at DESC LIMIT ?').all(limit)),
  get: (id) => hydrate('reports', db().prepare('SELECT * FROM reports WHERE id = ?').get(id)),
  remove: (id, actor) => deleteRow('reports', id, actor),
};

export const auditLog = {
  list: (limit = 200) => db().prepare('SELECT * FROM audit_log ORDER BY at DESC LIMIT ?').all(limit),
};

// ── סטטיסטיקות לדשבורד ──────────────────────────────────────────────────
export function dashboardStats() {
  const d = db();
  const one = (sql, ...p) => d.prepare(sql).get(...p);
  return {
    subsidiaries: one(`SELECT COUNT(*) n FROM subsidiaries WHERE status = 'active'`).n,
    services: one(`SELECT COUNT(*) n FROM services`).n,
    clients: one(`SELECT COUNT(*) n FROM clients`).n,
    sharedClients: one(`SELECT COUNT(*) n FROM v_shared_clients`).n,
    triggerTypes: one(`SELECT COUNT(*) n FROM trigger_types WHERE is_active = 1`).n,
    signals: one(`SELECT COUNT(*) n FROM signals WHERE status != 'dismissed'`).n,
    freshSignals: one(`SELECT COUNT(*) n FROM signals WHERE detected_at > datetime('now','-30 days')`).n,
    opportunities: one(`SELECT COUNT(*) n FROM opportunities WHERE status NOT IN ('dismissed','lost')`).n,
    hotOpportunities: one(`SELECT COUNT(*) n FROM opportunities WHERE score >= 65 AND status NOT IN ('dismissed','lost')`).n,
    whitespace: one(`SELECT COUNT(*) n FROM v_whitespace`).n,
    lastResearch: one(`SELECT MAX(finished_at) t FROM research_runs WHERE kind IN ('research','pipeline') AND status = 'ok'`).t,
    byStatus: d.prepare(`SELECT status, COUNT(*) n FROM opportunities GROUP BY status`).all(),
    bySubsidiary: d.prepare(`
      SELECT s.name_he AS name, COUNT(o.id) n, ROUND(AVG(o.score), 1) avg_score
        FROM subsidiaries s LEFT JOIN opportunities o
          ON o.subsidiary_id = s.id AND o.status NOT IN ('dismissed','lost')
       GROUP BY s.id HAVING n > 0 ORDER BY n DESC`).all(),
    topTriggers: d.prepare(`
      SELECT tt.name_he AS name, COUNT(g.id) n FROM trigger_types tt
        JOIN signals g ON g.trigger_type_id = tt.id AND g.status != 'dismissed'
       GROUP BY tt.id ORDER BY n DESC LIMIT 8`).all(),
  };
}

export const sharedClients = () => db().prepare('SELECT * FROM v_shared_clients ORDER BY subsidiary_count DESC').all();
export const whitespace = () => db().prepare(`
  SELECT w.*, (SELECT COUNT(*) FROM signals g WHERE g.client_id = w.client_id AND g.status != 'dismissed') AS signal_count
    FROM v_whitespace w ORDER BY signal_count DESC, w.client_name`).all();
