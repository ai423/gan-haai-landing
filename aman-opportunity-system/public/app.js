// ═══════════════════════════════════════════════════════════════════════
//  מערכת ההזדמנויות של קבוצת אמן — ממשק
// ═══════════════════════════════════════════════════════════════════════

// ── עזרים ────────────────────────────────────────────────────────────────
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const fmtDate = (s) => (s ? new Date(s.replace(' ', 'T') + (s.includes('T') || s.includes('Z') ? '' : 'Z'))
  .toLocaleDateString('he-IL', { day: '2-digit', month: '2-digit', year: '2-digit' }) : '—');
const fmtDateTime = (s) => (s ? new Date(s.replace(' ', 'T') + 'Z')
  .toLocaleString('he-IL', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—');

async function api(path, options = {}) {
  const res = await fetch(`/api${path}`, {
    headers: { 'content-type': 'application/json' },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const json = await res.json().catch(() => ({ ok: false, error: `שגיאת רשת (${res.status})` }));
  if (!json.ok) throw new Error(json.error || 'שגיאה');
  return json.data;
}

function toast(msg, kind = '') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = msg;
  $('#toasts').append(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .4s'; }, 4200);
  setTimeout(() => el.remove(), 4800);
}

function modal(title, bodyHtml, { wide = false, footer = '' } = {}) {
  const root = $('#modal-root');
  root.innerHTML = `
    <div class="modal-backdrop" data-close>
      <div class="modal ${wide ? 'wide' : ''}">
        <div class="modal-head">
          <h2 style="margin:0">${esc(title)}</h2>
          <button class="sm" data-close>סגירה</button>
        </div>
        <div class="modal-body">${bodyHtml}</div>
        ${footer ? `<div class="modal-foot">${footer}</div>` : ''}
      </div>
    </div>`;
  root.querySelectorAll('[data-close]').forEach((b) =>
    b.addEventListener('click', (e) => { if (e.target === b) closeModal(); }));
  document.addEventListener('keydown', escClose);
  return root.querySelector('.modal');
}
const closeModal = () => { $('#modal-root').innerHTML = ''; document.removeEventListener('keydown', escClose); };
const escClose = (e) => { if (e.key === 'Escape') closeModal(); };

/** אוסף ערכי טופס מתוך אלמנטים עם data-name. */
function formValues(scope) {
  const out = {};
  $$('[data-name]', scope).forEach((el) => {
    const key = el.dataset.name;
    out[key] = el.type === 'checkbox' ? (el.checked ? 1 : 0)
             : el.dataset.json === 'true' ? el.value.split(',').map((s) => s.trim()).filter(Boolean)
             : el.value;
  });
  return out;
}

const scoreClass = (n) => (n >= 75 ? 's-hot' : n >= 60 ? 's-good' : n >= 40 ? 's-mid' : 's-low');
const confBar = (v) => `<span class="bar" style="display:inline-block;width:56px" title="ודאות ${Math.round((v ?? 0) * 100)}%"><i style="width:${Math.round((v ?? 0) * 100)}%"></i></span>`;

const ORIGIN_LABEL = { seed: 'זריעה', scrape: 'סריקה', manual: 'ידני', import: 'ייבוא', research: 'מחקר', engine: 'מנוע' };
const REL_LABEL = { customer: 'לקוח', case_study: 'מקרה בוחן', partner: 'שותף', prospect: 'ליד', former: 'לשעבר' };
const KIND_LABEL = { cross_sell: 'הכנסת חברת בת נוספת', upsell: 'הרחבה אצל לקוח קיים', new_logo: 'לקוח חדש' };
const STATUS_LABEL = { new: 'חדש', reviewed: 'נבדק', in_progress: 'בטיפול', won: 'נסגר בהצלחה', lost: 'אבוד', dismissed: 'נדחה',
                       confirmed: 'אושר', running: 'רץ', ok: 'הושלם', partial: 'חלקי', failed: 'נכשל' };
const CAT_LABEL = { financial: 'פיננסי', organizational: 'ארגוני', technological: 'טכנולוגי',
                    regulatory: 'רגולטורי', market: 'שוק' };

// ── Markdown מינימלי לתצוגת הדוחות ───────────────────────────────────────
function md(src) {
  const lines = String(src).split('\n');
  const out = [];
  let inTable = false, inList = false, inCode = false;
  const inline = (t) => esc(t)
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|\W)\*([^*]+)\*/g, '$1<em>$2</em>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');
  const closeList = () => { if (inList) { out.push('</ul>'); inList = false; } };
  const closeTable = () => { if (inTable) { out.push('</tbody></table>'); inTable = false; } };

  for (let raw of lines) {
    const line = raw.trimEnd();
    if (/^```/.test(line)) { inCode = !inCode; out.push(inCode ? '<pre class="log">' : '</pre>'); continue; }
    if (inCode) { out.push(esc(raw)); continue; }
    if (/^\s*\|/.test(line)) {
      const cells = line.split('|').slice(1, -1).map((c) => c.trim());
      if (/^[\s|:-]+$/.test(line)) continue;
      if (!inTable) { closeList(); out.push('<table><tbody>'); inTable = true;
        out.push('<tr>' + cells.map((c) => `<th>${inline(c)}</th>`).join('') + '</tr>'); continue; }
      out.push('<tr>' + cells.map((c) => `<td>${inline(c)}</td>`).join('') + '</tr>');
      continue;
    }
    closeTable();
    if (/^#{1,4}\s/.test(line)) {
      closeList();
      const level = line.match(/^#+/)[0].length;
      out.push(`<h${level}>${inline(line.replace(/^#+\s*/, ''))}</h${level}>`);
    } else if (/^[-*]\s+/.test(line)) {
      if (!inList) { out.push('<ul>'); inList = true; }
      out.push(`<li>${inline(line.replace(/^[-*]\s+/, ''))}</li>`);
    } else if (/^>\s?/.test(line)) {
      closeList(); out.push(`<blockquote>${inline(line.replace(/^>\s?/, ''))}</blockquote>`);
    } else if (/^(---|<details|<\/details|<summary|<\/summary)/.test(line)) {
      closeList(); out.push(line.startsWith('---') ? '<hr>' : line);
    } else if (!line.trim()) {
      closeList();
    } else {
      closeList(); out.push(`<p>${inline(line)}</p>`);
    }
  }
  closeList(); closeTable();
  return out.join('\n');
}

// ═══════════════════════════════════════════════════════════════════════
//  ניתוב
// ═══════════════════════════════════════════════════════════════════════
const ROUTES = [
  { id: 'dashboard',     label: 'לוח בקרה',       render: viewDashboard },
  { id: 'opportunities', label: 'הזדמנויות',       render: viewOpportunities, countKey: 'opportunities' },
  { id: 'clients',       label: 'לקוחות',          render: viewClients,       countKey: 'clients' },
  { id: 'subsidiaries',  label: 'חברות בת',        render: viewSubsidiaries,  countKey: 'subsidiaries' },
  { id: 'triggers',      label: 'טריגרים',         render: viewTriggers,      countKey: 'triggerTypes' },
  { id: 'signals',       label: 'אותות',           render: viewSignals,       countKey: 'signals' },
  { id: 'reports',       label: 'דוחות מנכ"ל',     render: viewReports },
  { id: 'system',        label: 'הרצות ותזמון',    render: viewSystem },
];

let STATS = {};

async function renderNav() {
  try { STATS = await api('/stats'); } catch { STATS = {}; }
  const current = (location.hash.slice(1).split('/')[0]) || 'dashboard';
  $('#nav').innerHTML = ROUTES.map((r) => `
    <a href="#${r.id}" class="${r.id === current ? 'active' : ''}">
      <span>${r.label}</span>
      ${r.countKey && STATS[r.countKey] !== undefined ? `<span class="count">${STATS[r.countKey]}</span>` : ''}
    </a>`).join('');

  try {
    const h = await api('/health');
    $('#health').innerHTML = `
      <div>${h.hasApiKey ? '<span class="tag ok">Claude מחובר</span>' : '<span class="tag danger">אין מפתח API</span>'}</div>
      <div style="margin-top:6px">${h.scheduler.enabled
        ? `<span class="tag ok">תזמון פעיל</span>` : `<span class="tag">תזמון כבוי</span>`}</div>
      <div style="margin-top:6px" class="small">${esc(h.model)}</div>`;
  } catch { /* השרת עדיין עולה */ }
}

async function route() {
  const [id, param] = location.hash.slice(1).split('/');
  const r = ROUTES.find((x) => x.id === id) ?? ROUTES[0];
  $('#view').innerHTML = '<div class="empty">טוען…</div>';
  await renderNav();
  try { await r.render($('#view'), param); }
  catch (err) { $('#view').innerHTML = `<div class="card"><h1>שגיאה</h1><p class="muted">${esc(err.message)}</p></div>`; }
}
window.addEventListener('hashchange', route);
window.addEventListener('DOMContentLoaded', route);

// ═══════════════════════════════════════════════════════════════════════
//  לוח בקרה
// ═══════════════════════════════════════════════════════════════════════
async function viewDashboard(root) {
  const [stats, opps, health] = await Promise.all([
    api('/stats'), api('/opportunities?minScore=45&limit=8'), api('/health'),
  ]);
  const kpi = (n, l, sub = '') =>
    `<div class="card kpi-card"><div class="n">${n}</div><div class="l">${l}</div>${sub ? `<div class="sub">${sub}</div>` : ''}</div>`;

  root.innerHTML = `
    <h1>לוח בקרה</h1>
    <p class="subtitle">תמונת מצב של הקבוצה: מי הלקוחות, מה קורה אצלם, ואיפה יש הזדמנות.</p>
    ${!health.hasApiKey ? `<div class="banner">
      <strong>לא הוגדר מפתח Claude API.</strong> סריקת האתרים והמחקר החודשי לא יפעלו.
      הוסיפו <code>ANTHROPIC_API_KEY</code> לקובץ <code>.env</code> והפעילו מחדש את השרת.
      מנוע ההצלבה והדוח הדטרמיניסטי עובדים גם בלעדיו.</div>` : ''}

    <div class="grid kpi">
      ${kpi(stats.subsidiaries, 'חברות בת פעילות', `${stats.services} שירותים`)}
      ${kpi(stats.clients, 'לקוחות', `${stats.sharedClients} משותפים לכמה חברות`)}
      ${kpi(stats.signals, 'אותות רכישה', `${stats.freshSignals} ב-30 הימים האחרונים`)}
      ${kpi(stats.opportunities, 'הזדמנויות פתוחות', `${stats.hotOpportunities} בציון 65+`)}
      ${kpi(stats.whitespace, 'שטח לבן', 'לקוח × חברת בת שטרם נכנסה')}
      ${kpi(stats.triggerTypes, 'סוגי טריגרים', 'בקטלוג')}
    </div>

    <div class="toolbar" style="margin-top:20px">
      <button class="primary" id="run-pipeline">הרץ מחקר + הצלבה + דוח</button>
      <button id="run-match">הצלבה מחדש (מהיר, בלי API)</button>
      <button id="run-report">ייצר דוח מנכ"ל</button>
      <span class="spacer"></span>
      <span class="small muted">מחקר אחרון: ${fmtDateTime(stats.lastResearch)}</span>
    </div>

    <h2>ההזדמנויות המובילות</h2>
    ${opps.length ? opps.map(oppCard).join('') : '<div class="card empty">אין עדיין הזדמנויות. הריצו מחקר, או טענו אותות הדגמה עם <code>node src/db/demo-signals.js</code>.</div>'}

    <div class="grid two" style="margin-top:22px">
      <div class="card">
        <h3>הזדמנויות לפי חברת בת</h3>
        ${stats.bySubsidiary.length ? `<table><tbody>${stats.bySubsidiary.map((r) => `
          <tr><td>${esc(r.name)}</td><td style="width:70px">${r.n}</td>
              <td class="muted small" style="width:90px">ציון ממוצע ${r.avg_score}</td></tr>`).join('')}</tbody></table>`
          : '<p class="muted small">אין נתונים.</p>'}
      </div>
      <div class="card">
        <h3>הטריגרים הנפוצים</h3>
        ${stats.topTriggers.length ? `<table><tbody>${stats.topTriggers.map((r) => `
          <tr><td>${esc(r.name)}</td><td style="width:60px">${r.n}</td></tr>`).join('')}</tbody></table>`
          : '<p class="muted small">אין אותות עדיין.</p>'}
      </div>
    </div>`;

  $('#run-pipeline').onclick = () => runAction('pipeline', {}, 'מחקר מלא + הצלבה + דוח');
  $('#run-match').onclick = () => runAction('match', {}, 'הצלבה');
  $('#run-report').onclick = () => runAction('report', {}, 'דוח מנכ"ל');
}

function oppCard(o) {
  const ev = (o.evidence ?? []).slice(0, 3);
  return `<div class="card" style="margin-bottom:10px">
    <div style="display:flex;justify-content:space-between;gap:12px;align-items:flex-start">
      <div style="min-width:0">
        <h3>${esc(o.subsidiary_name)} ← ${esc(o.client_name)}</h3>
        <div>${o.service_name ? `<span class="tag accent">${esc(o.service_name)}</span>` : ''}
             <span class="tag">${KIND_LABEL[o.kind] ?? o.kind}</span>
             ${(o.warm_intro_via ?? []).length ? `<span class="tag ok">דלת פתוחה: ${esc(o.warm_intro_via.join(', '))}</span>` : ''}</div>
      </div>
      <div class="score ${scoreClass(o.score)}" style="font-size:22px">${Math.round(o.score)}</div>
    </div>
    <p style="margin:9px 0 4px">${esc(o.rationale_he ?? '')}</p>
    ${ev.map((e) => `<div class="evidence">
      <strong>${esc(e.title ?? '')}</strong>${e.quote ? ` — "${esc(e.quote)}"` : ''}
      ${e.url ? ` <a href="${esc(e.url)}" target="_blank" rel="noopener">${esc(e.source || 'מקור')}${e.date ? ', ' + esc(e.date) : ''}</a>`
              : `<span class="muted"> (${esc(e.source || 'ללא מקור')})</span>`}
    </div>`).join('')}
  </div>`;
}

// ── הרצת פעולה ברקע ──────────────────────────────────────────────────────
async function runAction(action, body, label) {
  try {
    const job = await api(`/actions/${action}`, { method: 'POST', body });
    toast(`${label}: התחיל ברקע…`);
    pollJob(job.id, label);
  } catch (err) { toast(`${label}: ${err.message}`, 'err'); }
}

async function pollJob(id, label) {
  const tick = async () => {
    try {
      const job = await api(`/jobs/${id}`);
      if (job.status === 'running') return setTimeout(tick, 2500);
      if (job.status === 'ok') {
        toast(`${label}: הושלם ✓`, 'ok');
        if (job.result?.log) showJobLog(label, job.result);
        route();
      } else {
        toast(`${label}: נכשל — ${job.error}`, 'err');
        if (job.result?.log) showJobLog(label, job.result, job.error);
      }
    } catch (err) { toast(`${label}: ${err.message}`, 'err'); }
  };
  setTimeout(tick, 1800);
}

function showJobLog(label, result, error = null) {
  modal(`יומן: ${label}`, `
    ${error ? `<div class="banner">${esc(error)}</div>` : ''}
    <div class="log">${esc(result.log ?? '(אין יומן)')}</div>`, { wide: true });
}

// ═══════════════════════════════════════════════════════════════════════
//  הזדמנויות
// ═══════════════════════════════════════════════════════════════════════
async function viewOpportunities(root) {
  const [subs] = await Promise.all([api('/subsidiaries')]);
  root.innerHTML = `
    <h1>הזדמנויות</h1>
    <p class="subtitle">כל הזדמנות נשענת על אות מתועד. הציון מורכב ממשקל הטריגר, עוצמת האות, טריות המקור וחום הקשר.</p>
    <div class="toolbar">
      <select id="f-sub" style="width:210px"><option value="">כל חברות הבת</option>
        ${subs.map((s) => `<option value="${s.id}">${esc(s.name_he)}</option>`).join('')}</select>
      <select id="f-status" style="width:150px">
        <option value="">כל הסטטוסים</option>
        ${['new', 'reviewed', 'in_progress', 'won', 'lost', 'dismissed']
          .map((s) => `<option value="${s}">${STATUS_LABEL[s]}</option>`).join('')}</select>
      <select id="f-score" style="width:150px">
        <option value="0">כל הציונים</option><option value="40">40 ומעלה</option>
        <option value="60">60 ומעלה</option><option value="75">75 ומעלה</option></select>
      <span class="spacer"></span>
      <button id="rematch">הצלבה מחדש</button>
    </div>
    <div id="opp-list"></div>`;

  const load = async () => {
    const q = new URLSearchParams({
      subsidiaryId: $('#f-sub').value, status: $('#f-status').value, minScore: $('#f-score').value,
    });
    const list = await api(`/opportunities?${q}`);
    $('#opp-list').innerHTML = list.length ? `
      <div class="table-wrap"><table>
        <thead><tr><th>ציון</th><th>חברת בת</th><th>לקוח</th><th>שירות</th><th>סוג</th>
                   <th>הנמקה וראיות</th><th>סטטוס</th><th></th></tr></thead>
        <tbody>${list.map((o) => `
          <tr>
            <td class="score ${scoreClass(o.score)}">${Math.round(o.score)}</td>
            <td>${esc(o.subsidiary_name)}</td>
            <td><a href="#clients/${o.client_id}">${esc(o.client_name)}</a></td>
            <td class="small">${esc(o.service_name ?? '—')}</td>
            <td class="small muted">${KIND_LABEL[o.kind] ?? o.kind}</td>
            <td class="small" style="max-width:430px">${esc(o.rationale_he ?? '')}
              ${o.signal_url ? `<div><a href="${esc(o.signal_url)}" target="_blank" rel="noopener" class="small">${esc(o.signal_source || 'מקור')}${o.signal_date ? ', ' + esc(o.signal_date) : ''}</a></div>` : ''}</td>
            <td><select data-status="${o.id}" class="small">
              ${['new', 'reviewed', 'in_progress', 'won', 'lost', 'dismissed'].map((s) =>
                `<option value="${s}" ${o.status === s ? 'selected' : ''}>${STATUS_LABEL[s]}</option>`).join('')}
            </select></td>
            <td><button class="sm" data-detail="${o.id}">פירוט</button></td>
          </tr>`).join('')}</tbody>
      </table></div>` : '<div class="card empty">לא נמצאו הזדמנויות בסינון הזה.</div>';

    $$('[data-status]').forEach((sel) => sel.onchange = async () => {
      try { await api(`/opportunities/${sel.dataset.status}`, { method: 'PUT', body: { status: sel.value } });
            toast('הסטטוס עודכן', 'ok'); }
      catch (err) { toast(err.message, 'err'); }
    });
    $$('[data-detail]').forEach((b) => b.onclick = () => {
      const o = list.find((x) => x.id === Number(b.dataset.detail));
      modal(`${o.subsidiary_name} ← ${o.client_name}`, `
        ${oppCard(o)}
        <h3 style="margin-top:14px">פירוק הציון</h3>
        <div class="log">${esc(JSON.stringify(o.score_breakdown, null, 2))}</div>`, { wide: true });
    });
  };

  ['#f-sub', '#f-status', '#f-score'].forEach((s) => $(s).onchange = load);
  $('#rematch').onclick = () => runAction('match', {}, 'הצלבה');
  await load();
}

// ═══════════════════════════════════════════════════════════════════════
//  לקוחות
// ═══════════════════════════════════════════════════════════════════════
async function viewClients(root, param) {
  if (param) return viewClientDetail(root, Number(param));
  const subs = await api('/subsidiaries');

  root.innerHTML = `
    <h1>לקוחות</h1>
    <p class="subtitle">לקוח שמופיע אצל כמה חברות בת מופיע כאן פעם אחת, עם כל הקשרים שלו.</p>
    <div class="toolbar">
      <input id="f-q" placeholder="חיפוש לפי שם…" style="width:230px">
      <select id="f-sub" style="width:210px"><option value="">כל חברות הבת</option>
        ${subs.map((s) => `<option value="${s.id}">${esc(s.name_he)}</option>`).join('')}</select>
      <label style="display:flex;align-items:center;gap:6px;margin:0">
        <input type="checkbox" id="f-shared" style="width:auto"> רק לקוחות משותפים</label>
      <span class="spacer"></span>
      <button id="import">ייבוא מרשימה</button>
      <button class="primary" id="add">לקוח חדש</button>
    </div>
    <div id="client-list"></div>`;

  const load = async () => {
    const q = new URLSearchParams({
      q: $('#f-q').value, subsidiaryId: $('#f-sub').value, shared: $('#f-shared').checked,
    });
    const list = await api(`/clients?${q}`);
    $('#client-list').innerHTML = list.length ? `
      <div class="table-wrap"><table>
        <thead><tr><th>לקוח</th><th>ענף</th><th>חברות בת</th><th>אותות</th><th>הזדמנויות</th>
                   <th>מקור</th><th>מחקר אחרון</th><th></th></tr></thead>
        <tbody>${list.map((c) => `
          <tr>
            <td><a href="#clients/${c.id}"><strong>${esc(c.name_he)}</strong></a>
                ${c.name_en ? `<div class="small muted">${esc(c.name_en)}</div>` : ''}
                ${c.is_public ? `<span class="tag">${esc(c.ticker || 'ציבורית')}</span>` : ''}</td>
            <td class="small">${esc(c.industry ?? '—')}</td>
            <td class="small">${c.subsidiary_count > 1
              ? `<span class="tag ok">${c.subsidiary_count} חברות</span>` : ''}
              ${esc(c.subsidiary_names ?? '—')}</td>
            <td>${c.signal_count || '—'}</td>
            <td>${c.opportunity_count || '—'}</td>
            <td class="small muted">${ORIGIN_LABEL[c.origin] ?? c.origin}</td>
            <td class="small muted">${fmtDate(c.last_researched_at)}</td>
            <td style="white-space:nowrap">
              <button class="sm" data-research="${c.id}">מחקר</button>
              <button class="sm" data-edit="${c.id}">עריכה</button>
              <button class="sm danger" data-del="${c.id}">מחיקה</button></td>
          </tr>`).join('')}</tbody></table></div>`
      : '<div class="card empty">לא נמצאו לקוחות.</div>';

    $$('[data-edit]').forEach((b) => b.onclick = () => clientForm(list.find((c) => c.id === Number(b.dataset.edit)), load));
    $$('[data-del]').forEach((b) => b.onclick = async () => {
      const c = list.find((x) => x.id === Number(b.dataset.del));
      if (!confirm(`למחוק את «${c.name_he}»? כל הקשרים, האותות וההזדמנויות שלו יימחקו.`)) return;
      await api(`/clients/${c.id}`, { method: 'DELETE' });
      toast('הלקוח נמחק', 'ok'); load();
    });
    $$('[data-research]').forEach((b) => b.onclick = () =>
      runAction('research', { clientIds: [Number(b.dataset.research)] }, 'מחקר על לקוח'));
  };

  $('#f-q').oninput = debounce(load, 350);
  $('#f-sub').onchange = load;
  $('#f-shared').onchange = load;
  $('#add').onclick = () => clientForm(null, load);
  $('#import').onclick = () => importForm(subs, load);
  await load();
}

function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

function clientForm(client, onSaved) {
  const c = client ?? {};
  const m = modal(client ? `עריכת ${c.name_he}` : 'לקוח חדש', `
    <div class="row">
      <div class="field"><label>שם בעברית *</label><input data-name="name_he" value="${esc(c.name_he ?? '')}"></div>
      <div class="field"><label>שם באנגלית</label><input data-name="name_en" value="${esc(c.name_en ?? '')}"></div>
    </div>
    <div class="row">
      <div class="field"><label>ענף</label><input data-name="industry" value="${esc(c.industry ?? '')}"></div>
      <div class="field"><label>אתר</label><input data-name="website" value="${esc(c.website ?? '')}"></div>
    </div>
    <div class="row">
      <div class="field"><label>סימול בבורסה</label><input data-name="ticker" value="${esc(c.ticker ?? '')}"></div>
      <div class="field"><label>בורסה</label><input data-name="exchange" value="${esc(c.exchange ?? '')}"></div>
    </div>
    <div class="row">
      <div class="field"><label>גודל</label><select data-name="size_band">
        <option value="">—</option>${['SMB', 'Mid', 'Enterprise'].map((s) =>
          `<option ${c.size_band === s ? 'selected' : ''}>${s}</option>`).join('')}</select></div>
      <div class="field"><label>שמות חלופיים (מופרדים בפסיק)</label>
        <input data-name="aliases" data-json="true" value="${esc((c.aliases ?? []).join(', '))}"></div>
    </div>
    <div class="field"><label>הערות</label><textarea data-name="notes" style="min-height:70px">${esc(c.notes ?? '')}</textarea></div>
    <label style="display:flex;align-items:center;gap:7px">
      <input type="checkbox" data-name="is_public" style="width:auto" ${c.is_public ? 'checked' : ''}> חברה ציבורית</label>`,
    { footer: `<button class="primary" id="save">שמירה</button><button data-close>ביטול</button>` });

  $('#save', m).onclick = async () => {
    try {
      const body = formValues(m);
      if (client) await api(`/clients/${c.id}`, { method: 'PUT', body });
      else await api('/clients', { method: 'POST', body });
      toast('נשמר ✓', 'ok'); closeModal(); onSaved();
    } catch (err) { toast(err.message, 'err'); }
  };
}

function importForm(subs, onSaved) {
  const m = modal('ייבוא לקוחות מרשימה', `
    <p class="small muted">שורה לכל לקוח. אפשר גם CSV: <code>שם, ענף, אתר</code>. לקוח שכבר קיים במאגר יזוהה ולא ישוכפל.</p>
    <div class="field"><label>שיוך לחברת בת (אופציונלי)</label>
      <select data-name="subsidiaryId"><option value="">ללא שיוך</option>
        ${subs.map((s) => `<option value="${s.id}">${esc(s.name_he)}</option>`).join('')}</select></div>
    <div class="field"><label>סוג הקשר</label>
      <select data-name="relationship">${Object.entries(REL_LABEL).map(([k, v]) =>
        `<option value="${k}">${v}</option>`).join('')}</select></div>
    <div class="field"><label>הרשימה</label>
      <textarea data-name="text" placeholder="בנק לאומי, פיננסים, https://www.leumi.co.il&#10;נטפים, תעשייה&#10;רשות המסים"></textarea></div>
    <div id="preview"></div>`,
    { footer: `<button id="dry">בדיקה מקדימה</button><button class="primary" id="save">ייבוא</button><button data-close>ביטול</button>` });

  const run = async (dryRun) => {
    try {
      const r = await api('/import/clients', { method: 'POST', body: { ...formValues(m), dryRun } });
      $('#preview', m).innerHTML = `<div class="banner">
        זוהו ${r.parsed} שורות · ${r.created} חדשים · ${r.matched} כבר קיימים · ${r.linked} שיוכים חדשים
        ${r.skipped ? `· ${r.skipped} שיוכים כבר קיימים` : ''}
        ${dryRun ? '<br><strong>זו בדיקה בלבד — שום דבר לא נשמר.</strong>' : ''}</div>
        <div class="log">${esc(r.rows.map((x) => `${x.action === 'created' ? '+' : '='} ${x.name}${x.linked ? ' → שויך' : ''}`).join('\n'))}</div>`;
      if (!dryRun) { toast(`יובאו ${r.created} לקוחות חדשים`, 'ok'); onSaved(); }
    } catch (err) { toast(err.message, 'err'); }
  };
  $('#dry', m).onclick = () => run(true);
  $('#save', m).onclick = () => run(false);
}

async function viewClientDetail(root, id) {
  const [c, subs] = await Promise.all([api(`/clients/${id}`), api('/subsidiaries')]);
  root.innerHTML = `
    <div class="toolbar"><a href="#clients">← חזרה לרשימה</a><span class="spacer"></span>
      <button id="research">הרץ מחקר עכשיו</button>
      <button id="edit">עריכה</button></div>
    <h1>${esc(c.name_he)} ${c.name_en ? `<span class="muted small">${esc(c.name_en)}</span>` : ''}</h1>
    <p class="subtitle">
      ${c.industry ? `<span class="tag">${esc(c.industry)}</span>` : ''}
      ${c.is_public ? `<span class="tag accent">${esc(c.ticker || 'ציבורית')}${c.exchange ? ' · ' + esc(c.exchange) : ''}</span>` : ''}
      ${c.size_band ? `<span class="tag">${esc(c.size_band)}</span>` : ''}
      <span class="tag">מקור: ${ORIGIN_LABEL[c.origin] ?? c.origin}</span>
      ${c.website ? `<a href="${esc(c.website)}" target="_blank" rel="noopener">${esc(c.website)}</a>` : ''}
    </p>
    ${c.notes ? `<div class="card" style="margin-bottom:14px"><h3>פרופיל</h3><p class="small">${esc(c.notes)}</p></div>` : ''}

    <div class="grid two">
      <div class="card">
        <div style="display:flex;justify-content:space-between;align-items:center">
          <h3>חברות בת שעובדות איתו (${c.subsidiaries.length})</h3>
          <button class="sm" id="add-link">שיוך חברה</button>
        </div>
        ${c.subsidiaries.length ? `<table><tbody>${c.subsidiaries.map((s) => `
          <tr><td><a href="#subsidiaries/${s.subsidiary_id}">${esc(s.subsidiary_name)}</a>
                  <div class="small muted">${REL_LABEL[s.relationship] ?? s.relationship} · ${ORIGIN_LABEL[s.origin] ?? s.origin}</div>
                  ${s.evidence_text ? `<div class="evidence">${esc(s.evidence_text)}
                    ${s.evidence_url ? `<a href="${esc(s.evidence_url)}" target="_blank" rel="noopener">מקור</a>` : ''}</div>` : ''}</td>
              <td style="width:70px">${confBar(s.confidence)}</td>
              <td style="width:40px"><button class="sm danger" data-unlink="${s.id}">×</button></td></tr>`).join('')}</tbody></table>`
          : '<p class="muted small">אין שיוך לאף חברת בת.</p>'}
      </div>

      <div class="card">
        <div style="display:flex;justify-content:space-between;align-items:center">
          <h3>הזדמנויות (${c.opportunities.length})</h3></div>
        ${c.opportunities.length ? `<table><tbody>${c.opportunities.map((o) => `
          <tr><td class="score ${scoreClass(o.score)}" style="width:44px">${Math.round(o.score)}</td>
              <td>${esc(o.subsidiary_name)}${o.service_name ? ` · <span class="small muted">${esc(o.service_name)}</span>` : ''}
                  <div class="small">${esc(o.rationale_he ?? '')}</div></td></tr>`).join('')}</tbody></table>`
          : '<p class="muted small">אין הזדמנויות. הריצו מחקר ואז הצלבה.</p>'}
      </div>
    </div>

    <h2>אותות רכישה (${c.signals.length})</h2>
    <div class="toolbar"><button class="sm" id="add-signal">הוספת אות ידנית</button></div>
    ${c.signals.length ? `<div class="table-wrap"><table>
      <thead><tr><th>טריגר</th><th>אירוע</th><th>ראיה</th><th>תאריך</th><th>עוצמה</th><th>מקור</th><th></th></tr></thead>
      <tbody>${c.signals.map((s) => `
        <tr>
          <td class="small">${esc(s.trigger_name ?? '—')}<div class="muted small">${CAT_LABEL[s.trigger_category] ?? ''}</div></td>
          <td><strong>${esc(s.title_he)}</strong>${s.summary_he ? `<div class="small muted">${esc(s.summary_he)}</div>` : ''}</td>
          <td class="small" style="max-width:280px">${s.evidence_quote ? `"${esc(s.evidence_quote)}"` : '<span class="muted">—</span>'}
              ${s.evidence_url ? `<div><a href="${esc(s.evidence_url)}" target="_blank" rel="noopener">${esc(s.evidence_source ?? 'מקור')}</a></div>`
                               : s.evidence_source ? `<div class="muted small">${esc(s.evidence_source)}</div>` : ''}</td>
          <td class="small">${esc(s.evidence_date ?? '—')}</td>
          <td>${confBar(s.strength)}</td>
          <td class="small muted">${ORIGIN_LABEL[s.origin] ?? s.origin}</td>
          <td><button class="sm danger" data-delsig="${s.id}">×</button></td>
        </tr>`).join('')}</tbody></table></div>`
      : '<div class="card empty">אין אותות. הריצו מחקר או הוסיפו ידנית.</div>'}`;

  $('#edit').onclick = () => clientForm(c, () => route());
  $('#research').onclick = () => runAction('research', { clientIds: [c.id] }, `מחקר על ${c.name_he}`);
  $('#add-link').onclick = () => linkForm(c, subs);
  $('#add-signal').onclick = () => signalForm(c);
  $$('[data-unlink]').forEach((b) => b.onclick = async () => {
    if (!confirm('להסיר את השיוך?')) return;
    await api(`/links/${b.dataset.unlink}`, { method: 'DELETE' }); toast('הוסר', 'ok'); route();
  });
  $$('[data-delsig]').forEach((b) => b.onclick = async () => {
    if (!confirm('למחוק את האות? הזדמנויות שנשענות עליו ייעלמו בהצלבה הבאה.')) return;
    await api(`/signals/${b.dataset.delsig}`, { method: 'DELETE' }); toast('נמחק', 'ok'); route();
  });
}

function linkForm(client, subs) {
  const m = modal(`שיוך חברת בת ל${client.name_he}`, `
    <div class="field"><label>חברת בת *</label><select data-name="subsidiary_id">
      ${subs.map((s) => `<option value="${s.id}">${esc(s.name_he)}</option>`).join('')}</select></div>
    <div class="field"><label>סוג הקשר</label><select data-name="relationship">
      ${Object.entries(REL_LABEL).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></div>
    <div class="row">
      <div class="field"><label>שנת התחלה</label><input data-name="since_year" type="number" placeholder="2023"></div>
      <div class="field"><label>ודאות (0-1)</label><input data-name="confidence" type="number" step="0.05" min="0" max="1" value="0.9"></div>
    </div>
    <div class="field"><label>ראיה — מה מוכיח את הקשר</label><textarea data-name="evidence_text" style="min-height:60px"></textarea></div>
    <div class="field"><label>קישור למקור</label><input data-name="evidence_url" placeholder="https://…"></div>`,
    { footer: `<button class="primary" id="save">שמירה</button><button data-close>ביטול</button>` });

  $('#save', m).onclick = async () => {
    try {
      await api('/links', { method: 'POST', body: { ...formValues(m), client_id: client.id } });
      toast('השיוך נשמר ✓', 'ok'); closeModal(); route();
    } catch (err) { toast(err.message, 'err'); }
  };
}

async function signalForm(client) {
  const triggers = await api('/trigger-types');
  const m = modal(`אות חדש ל${client.name_he}`, `
    <div class="field"><label>טריגר *</label><select data-name="trigger_type_id">
      ${triggers.map((t) => `<option value="${t.id}">${esc(t.name_he)} (${CAT_LABEL[t.category] ?? t.category})</option>`).join('')}</select></div>
    <div class="field"><label>כותרת האירוע *</label><input data-name="title_he"></div>
    <div class="field"><label>תקציר</label><textarea data-name="summary_he" style="min-height:60px"></textarea></div>
    <div class="field"><label>ציטוט מהמקור (הראיה)</label><textarea data-name="evidence_quote" style="min-height:60px"></textarea></div>
    <div class="row">
      <div class="field"><label>קישור למקור</label><input data-name="evidence_url" placeholder="https://…"></div>
      <div class="field"><label>שם המקור</label><input data-name="evidence_source" placeholder="גלובס"></div>
    </div>
    <div class="row">
      <div class="field"><label>תאריך הפרסום</label><input data-name="evidence_date" type="date"></div>
      <div class="field"><label>עוצמה (0-1)</label><input data-name="strength" type="number" step="0.05" min="0" max="1" value="0.7"></div>
    </div>`,
    { footer: `<button class="primary" id="save">שמירה</button><button data-close>ביטול</button>` });

  $('#save', m).onclick = async () => {
    try {
      await api('/signals', { method: 'POST', body: { ...formValues(m), client_id: client.id } });
      toast('האות נשמר ✓', 'ok'); closeModal(); route();
    } catch (err) { toast(err.message, 'err'); }
  };
}

// ═══════════════════════════════════════════════════════════════════════
//  חברות בת
// ═══════════════════════════════════════════════════════════════════════
async function viewSubsidiaries(root, param) {
  if (param) return viewSubsidiaryDetail(root, Number(param));
  const list = await api('/subsidiaries');
  root.innerHTML = `
    <h1>חברות בת</h1>
    <p class="subtitle">מבנה הקבוצה, השירותים שכל חברה מוכרת, וסימני הרכישה שרלוונטיים לה.</p>
    <div class="toolbar">
      <button id="scrape">סרוק את אתר הקבוצה</button>
      <button id="scrape-clients">סרוק לקוחות מאתרי החברות</button>
      <span class="spacer"></span>
      <button class="primary" id="add">חברת בת חדשה</button>
    </div>
    <div class="table-wrap"><table>
      <thead><tr><th>חברה</th><th>תיאור</th><th>שירותים</th><th>לקוחות</th><th>טריגרים</th>
                 <th>ודאות</th><th>מקור</th><th></th></tr></thead>
      <tbody>${list.map((s) => `
        <tr>
          <td><a href="#subsidiaries/${s.id}"><strong>${esc(s.name_he)}</strong></a>
              ${s.website ? `<div class="small"><a href="${esc(s.website)}" target="_blank" rel="noopener">אתר</a></div>` : ''}</td>
          <td class="small" style="max-width:340px">${esc(s.description ?? '—')}</td>
          <td>${s.service_count}</td><td>${s.client_count}</td><td>${s.trigger_count}</td>
          <td>${confBar(s.confidence)}</td>
          <td class="small muted">${ORIGIN_LABEL[s.origin] ?? s.origin}</td>
          <td style="white-space:nowrap"><button class="sm" data-edit="${s.id}">עריכה</button>
              <button class="sm danger" data-del="${s.id}">מחיקה</button></td>
        </tr>`).join('')}</tbody></table></div>`;

  $('#add').onclick = () => subsidiaryForm(null);
  $('#scrape').onclick = () => runAction('scrape-group', {}, 'סריקת אתר הקבוצה');
  $('#scrape-clients').onclick = () => runAction('scrape-clients', {}, 'סריקת לקוחות');
  $$('[data-edit]').forEach((b) => b.onclick = () => subsidiaryForm(list.find((s) => s.id === Number(b.dataset.edit))));
  $$('[data-del]').forEach((b) => b.onclick = async () => {
    const s = list.find((x) => x.id === Number(b.dataset.del));
    if (!confirm(`למחוק את «${s.name_he}»? יימחקו גם השירותים, השיוכים וההזדמנויות שלה.`)) return;
    await api(`/subsidiaries/${s.id}`, { method: 'DELETE' }); toast('נמחק', 'ok'); route();
  });
}

function subsidiaryForm(sub) {
  const s = sub ?? {};
  const m = modal(sub ? `עריכת ${s.name_he}` : 'חברת בת חדשה', `
    <div class="row">
      <div class="field"><label>שם בעברית *</label><input data-name="name_he" value="${esc(s.name_he ?? '')}"></div>
      <div class="field"><label>שם באנגלית</label><input data-name="name_en" value="${esc(s.name_en ?? '')}"></div>
    </div>
    <div class="field"><label>אתר</label><input data-name="website" value="${esc(s.website ?? '')}"></div>
    <div class="field"><label>תיאור</label><textarea data-name="description" style="min-height:70px">${esc(s.description ?? '')}</textarea></div>
    <div class="row">
      <div class="field"><label>תחומים (מופרדים בפסיק)</label>
        <input data-name="domains" data-json="true" value="${esc((s.domains ?? []).join(', '))}"></div>
      <div class="field"><label>מדינה</label><input data-name="hq_country" value="${esc(s.hq_country ?? '')}" placeholder="IL"></div>
    </div>
    <div class="row">
      <div class="field"><label>סטטוס</label><select data-name="status">
        ${['active', 'inactive', 'merged'].map((v) => `<option value="${v}" ${s.status === v ? 'selected' : ''}>${
          { active: 'פעילה', inactive: 'לא פעילה', merged: 'מוזגה' }[v]}</option>`).join('')}</select></div>
      <div class="field"><label>ודאות (0-1)</label>
        <input data-name="confidence" type="number" step="0.05" min="0" max="1" value="${s.confidence ?? 0.9}"></div>
    </div>`,
    { footer: `<button class="primary" id="save">שמירה</button><button data-close>ביטול</button>` });

  $('#save', m).onclick = async () => {
    try {
      const body = formValues(m);
      if (sub) await api(`/subsidiaries/${s.id}`, { method: 'PUT', body });
      else await api('/subsidiaries', { method: 'POST', body });
      toast('נשמר ✓', 'ok'); closeModal(); route();
    } catch (err) { toast(err.message, 'err'); }
  };
}

async function viewSubsidiaryDetail(root, id) {
  const [s, triggers] = await Promise.all([api(`/subsidiaries/${id}`), api('/trigger-types')]);
  root.innerHTML = `
    <div class="toolbar"><a href="#subsidiaries">← חזרה</a><span class="spacer"></span>
      <button id="edit">עריכה</button></div>
    <h1>${esc(s.name_he)} ${s.name_en ? `<span class="muted small">${esc(s.name_en)}</span>` : ''}</h1>
    <p class="subtitle">${esc(s.description ?? '')}
      ${s.website ? ` · <a href="${esc(s.website)}" target="_blank" rel="noopener">${esc(s.website)}</a>` : ''}</p>

    <div class="grid two">
      <div class="card">
        <div style="display:flex;justify-content:space-between;align-items:center">
          <h3>שירותים (${s.services.length})</h3><button class="sm" id="add-svc">הוספה</button></div>
        <table><tbody>${s.services.map((v) => `
          <tr><td><strong>${esc(v.name_he)}</strong>
                  ${v.category ? `<span class="tag">${esc(v.category)}</span>` : ''}
                  ${v.description ? `<div class="small muted">${esc(v.description)}</div>` : ''}
                  ${(v.keywords ?? []).length ? `<div class="small muted">מילות מפתח: ${esc(v.keywords.join(', '))}</div>` : ''}</td>
              <td style="width:80px;white-space:nowrap"><button class="sm" data-svc-edit="${v.id}">עריכה</button>
                  <button class="sm danger" data-svc-del="${v.id}">×</button></td></tr>`).join('')
          || '<tr><td class="muted small">אין שירותים.</td></tr>'}</tbody></table>
      </div>

      <div class="card">
        <h3>לקוחות (${s.clients.length})</h3>
        <table><tbody>${s.clients.map((c) => `
          <tr><td><a href="#clients/${c.id}">${esc(c.name_he)}</a>
                  <span class="tag">${REL_LABEL[c.relationship] ?? c.relationship}</span>
                  ${c.industry ? `<span class="small muted">${esc(c.industry)}</span>` : ''}</td>
              <td style="width:70px">${confBar(c.confidence)}</td></tr>`).join('')
          || '<tr><td class="muted small">אין לקוחות משויכים.</td></tr>'}</tbody></table>
      </div>
    </div>

    <h2>סימני רכישה שרלוונטיים לחברה (${s.triggers.length})</h2>
    <p class="subtitle">כל שורה אומרת: כשקורה הטריגר הזה אצל לקוח — זו הזדמנות לשירות הזה, במשקל הזה.</p>
    <div class="toolbar"><button class="sm" id="add-trig">הוספת מיפוי</button></div>
    <div class="table-wrap"><table>
      <thead><tr><th>טריגר</th><th>קטגוריה</th><th>שירות</th><th>משקל</th><th>הנמקה</th><th></th></tr></thead>
      <tbody>${s.triggers.map((t) => `
        <tr><td>${esc(t.trigger_name)}</td>
            <td class="small muted">${CAT_LABEL[t.category] ?? t.category}</td>
            <td class="small">${esc(t.service_name ?? '—')}</td>
            <td>${confBar(t.weight)} <span class="small">${t.weight}</span></td>
            <td class="small" style="max-width:400px">${esc(t.rationale_he ?? '')}</td>
            <td style="white-space:nowrap"><button class="sm" data-trig-edit="${t.id}">עריכה</button>
                <button class="sm danger" data-trig-del="${t.id}">×</button></td></tr>`).join('')
        || '<tr><td colspan="6" class="muted small">אין מיפויי טריגר.</td></tr>'}</tbody></table></div>`;

  $('#edit').onclick = () => subsidiaryForm(s);
  $('#add-svc').onclick = () => serviceForm(null, s);
  $('#add-trig').onclick = () => mappingForm(null, s, triggers);
  $$('[data-svc-edit]').forEach((b) => b.onclick = () =>
    serviceForm(s.services.find((v) => v.id === Number(b.dataset.svcEdit)), s));
  $$('[data-svc-del]').forEach((b) => b.onclick = async () => {
    if (!confirm('למחוק את השירות?')) return;
    await api(`/services/${b.dataset.svcDel}`, { method: 'DELETE' }); toast('נמחק', 'ok'); route();
  });
  $$('[data-trig-edit]').forEach((b) => b.onclick = () =>
    mappingForm(s.triggers.find((t) => t.id === Number(b.dataset.trigEdit)), s, triggers));
  $$('[data-trig-del]').forEach((b) => b.onclick = async () => {
    if (!confirm('למחוק את המיפוי?')) return;
    await api(`/subsidiary-triggers/${b.dataset.trigDel}`, { method: 'DELETE' }); toast('נמחק', 'ok'); route();
  });
}

function serviceForm(svc, sub) {
  const v = svc ?? {};
  const CATS = ['data', 'cyber', 'cloud', 'infrastructure', 'digital', 'marketing', 'crm', 'cx', 'ai', 'hr', 'consulting', 'product'];
  const m = modal(svc ? `עריכת ${v.name_he}` : `שירות חדש ל${sub.name_he}`, `
    <div class="row">
      <div class="field"><label>שם בעברית *</label><input data-name="name_he" value="${esc(v.name_he ?? '')}"></div>
      <div class="field"><label>שם באנגלית</label><input data-name="name_en" value="${esc(v.name_en ?? '')}"></div>
    </div>
    <div class="field"><label>קטגוריה</label><select data-name="category">
      <option value="">—</option>${CATS.map((c) => `<option ${v.category === c ? 'selected' : ''}>${c}</option>`).join('')}</select></div>
    <div class="field"><label>תיאור</label><textarea data-name="description" style="min-height:60px">${esc(v.description ?? '')}</textarea></div>
    <div class="field"><label>מילות מפתח (מופרדות בפסיק) — משמשות לזיהוי התאמה בכתבות</label>
      <input data-name="keywords" data-json="true" value="${esc((v.keywords ?? []).join(', '))}"></div>`,
    { footer: `<button class="primary" id="save">שמירה</button><button data-close>ביטול</button>` });

  $('#save', m).onclick = async () => {
    try {
      const body = { ...formValues(m), subsidiary_id: sub.id };
      if (svc) await api(`/services/${v.id}`, { method: 'PUT', body });
      else await api('/services', { method: 'POST', body });
      toast('נשמר ✓', 'ok'); closeModal(); route();
    } catch (err) { toast(err.message, 'err'); }
  };
}

function mappingForm(mapping, sub, triggers) {
  const t = mapping ?? {};
  const m = modal(mapping ? 'עריכת מיפוי' : `מיפוי טריגר חדש ל${sub.name_he}`, `
    <div class="field"><label>טריגר *</label><select data-name="trigger_type_id">
      ${triggers.map((x) => `<option value="${x.id}" ${t.trigger_type_id === x.id ? 'selected' : ''}>
        ${esc(x.name_he)} (${CAT_LABEL[x.category] ?? x.category})</option>`).join('')}</select></div>
    <div class="field"><label>שירות רלוונטי</label><select data-name="service_id">
      <option value="">— כללי —</option>
      ${sub.services.map((v) => `<option value="${v.id}" ${t.service_id === v.id ? 'selected' : ''}>${esc(v.name_he)}</option>`).join('')}</select></div>
    <div class="field"><label>משקל (0-1) — עד כמה הטריגר מנבא צורך בשירות</label>
      <input data-name="weight" type="number" step="0.05" min="0" max="1" value="${t.weight ?? 0.7}"></div>
    <div class="field"><label>הנמקה — מדוע הטריגר הזה מייצר צורך</label>
      <textarea data-name="rationale_he" style="min-height:70px">${esc(t.rationale_he ?? '')}</textarea></div>`,
    { footer: `<button class="primary" id="save">שמירה</button><button data-close>ביטול</button>` });

  $('#save', m).onclick = async () => {
    try {
      const body = { ...formValues(m), subsidiary_id: sub.id };
      if (mapping) await api(`/subsidiary-triggers/${t.id}`, { method: 'PUT', body });
      else await api('/subsidiary-triggers', { method: 'POST', body });
      toast('נשמר ✓', 'ok'); closeModal(); route();
    } catch (err) { toast(err.message, 'err'); }
  };
}

// ═══════════════════════════════════════════════════════════════════════
//  קטלוג טריגרים
// ═══════════════════════════════════════════════════════════════════════
async function viewTriggers(root) {
  const list = await api('/trigger-types');
  root.innerHTML = `
    <h1>קטלוג הטריגרים</h1>
    <p class="subtitle">סימני הרכישה שהמערכת מחפשת ברשת. כל טריגר ממופה לחברות בת ולשירותים בעמוד של כל חברה.</p>
    <div class="toolbar"><span class="spacer"></span><button class="primary" id="add">טריגר חדש</button></div>
    <div class="table-wrap"><table>
      <thead><tr><th>טריגר</th><th>קטגוריה</th><th>תיאור</th><th>מילות מפתח</th>
                 <th>משקל</th><th>תוקף</th><th>מיפויים</th><th>אותות</th><th></th></tr></thead>
      <tbody>${list.map((t) => `
        <tr>
          <td><strong>${esc(t.name_he)}</strong><div class="small muted">${esc(t.code)}</div></td>
          <td class="small">${CAT_LABEL[t.category] ?? t.category}</td>
          <td class="small" style="max-width:300px">${esc(t.description ?? '')}</td>
          <td class="small muted" style="max-width:250px">${esc((t.keywords ?? []).slice(0, 6).join(', '))}</td>
          <td>${confBar(t.base_weight)}</td>
          <td class="small">${t.decay_days} י׳</td>
          <td>${t.mapping_count}</td><td>${t.signal_count}</td>
          <td style="white-space:nowrap"><button class="sm" data-edit="${t.id}">עריכה</button>
              <button class="sm danger" data-del="${t.id}">×</button></td>
        </tr>`).join('')}</tbody></table></div>`;

  $('#add').onclick = () => triggerForm(null);
  $$('[data-edit]').forEach((b) => b.onclick = () => triggerForm(list.find((t) => t.id === Number(b.dataset.edit))));
  $$('[data-del]').forEach((b) => b.onclick = async () => {
    if (!confirm('למחוק את הטריגר? המיפויים והאותות שקשורים אליו יושפעו.')) return;
    await api(`/trigger-types/${b.dataset.del}`, { method: 'DELETE' }); toast('נמחק', 'ok'); route();
  });
}

function triggerForm(trig) {
  const t = trig ?? {};
  const m = modal(trig ? `עריכת ${t.name_he}` : 'טריגר חדש', `
    <div class="row">
      <div class="field"><label>שם בעברית *</label><input data-name="name_he" value="${esc(t.name_he ?? '')}"></div>
      <div class="field"><label>קטגוריה</label><select data-name="category">
        ${Object.entries(CAT_LABEL).map(([k, v]) => `<option value="${k}" ${t.category === k ? 'selected' : ''}>${v}</option>`).join('')}</select></div>
    </div>
    <div class="field"><label>תיאור — מדוע זה סימן רכישה</label>
      <textarea data-name="description" style="min-height:60px">${esc(t.description ?? '')}</textarea></div>
    <div class="field"><label>מילות מפתח (מופרדות בפסיק, עברית ואנגלית)</label>
      <input data-name="keywords" data-json="true" value="${esc((t.keywords ?? []).join(', '))}"></div>
    <div class="row">
      <div class="field"><label>משקל בסיס (0-1)</label>
        <input data-name="base_weight" type="number" step="0.05" min="0" max="1" value="${t.base_weight ?? 0.6}"></div>
      <div class="field"><label>תוקף בימים — כמה זמן האירוע נשאר רלוונטי</label>
        <input data-name="decay_days" type="number" value="${t.decay_days ?? 180}"></div>
    </div>`,
    { footer: `<button class="primary" id="save">שמירה</button><button data-close>ביטול</button>` });

  $('#save', m).onclick = async () => {
    try {
      const body = formValues(m);
      if (trig) await api(`/trigger-types/${t.id}`, { method: 'PUT', body });
      else await api('/trigger-types', { method: 'POST', body });
      toast('נשמר ✓', 'ok'); closeModal(); route();
    } catch (err) { toast(err.message, 'err'); }
  };
}

// ═══════════════════════════════════════════════════════════════════════
//  אותות
// ═══════════════════════════════════════════════════════════════════════
async function viewSignals(root) {
  const list = await api('/signals?limit=400');
  root.innerHTML = `
    <h1>אותות רכישה</h1>
    <p class="subtitle">כל מה שנמצא ברשת על הלקוחות. אות בלי מקור לא נכנס למאגר.</p>
    <div class="toolbar">
      <button id="research-stale">מחקר על לקוחות שלא נבדקו 25 יום</button>
      <span class="spacer"></span>
      <span class="small muted">${list.length} אותות</span>
    </div>
    ${list.length ? `<div class="table-wrap"><table>
      <thead><tr><th>לקוח</th><th>טריגר</th><th>אירוע</th><th>ראיה</th><th>תאריך</th>
                 <th>עוצמה</th><th>סטטוס</th><th></th></tr></thead>
      <tbody>${list.map((s) => `
        <tr>
          <td><a href="#clients/${s.client_id}">${esc(s.client_name)}</a></td>
          <td class="small">${esc(s.trigger_name ?? '—')}</td>
          <td><strong>${esc(s.title_he)}</strong>
              ${s.summary_he ? `<div class="small muted">${esc(s.summary_he)}</div>` : ''}</td>
          <td class="small" style="max-width:260px">${s.evidence_quote ? `"${esc(s.evidence_quote)}"` : ''}
              ${s.evidence_url ? `<div><a href="${esc(s.evidence_url)}" target="_blank" rel="noopener">${esc(s.evidence_source ?? 'מקור')}</a></div>`
                               : `<div class="muted">${esc(s.evidence_source ?? '—')}</div>`}</td>
          <td class="small">${esc(s.evidence_date ?? '—')}</td>
          <td>${confBar(s.strength)}</td>
          <td><select data-sig-status="${s.id}" class="small">
            ${['new', 'confirmed', 'dismissed'].map((v) =>
              `<option value="${v}" ${s.status === v ? 'selected' : ''}>${STATUS_LABEL[v]}</option>`).join('')}</select></td>
          <td><button class="sm danger" data-del="${s.id}">×</button></td>
        </tr>`).join('')}</tbody></table></div>`
      : '<div class="card empty">אין אותות עדיין.</div>'}`;

  $('#research-stale').onclick = () => runAction('research', { staleDays: 25 }, 'מחקר על לקוחות ותיקים');
  $$('[data-sig-status]').forEach((sel) => sel.onchange = async () => {
    try { await api(`/signals/${sel.dataset.sigStatus}`, { method: 'PUT', body: { status: sel.value } });
          toast('עודכן', 'ok'); } catch (err) { toast(err.message, 'err'); }
  });
  $$('[data-del]').forEach((b) => b.onclick = async () => {
    if (!confirm('למחוק את האות?')) return;
    await api(`/signals/${b.dataset.del}`, { method: 'DELETE' }); toast('נמחק', 'ok'); route();
  });
}

// ═══════════════════════════════════════════════════════════════════════
//  דוחות
// ═══════════════════════════════════════════════════════════════════════
async function viewReports(root, param) {
  if (param) {
    const r = await api(`/reports/${param}`);
    root.innerHTML = `
      <div class="toolbar"><a href="#reports">← חזרה לדוחות</a><span class="spacer"></span>
        <a class="btn" href="/api/reports/${r.id}/markdown">הורדה כ-Markdown</a>
        <button id="print">הדפסה</button></div>
      <div class="report-body">${md(r.content_md)}</div>`;
    $('#print').onclick = () => window.print();
    return;
  }

  const list = await api('/reports');
  root.innerHTML = `
    <h1>דוחות מנכ"ל</h1>
    <p class="subtitle">סיכום תקופתי: איזו חברת בת יכולה להציע מה לאיזה לקוח, ולמה — עם ראיות.</p>
    <div class="toolbar">
      <button class="primary" id="gen">ייצר דוח עכשיו</button>
      <button id="gen-plain">דוח בלי AI (דטרמיניסטי)</button>
      <span class="spacer"></span>
      <a class="btn" href="/api/export">ייצוא כל הנתונים (JSON)</a>
    </div>
    ${list.length ? `<div class="table-wrap"><table>
      <thead><tr><th>דוח</th><th>תקופה</th><th>נוצר</th><th>הזדמנויות</th><th>אופן יצירה</th><th></th></tr></thead>
      <tbody>${list.map((r) => `
        <tr><td><a href="#reports/${r.id}"><strong>${esc(r.title)}</strong></a></td>
            <td class="small">${esc(r.period_label ?? '')}</td>
            <td class="small">${fmtDateTime(r.generated_at)}</td>
            <td>${r.meta?.opportunities_included ?? '—'}</td>
            <td class="small">${r.meta?.mode === 'ai' ? '<span class="tag accent">Claude</span>' : '<span class="tag">דטרמיניסטי</span>'}</td>
            <td><button class="sm danger" data-del="${r.id}">מחיקה</button></td></tr>`).join('')}</tbody></table></div>`
      : '<div class="card empty">אין דוחות עדיין.</div>'}`;

  $('#gen').onclick = () => runAction('report', {}, 'דוח מנכ"ל');
  $('#gen-plain').onclick = () => runAction('report', { useAi: false }, 'דוח דטרמיניסטי');
  $$('[data-del]').forEach((b) => b.onclick = async () => {
    if (!confirm('למחוק את הדוח?')) return;
    await api(`/reports/${b.dataset.del}`, { method: 'DELETE' }); toast('נמחק', 'ok'); route();
  });
}

// ═══════════════════════════════════════════════════════════════════════
//  הרצות ותזמון
// ═══════════════════════════════════════════════════════════════════════
async function viewSystem(root) {
  const [runs, sched, health, audit] = await Promise.all([
    api('/runs'), api('/scheduler'), api('/health'), api('/audit?limit=60'),
  ]);
  const KIND = { scrape_group: 'סריקת קבוצה', scrape_clients: 'סריקת לקוחות', research: 'מחקר',
                 match: 'הצלבה', report: 'דוח', pipeline: 'צינור מלא' };
  const badge = (s) => `<span class="tag ${s === 'ok' ? 'ok' : s === 'failed' ? 'danger' : s === 'partial' ? 'warn' : ''}">${STATUS_LABEL[s] ?? s}</span>`;

  root.innerHTML = `
    <h1>הרצות ותזמון</h1>
    <p class="subtitle">הרצה ידנית, מצב התזמון החודשי, ויומן כל השינויים במאגר.</p>

    <div class="grid two">
      <div class="card">
        <h3>תזמון חודשי</h3>
        <p class="small">מצב: ${sched.enabled ? '<span class="tag ok">פעיל</span>' : '<span class="tag warn">כבוי</span>'}
          · ביטוי: <code>${esc(sched.expression)}</code> · אזור זמן: ${esc(sched.timezone)}</p>
        <p class="small muted">הרצה אחרונה: ${fmtDateTime(sched.lastRun)} ${sched.lastStatus ? badge(sched.lastStatus) : ''}</p>
        <p class="small muted">${esc(sched.nextRun ?? 'התזמון כבוי')}</p>
        <div class="toolbar" style="margin:10px 0 0">
          <button id="sched-start" ${sched.enabled ? 'disabled' : ''}>הפעלה</button>
          <button id="sched-stop" ${sched.enabled ? '' : 'disabled'}>עצירה</button>
        </div>
        <p class="small muted" style="margin-top:8px">לשינוי המועד: ערכו <code>RESEARCH_CRON</code> בקובץ <code>.env</code> והפעילו מחדש.</p>
      </div>

      <div class="card">
        <h3>הרצה ידנית</h3>
        <p class="small muted">${health.hasApiKey ? `מחובר ל-${esc(health.model)}`
          : '<span class="tag danger">אין מפתח API</span> — רק הצלבה ודוח דטרמיניסטי יעבדו.'}</p>
        <div class="grid" style="grid-template-columns:1fr 1fr;gap:7px;margin-top:8px">
          <button data-run="scrape-group">סריקת אתר הקבוצה</button>
          <button data-run="scrape-clients">סריקת לקוחות</button>
          <button data-run="research">מחקר על כל הלקוחות</button>
          <button data-run="match">הצלבה</button>
          <button data-run="report">דוח מנכ"ל</button>
          <button class="primary" data-run="pipeline">צינור מלא</button>
        </div>
      </div>
    </div>

    <h2>הרצות אחרונות</h2>
    <div class="table-wrap"><table>
      <thead><tr><th>סוג</th><th>מקור</th><th>סטטוס</th><th>קלט</th><th>פלט</th>
                 <th>טוקנים</th><th>התחלה</th><th>סיום</th><th></th></tr></thead>
      <tbody>${runs.map((r) => `
        <tr><td>${KIND[r.kind] ?? r.kind}</td>
            <td class="small muted">${r.trigger_mode === 'scheduled' ? 'מתוזמן' : 'ידני'}</td>
            <td>${badge(r.status)}</td><td>${r.items_in ?? 0}</td><td>${r.items_out ?? 0}</td>
            <td class="small">${(r.tokens_in ?? 0) + (r.tokens_out ?? 0) || '—'}</td>
            <td class="small">${fmtDateTime(r.started_at)}</td>
            <td class="small">${fmtDateTime(r.finished_at)}</td>
            <td><button class="sm" data-log="${r.id}">יומן</button></td></tr>`).join('')
        || '<tr><td colspan="9" class="muted small">אין הרצות.</td></tr>'}</tbody></table></div>

    <h2>יומן שינויים</h2>
    <div class="table-wrap" style="max-height:340px"><table>
      <thead><tr><th>מתי</th><th>ישות</th><th>פעולה</th><th>מבצע</th></tr></thead>
      <tbody>${audit.map((a) => `
        <tr><td class="small">${fmtDateTime(a.at)}</td>
            <td class="small">${esc(a.entity)}${a.entity_id ? ` #${a.entity_id}` : ''}</td>
            <td class="small">${esc(a.action)}</td><td class="small muted">${esc(a.actor)}</td></tr>`).join('')}</tbody></table></div>`;

  $('#sched-start').onclick = async () => { await api('/scheduler/start', { method: 'POST' }); toast('התזמון הופעל', 'ok'); route(); };
  $('#sched-stop').onclick = async () => { await api('/scheduler/stop', { method: 'POST' }); toast('התזמון נעצר', 'ok'); route(); };
  $$('[data-run]').forEach((b) => b.onclick = () => runAction(b.dataset.run, {}, b.textContent.trim()));
  $$('[data-log]').forEach((b) => b.onclick = async () => {
    const r = await api(`/runs/${b.dataset.log}`);
    modal(`יומן הרצה #${r.id}`, `
      ${r.error ? `<div class="banner">${esc(r.error)}</div>` : ''}
      <div class="log">${esc(r.log ?? '(אין יומן)')}</div>`, { wide: true });
  });
}
