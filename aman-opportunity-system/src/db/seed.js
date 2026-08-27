import 'dotenv/config';
import { db, toJson, audit } from './index.js';
import { SUBSIDIARIES, TRIGGER_TYPES, SUBSIDIARY_TRIGGERS, CLIENTS } from './seed-data.js';

/**
 * זריעה אידמפוטנטית: לא דורסת רשומות שנערכו ידנית (origin='manual')
 * ולא יוצרת כפילויות בהרצות חוזרות.
 */
export function seed({ verbose = true } = {}) {
  const d = db();
  const log = (...a) => verbose && console.log(...a);
  const stats = { subsidiaries: 0, services: 0, triggers: 0, maps: 0, clients: 0, links: 0 };

  d.transaction(() => {
    // ── חברות בת + שירותים ──────────────────────────────────────────────
    const insSub = d.prepare(`
      INSERT INTO subsidiaries (slug, name_he, name_en, website, description, domains,
                                hq_country, founded_year, joined_year, source_url, confidence, origin)
      VALUES (@slug, @name_he, @name_en, @website, @description, @domains,
              @hq_country, @founded_year, @joined_year, @source_url, @confidence, 'seed')
      ON CONFLICT(slug) DO NOTHING`);
    const insSvc = d.prepare(`
      INSERT INTO services (subsidiary_id, slug, name_he, name_en, category, description, keywords, source_url, origin)
      VALUES (@subsidiary_id, @slug, @name_he, @name_en, @category, @description, @keywords, @source_url, 'seed')
      ON CONFLICT(subsidiary_id, slug) DO NOTHING`);

    for (const s of SUBSIDIARIES) {
      const r = insSub.run({
        slug: s.slug, name_he: s.name_he, name_en: s.name_en ?? null,
        website: s.website ?? null, description: s.description ?? null,
        domains: toJson(s.domains ?? []), hq_country: s.hq_country ?? null,
        founded_year: s.founded_year ?? null, joined_year: s.joined_year ?? null,
        source_url: s.source_url ?? null, confidence: s.confidence ?? 0.5,
      });
      stats.subsidiaries += r.changes;
      const subId = d.prepare('SELECT id FROM subsidiaries WHERE slug = ?').get(s.slug).id;
      for (const sv of s.services ?? []) {
        stats.services += insSvc.run({
          subsidiary_id: subId, slug: sv.slug, name_he: sv.name_he, name_en: sv.name_en ?? null,
          category: sv.category ?? null, description: sv.description ?? null,
          keywords: toJson(sv.keywords ?? []), source_url: s.source_url ?? null,
        }).changes;
      }
    }

    // ── קטלוג טריגרים ───────────────────────────────────────────────────
    const insTrig = d.prepare(`
      INSERT INTO trigger_types (code, name_he, name_en, category, description, keywords, base_weight, decay_days, origin)
      VALUES (@code, @name_he, @name_en, @category, @description, @keywords, @base_weight, @decay_days, 'seed')
      ON CONFLICT(code) DO NOTHING`);
    for (const t of TRIGGER_TYPES) {
      stats.triggers += insTrig.run({
        code: t.code, name_he: t.name_he, name_en: t.name_en ?? null, category: t.category,
        description: t.description ?? null, keywords: toJson(t.keywords ?? []),
        base_weight: t.base_weight ?? 0.5, decay_days: t.decay_days ?? 180,
      }).changes;
    }

    // ── מיפוי טריגר ↔ חברת בת ───────────────────────────────────────────
    const insMap = d.prepare(`
      INSERT INTO subsidiary_triggers (subsidiary_id, trigger_type_id, service_id, weight, rationale_he, origin)
      VALUES (?, ?, ?, ?, ?, 'seed')
      ON CONFLICT(subsidiary_id, trigger_type_id, service_id) DO NOTHING`);
    const getSub = d.prepare('SELECT id FROM subsidiaries WHERE slug = ?');
    const getTrig = d.prepare('SELECT id FROM trigger_types WHERE code = ?');
    const getSvc = d.prepare('SELECT id FROM services WHERE subsidiary_id = ? AND slug = ?');

    for (const [subSlug, trigCode, svcSlug, weight, rationale] of SUBSIDIARY_TRIGGERS) {
      const sub = getSub.get(subSlug), trig = getTrig.get(trigCode);
      if (!sub || !trig) { log(`  ⚠ דילוג על מיפוי ${subSlug}/${trigCode} — לא נמצא`); continue; }
      const svc = svcSlug ? getSvc.get(sub.id, svcSlug) : null;
      stats.maps += insMap.run(sub.id, trig.id, svc?.id ?? null, weight, rationale).changes;
    }

    // ── לקוחות + שיוך לחברות בת ─────────────────────────────────────────
    const insClient = d.prepare(`
      INSERT INTO clients (slug, name_he, name_en, website, industry, country, is_public,
                           ticker, exchange, size_band, source_url, confidence, origin)
      VALUES (@slug, @name_he, @name_en, @website, @industry, @country, @is_public,
              @ticker, @exchange, @size_band, @source_url, @confidence, 'seed')
      ON CONFLICT(slug) DO NOTHING`);
    const insLink = d.prepare(`
      INSERT INTO client_subsidiary (client_id, subsidiary_id, relationship, evidence_url, evidence_text, confidence, origin)
      VALUES (?, ?, ?, ?, ?, ?, 'seed')
      ON CONFLICT(client_id, subsidiary_id) DO NOTHING`);

    for (const c of CLIENTS) {
      const firstLink = c.links?.[0];
      stats.clients += insClient.run({
        slug: c.slug, name_he: c.name_he, name_en: c.name_en ?? null, website: c.website ?? null,
        industry: c.industry ?? null, country: c.country ?? 'IL', is_public: c.is_public ?? 0,
        ticker: c.ticker ?? null, exchange: c.exchange ?? null, size_band: c.size_band ?? null,
        source_url: firstLink?.url ?? null, confidence: firstLink?.conf ?? 0.5,
      }).changes;
      const clientId = d.prepare('SELECT id FROM clients WHERE slug = ?').get(c.slug).id;
      for (const l of c.links ?? []) {
        const sub = getSub.get(l.sub);
        if (!sub) { log(`  ⚠ דילוג על קשר ${c.slug}→${l.sub} — חברת בת לא נמצאה`); continue; }
        stats.links += insLink.run(clientId, sub.id, l.rel ?? 'customer',
                                   l.url ?? null, l.text ?? null, l.conf ?? 0.5).changes;
      }
    }

    audit('seed', null, 'bulk_import', null, stats, 'seed-script');
  })();

  log('✓ זריעה הושלמה:');
  log(`  חברות בת חדשות: ${stats.subsidiaries} | שירותים: ${stats.services}`);
  log(`  טריגרים: ${stats.triggers} | מיפויי טריגר: ${stats.maps}`);
  log(`  לקוחות: ${stats.clients} | קשרי לקוח↔חברה: ${stats.links}`);
  if (Object.values(stats).every((v) => v === 0)) {
    log('  (הכול כבר היה קיים — לא נוצרו כפילויות)');
  }
  return stats;
}

if (import.meta.url === `file://${process.argv[1]}`) seed();
