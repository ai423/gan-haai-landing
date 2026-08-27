import crypto from 'node:crypto';
import { db, toJson, startRun, finishRun } from '../db/index.js';
import { createLogger } from '../lib/logger.js';

/**
 * מנוע ההצלבה: לקוח × טריגר × חברת בת/שירות → הזדמנות מדורגת.
 *
 * המנוע דטרמיניסטי לחלוטין (בלי LLM) — כל ציון ניתן לפירוק ולהסבר,
 * וכל הזדמנות נשענת על אות עם מקור. הזדמנות בלי ראיה לא נוצרת.
 */

const DAY = 86400000;

/** דעיכה לפי גיל האות ביחס לחלון התקפות של סוג הטריגר. */
export function recencyFactor(evidenceDate, decayDays = 180) {
  if (!evidenceDate) return 0.6;                       // תאריך לא ידוע — הנחה שמרנית
  const age = (Date.now() - new Date(evidenceDate).getTime()) / DAY;
  if (Number.isNaN(age)) return 0.6;
  if (age < 0) return 1;                               // תאריך עתידי (אירוע מתוכנן)
  if (age <= decayDays * 0.25) return 1;
  if (age >= decayDays * 2) return 0.15;
  return Math.max(0.15, 1 - (age - decayDays * 0.25) / (decayDays * 1.75) * 0.85);
}

const round1 = (n) => Math.round(n * 10) / 10;
const fp = (clientId, subId, svcId) =>
  crypto.createHash('sha1').update(`${clientId}|${subId}|${svcId ?? 0}`).digest('hex').slice(0, 20);

// ═══════════════════════════════════════════════════════════════════════
export function runMatching({ triggerMode = 'manual', minScore = 12 } = {}) {
  const log = createLogger('');
  const runId = startRun('match', { triggerMode, scope: { minScore } });
  const result = { created: 0, updated: 0, removed: 0, evaluated: 0 };

  try {
    const d = db();

    const signals = d.prepare(`
      SELECT g.*, tt.code AS trigger_code, tt.name_he AS trigger_name,
             tt.base_weight, tt.decay_days
        FROM signals g
        JOIN trigger_types tt ON tt.id = g.trigger_type_id
       WHERE g.status != 'dismissed' AND tt.is_active = 1`).all();

    const mappings = d.prepare(`
      SELECT st.*, s.name_he AS subsidiary_name, s.slug AS subsidiary_slug,
             v.name_he AS service_name
        FROM subsidiary_triggers st
        JOIN subsidiaries s ON s.id = st.subsidiary_id AND s.status = 'active'
        LEFT JOIN services v ON v.id = st.service_id`).all();

    const clients = new Map(d.prepare('SELECT * FROM clients').all().map((c) => [c.id, c]));
    const relations = d.prepare(`
      SELECT cs.client_id, cs.subsidiary_id, cs.relationship, cs.service_ids, s.name_he AS subsidiary_name
        FROM client_subsidiary cs JOIN subsidiaries s ON s.id = cs.subsidiary_id`).all();

    // client_id → Set(subsidiary_id) שכבר לקוחות בפועל
    const engaged = new Map();
    for (const r of relations) {
      if (!['customer', 'case_study'].includes(r.relationship)) continue;
      if (!engaged.has(r.client_id)) engaged.set(r.client_id, new Map());
      engaged.get(r.client_id).set(r.subsidiary_id, r.subsidiary_name);
    }

    log.info(`מצליב ${signals.length} אותות מול ${mappings.length} מיפויי טריגר`);

    // ── צבירה לפי (לקוח, חברת בת, שירות) ──────────────────────────────
    const buckets = new Map();

    for (const sig of signals) {
      const client = clients.get(sig.client_id);
      if (!client) continue;
      const R = recencyFactor(sig.evidence_date, sig.decay_days);
      const Bt = 0.7 + 0.3 * (sig.base_weight ?? 0.5);
      const St = Math.max(0, Math.min(1, sig.strength ?? 0.5));

      for (const m of mappings) {
        if (m.trigger_type_id !== sig.trigger_type_id) continue;
        result.evaluated++;

        const inside = engaged.get(client.id) ?? new Map();
        const alreadyIn = inside.has(m.subsidiary_id);
        const hasAnyGroupRelation = inside.size > 0;

        let kind, warmth;
        if (alreadyIn)               { kind = 'upsell';     warmth = 1.0; }
        else if (hasAnyGroupRelation) { kind = 'cross_sell'; warmth = 0.85; }
        else                          { kind = 'new_logo';   warmth = 0.45; }

        const score = 100 * (m.weight ?? 0.5) * St * R * warmth * Bt;
        if (score < minScore) continue;

        const key = `${client.id}|${m.subsidiary_id}|${m.service_id ?? 0}`;
        const entry = buckets.get(key) ?? {
          client, subsidiary_id: m.subsidiary_id, subsidiary_name: m.subsidiary_name,
          service_id: m.service_id ?? null, service_name: m.service_name,
          kind, best: null, contributions: [],
          warm_intro_via: [...inside.entries()]
            .filter(([sid]) => sid !== m.subsidiary_id).map(([, name]) => name),
        };
        const contribution = {
          score: round1(score), signal: sig, mapping: m,
          breakdown: { mapping_weight: m.weight, signal_strength: round1(St),
                       recency: round1(R), warmth, trigger_base: round1(Bt) },
        };
        entry.contributions.push(contribution);
        if (!entry.best || score > entry.best.score) entry.best = contribution;
        buckets.set(key, entry);
      }
    }

    // ── כתיבה ─────────────────────────────────────────────────────────
    const selectExisting = d.prepare('SELECT * FROM opportunities WHERE fingerprint = ?');
    const insert = d.prepare(`
      INSERT INTO opportunities
        (client_id, subsidiary_id, service_id, signal_id, kind, score, score_breakdown,
         rationale_he, evidence, warm_intro_via, fingerprint, origin)
      VALUES (@client_id, @subsidiary_id, @service_id, @signal_id, @kind, @score, @score_breakdown,
              @rationale_he, @evidence, @warm_intro_via, @fingerprint, 'engine')`);
    const update = d.prepare(`
      UPDATE opportunities
         SET service_id = @service_id, signal_id = @signal_id, kind = @kind, score = @score,
             score_breakdown = @score_breakdown, rationale_he = @rationale_he,
             evidence = @evidence, warm_intro_via = @warm_intro_via, updated_at = datetime('now')
       WHERE fingerprint = @fingerprint`);

    const liveFingerprints = new Set();

    d.transaction(() => {
      for (const e of buckets.values()) {
        // בונוס קורוברציה: כמה אותות שונים שמצביעים לאותו כיוון
        const distinct = new Set(e.contributions.map((c) => c.signal.trigger_type_id)).size;
        const score = Math.min(100, round1(e.best.score + Math.min(15, 5 * (distinct - 1))));

        const evidence = e.contributions
          .sort((a, b) => b.score - a.score).slice(0, 4)
          .map((c) => ({
            trigger: c.signal.trigger_name,
            title: c.signal.title_he,
            quote: c.signal.evidence_quote,
            url: c.signal.evidence_url,
            source: c.signal.evidence_source,
            date: c.signal.evidence_date,
            contribution: c.score,
          }));

        const row = {
          client_id: e.client.id, subsidiary_id: e.subsidiary_id, service_id: e.service_id,
          signal_id: e.best.signal.id, kind: e.kind, score,
          score_breakdown: toJson({ ...e.best.breakdown, corroborating_triggers: distinct, final: score }),
          rationale_he: buildRationale(e, score),
          evidence: toJson(evidence),
          warm_intro_via: toJson(e.warm_intro_via),
          fingerprint: fp(e.client.id, e.subsidiary_id, e.service_id),
        };
        liveFingerprints.add(row.fingerprint);

        const existing = selectExisting.get(row.fingerprint);
        if (existing) { update.run(row); result.updated++; }
        else { insert.run(row); result.created++; }
      }

      // הזדמנויות מנוע שכבר אין להן ראיה — נמחקות, אבל רק אם איש לא נגע בהן
      const stale = d.prepare(`SELECT id, fingerprint FROM opportunities
                                WHERE origin = 'engine' AND status = 'new'`).all();
      for (const s of stale) {
        if (!liveFingerprints.has(s.fingerprint)) {
          d.prepare('DELETE FROM opportunities WHERE id = ?').run(s.id);
          result.removed++;
        }
      }
    })();

    log.ok(`הצלבה הושלמה: ${result.created} הזדמנויות חדשות, ${result.updated} עודכנו, ${result.removed} הוסרו`);
    finishRun(runId, { status: 'ok', itemsIn: signals.length,
                       itemsOut: result.created + result.updated, log: log.text() });
    return { runId, ...result, log: log.text() };
  } catch (err) {
    log.error(err.message);
    finishRun(runId, { status: 'failed', log: log.text(), error: err.message });
    throw Object.assign(err, { runId, log: log.text() });
  }
}

/** בונה את משפט התובנה — "חברת בת X ללקוח Y את שירות Z כי [ראיה]". */
function buildRationale(entry, score) {
  const sig = entry.best.signal;
  const svcAcc  = entry.service_name ? `את השירות «${entry.service_name}»` : 'את שירותיה';
  const svcWith = entry.service_name ? `השירות «${entry.service_name}»` : 'שירותיה';
  const date = sig.evidence_date ? ` (${sig.evidence_date})` : '';
  const source = sig.evidence_source ? `, ${sig.evidence_source}` : '';

  const opener = entry.kind === 'upsell'
    ? `«${entry.subsidiary_name}» כבר עובדת עם «${entry.client.name_he}» ויכולה להרחיב ולהציע ${svcAcc}`
    : entry.kind === 'cross_sell'
      ? `«${entry.subsidiary_name}» יכולה להיכנס ל«${entry.client.name_he}» עם ${svcWith}` +
        (entry.warm_intro_via.length ? `, דרך היכרות קיימת של ${entry.warm_intro_via.join(' ו')}` : '')
      : `«${entry.subsidiary_name}» יכולה לפנות ל«${entry.client.name_he}» עם ${svcWith}`;

  const why = `כי ${sig.trigger_name}: ${sig.title_he}${date}${source}.`;
  const mech = entry.best.mapping.rationale_he ? ` ${entry.best.mapping.rationale_he}` : '';
  return `${opener} — ${why}${mech}`;
}
