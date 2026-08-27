import { db, uniqueSlug, audit } from '../db/index.js';
import { resolveClient } from '../scrapers/clients.js';

/**
 * ייבוא לקוחות מרשימה חופשית.
 * תומך בשורה-לשם, ב-CSV (שם, ענף, אתר) וב-Tab-separated — עם או בלי שורת כותרת.
 */
export function importClients(text, { subsidiaryId = null, relationship = 'customer', dryRun = false } = {}) {
  const d = db();
  const rows = String(text).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

  // דילוג על שורת כותרת נפוצה (\b לא עובד על עברית — משווים את השדה הראשון במלואו)
  const HEADERS = ['שם', 'שם לקוח', 'לקוח', 'name', 'client', 'company', 'customer'];
  if (rows.length && HEADERS.includes(rows[0].split(/\s*[,\t;]\s*/)[0].trim().toLowerCase())) rows.shift();

  const parsed = rows.map((line) => {
    const parts = line.split(/\s*[,\t;]\s*/);
    return {
      name: (parts[0] || '').trim(),
      industry: (parts[1] || '').trim() || null,
      website: (parts[2] || '').trim() || null,
    };
  }).filter((r) => r.name.length >= 2);

  const result = { parsed: parsed.length, created: 0, matched: 0, linked: 0, skipped: 0, rows: [] };
  if (!parsed.length) return result;

  const apply = () => {
    for (const r of parsed) {
      let client = resolveClient(r.name, r.name, r.website);
      let action;
      if (client) { action = 'matched'; result.matched++; }
      else {
        action = 'created';
        if (!dryRun) {
          const slug = uniqueSlug('clients', r.name);
          const info = d.prepare(`INSERT INTO clients (slug, name_he, industry, website, confidence, origin)
                                  VALUES (?, ?, ?, ?, 0.6, 'import')`)
            .run(slug, r.name, r.industry, r.website);
          client = d.prepare('SELECT * FROM clients WHERE id = ?').get(info.lastInsertRowid);
        }
        result.created++;
      }

      let linked = false;
      if (subsidiaryId && client) {
        const exists = d.prepare('SELECT 1 FROM client_subsidiary WHERE client_id = ? AND subsidiary_id = ?')
          .get(client.id, subsidiaryId);
        if (exists) result.skipped++;
        else {
          if (!dryRun) {
            d.prepare(`INSERT INTO client_subsidiary (client_id, subsidiary_id, relationship, confidence, origin)
                       VALUES (?, ?, ?, 0.6, 'import')`).run(client.id, subsidiaryId, relationship);
          }
          result.linked++; linked = true;
        }
      }
      result.rows.push({ name: r.name, action, linked, clientId: client?.id ?? null });
    }
  };

  if (dryRun) apply();
  else { d.transaction(apply)(); audit('clients', null, 'bulk_import', null, { ...result, rows: undefined }, 'ui'); }
  return result;
}
