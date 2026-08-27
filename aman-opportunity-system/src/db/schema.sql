-- ═══════════════════════════════════════════════════════════════════════
--  Aman Opportunity System — סכימת בסיס נתונים
--  כל טבלה נושאת שדות מקור/אמינות כדי שכל תובנה תהיה ניתנת להוכחה.
-- ═══════════════════════════════════════════════════════════════════════

PRAGMA foreign_keys = ON;

-- ── חברות בת ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS subsidiaries (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  slug          TEXT NOT NULL UNIQUE,
  name_he       TEXT NOT NULL,
  name_en       TEXT,
  website       TEXT,
  description   TEXT,
  domains       TEXT,              -- JSON array: תחומי פעילות
  hq_country    TEXT,
  founded_year  INTEGER,
  joined_year   INTEGER,           -- שנת הצטרפות לקבוצת אמן
  status        TEXT NOT NULL DEFAULT 'active'
                CHECK (status IN ('active','inactive','merged')),
  source_url    TEXT,
  confidence    REAL NOT NULL DEFAULT 0.5,
  origin        TEXT NOT NULL DEFAULT 'seed'
                CHECK (origin IN ('seed','scrape','manual','import')),
  last_scraped_at TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ── שירותים שכל חברת בת מספקת ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS services (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  subsidiary_id  INTEGER NOT NULL REFERENCES subsidiaries(id) ON DELETE CASCADE,
  slug           TEXT NOT NULL,
  name_he        TEXT NOT NULL,
  name_en        TEXT,
  category       TEXT,             -- data | cyber | cloud | digital | hr | product | consulting ...
  description    TEXT,
  keywords       TEXT,             -- JSON array: מילים שמסמנות התאמה
  source_url     TEXT,
  origin         TEXT NOT NULL DEFAULT 'seed'
                 CHECK (origin IN ('seed','scrape','manual','import')),
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (subsidiary_id, slug)
);

-- ── לקוחות ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS clients (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  slug           TEXT NOT NULL UNIQUE,
  name_he        TEXT NOT NULL,
  name_en        TEXT,
  aliases        TEXT,             -- JSON array: שמות נוספים, לצורך מיזוג כפילויות
  website        TEXT,
  industry       TEXT,             -- פיננסים | ביטחון | קמעונאות | תקשורת | בריאות | היי-טק | ממשלה ...
  sector         TEXT,
  country        TEXT DEFAULT 'IL',
  is_public      INTEGER NOT NULL DEFAULT 0,
  ticker         TEXT,             -- סימול בבורסה (TASE / NASDAQ)
  exchange       TEXT,
  size_band      TEXT,             -- SMB | Mid | Enterprise
  employees_est  INTEGER,
  logo_url       TEXT,
  notes          TEXT,
  source_url     TEXT,
  confidence     REAL NOT NULL DEFAULT 0.5,
  origin         TEXT NOT NULL DEFAULT 'seed'
                 CHECK (origin IN ('seed','scrape','manual','import')),
  last_researched_at TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ── קשר לקוח ↔ חברת בת (לקוח משותף = כמה שורות לאותו client_id) ────────
CREATE TABLE IF NOT EXISTS client_subsidiary (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id      INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  subsidiary_id  INTEGER NOT NULL REFERENCES subsidiaries(id) ON DELETE CASCADE,
  relationship   TEXT NOT NULL DEFAULT 'customer'
                 CHECK (relationship IN ('customer','case_study','partner','prospect','former')),
  since_year     INTEGER,
  service_ids    TEXT,             -- JSON array של services.id הידועים בקשר הזה
  evidence_url   TEXT,
  evidence_text  TEXT,
  confidence     REAL NOT NULL DEFAULT 0.5,
  origin         TEXT NOT NULL DEFAULT 'seed'
                 CHECK (origin IN ('seed','scrape','manual','import')),
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (client_id, subsidiary_id)
);

-- ── קטלוג טריגרים גלובלי (סימני רכישה) ─────────────────────────────────
CREATE TABLE IF NOT EXISTS trigger_types (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  code           TEXT NOT NULL UNIQUE,
  name_he        TEXT NOT NULL,
  name_en        TEXT,
  category       TEXT NOT NULL,    -- financial | organizational | technological | regulatory | market
  description    TEXT,
  keywords       TEXT,             -- JSON array: מילות מפתח לזיהוי (עברית+אנגלית)
  base_weight    REAL NOT NULL DEFAULT 0.5,
  decay_days     INTEGER NOT NULL DEFAULT 180,  -- כמה זמן הטריגר נשאר רלוונטי
  is_active      INTEGER NOT NULL DEFAULT 1,
  origin         TEXT NOT NULL DEFAULT 'seed'
                 CHECK (origin IN ('seed','manual','import')),
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ── מיפוי: אילו טריגרים רלוונטיים לאיזו חברת בת, ובאיזה משקל ───────────
CREATE TABLE IF NOT EXISTS subsidiary_triggers (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  subsidiary_id   INTEGER NOT NULL REFERENCES subsidiaries(id) ON DELETE CASCADE,
  trigger_type_id INTEGER NOT NULL REFERENCES trigger_types(id) ON DELETE CASCADE,
  service_id      INTEGER REFERENCES services(id) ON DELETE SET NULL,
  weight          REAL NOT NULL DEFAULT 0.5,     -- 0..1 עד כמה הטריגר מנבא צורך בשירות
  rationale_he    TEXT,                          -- למה הטריגר הזה מנבא צורך
  origin          TEXT NOT NULL DEFAULT 'seed'
                  CHECK (origin IN ('seed','manual','import')),
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (subsidiary_id, trigger_type_id, service_id)
);

-- ── אותות שזוהו בפועל אצל לקוח (תוצר המחקר) ────────────────────────────
CREATE TABLE IF NOT EXISTS signals (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id       INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  trigger_type_id INTEGER REFERENCES trigger_types(id) ON DELETE SET NULL,
  title_he        TEXT NOT NULL,
  summary_he      TEXT,
  evidence_quote  TEXT,             -- ציטוט מדויק מהמקור — זו ה"ראיה"
  evidence_url    TEXT,
  evidence_source TEXT,             -- Globes | Calcalist | TASE | PC | company site ...
  evidence_date   TEXT,             -- YYYY-MM-DD
  strength        REAL NOT NULL DEFAULT 0.5,   -- 0..1
  sentiment       TEXT DEFAULT 'neutral'
                  CHECK (sentiment IN ('positive','neutral','negative')),
  status          TEXT NOT NULL DEFAULT 'new'
                  CHECK (status IN ('new','confirmed','dismissed')),
  fingerprint     TEXT,             -- למניעת כפילויות בין הרצות
  run_id          INTEGER REFERENCES research_runs(id) ON DELETE SET NULL,
  origin          TEXT NOT NULL DEFAULT 'research'
                  CHECK (origin IN ('research','manual','import','seed')),
  detected_at     TEXT NOT NULL DEFAULT (datetime('now')),
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_signals_fingerprint
  ON signals(client_id, fingerprint) WHERE fingerprint IS NOT NULL;

-- ── הזדמנויות: הצלבה לקוח × טריגר × חברת בת/שירות ──────────────────────
CREATE TABLE IF NOT EXISTS opportunities (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id       INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  subsidiary_id   INTEGER NOT NULL REFERENCES subsidiaries(id) ON DELETE CASCADE,
  service_id      INTEGER REFERENCES services(id) ON DELETE SET NULL,
  signal_id       INTEGER REFERENCES signals(id) ON DELETE SET NULL,
  kind            TEXT NOT NULL DEFAULT 'cross_sell'
                  CHECK (kind IN ('cross_sell','upsell','new_logo')),
  score           REAL NOT NULL DEFAULT 0,       -- 0..100
  score_breakdown TEXT,                          -- JSON: איך הורכב הציון
  rationale_he    TEXT,                          -- "כי ..." — משפט התובנה
  evidence        TEXT,                          -- JSON array של {quote,url,source,date}
  warm_intro_via  TEXT,                          -- JSON array של slugs של חברות בת שכבר בפנים
  status          TEXT NOT NULL DEFAULT 'new'
                  CHECK (status IN ('new','reviewed','in_progress','won','lost','dismissed')),
  owner           TEXT,
  fingerprint     TEXT,
  origin          TEXT NOT NULL DEFAULT 'engine'
                  CHECK (origin IN ('engine','manual','import')),
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_opps_fingerprint
  ON opportunities(fingerprint) WHERE fingerprint IS NOT NULL;

-- ── הרצות (סריקה / מחקר / התאמה / דוח) ─────────────────────────────────
CREATE TABLE IF NOT EXISTS research_runs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  kind          TEXT NOT NULL
                CHECK (kind IN ('scrape_group','scrape_clients','research','match','report','pipeline')),
  trigger_mode  TEXT NOT NULL DEFAULT 'manual'
                CHECK (trigger_mode IN ('manual','scheduled')),
  scope         TEXT,               -- JSON: {clientIds:[...]} וכו'
  status        TEXT NOT NULL DEFAULT 'running'
                CHECK (status IN ('running','ok','partial','failed')),
  items_in      INTEGER DEFAULT 0,
  items_out     INTEGER DEFAULT 0,
  model         TEXT,
  tokens_in     INTEGER DEFAULT 0,
  tokens_out    INTEGER DEFAULT 0,
  log           TEXT,
  error         TEXT,
  started_at    TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at   TEXT
);

-- ── דוחות מנכ"ל ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS reports (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  kind          TEXT NOT NULL DEFAULT 'ceo_summary',
  title         TEXT NOT NULL,
  period_label  TEXT,
  content_md    TEXT NOT NULL,
  meta          TEXT,               -- JSON: מדדים, מספר הזדמנויות, מקורות
  run_id        INTEGER REFERENCES research_runs(id) ON DELETE SET NULL,
  generated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ── יומן שינויים (כל עריכה ידנית נרשמת) ────────────────────────────────
CREATE TABLE IF NOT EXISTS audit_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  entity      TEXT NOT NULL,
  entity_id   INTEGER,
  action      TEXT NOT NULL,       -- create | update | delete | bulk_import
  actor       TEXT DEFAULT 'ui',
  before_json TEXT,
  after_json  TEXT,
  at          TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ── הגדרות ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);

-- ── אינדקסים ───────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_services_sub       ON services(subsidiary_id);
CREATE INDEX IF NOT EXISTS idx_cs_client          ON client_subsidiary(client_id);
CREATE INDEX IF NOT EXISTS idx_cs_sub             ON client_subsidiary(subsidiary_id);
CREATE INDEX IF NOT EXISTS idx_signals_client     ON signals(client_id);
CREATE INDEX IF NOT EXISTS idx_signals_trigger    ON signals(trigger_type_id);
CREATE INDEX IF NOT EXISTS idx_opps_client        ON opportunities(client_id);
CREATE INDEX IF NOT EXISTS idx_opps_sub           ON opportunities(subsidiary_id);
CREATE INDEX IF NOT EXISTS idx_opps_score         ON opportunities(score DESC);
CREATE INDEX IF NOT EXISTS idx_subtrig_sub        ON subsidiary_triggers(subsidiary_id);

-- ── תצוגות עזר ─────────────────────────────────────────────────────────

-- לקוחות משותפים ליותר מחברת בת אחת
CREATE VIEW IF NOT EXISTS v_shared_clients AS
SELECT c.id            AS client_id,
       c.name_he       AS client_name,
       COUNT(DISTINCT cs.subsidiary_id) AS subsidiary_count,
       GROUP_CONCAT(s.name_he, ' | ')   AS subsidiaries
FROM clients c
JOIN client_subsidiary cs ON cs.client_id = c.id
JOIN subsidiaries s       ON s.id = cs.subsidiary_id
WHERE cs.relationship IN ('customer','case_study')
GROUP BY c.id
HAVING COUNT(DISTINCT cs.subsidiary_id) > 1;

-- "שטח לבן": לקוח קיים × חברת בת שעדיין לא נכנסה אליו
CREATE VIEW IF NOT EXISTS v_whitespace AS
SELECT c.id  AS client_id, c.name_he AS client_name,
       s.id  AS subsidiary_id, s.name_he AS subsidiary_name
FROM clients c
CROSS JOIN subsidiaries s
WHERE s.status = 'active'
  AND EXISTS (SELECT 1 FROM client_subsidiary x
              WHERE x.client_id = c.id AND x.relationship IN ('customer','case_study'))
  AND NOT EXISTS (SELECT 1 FROM client_subsidiary y
                  WHERE y.client_id = c.id AND y.subsidiary_id = s.id);
