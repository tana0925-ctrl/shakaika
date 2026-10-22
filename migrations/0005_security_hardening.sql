-- 2026-10-22 安全対策
-- 1) 受付の締め切り：管理者が「受付を再開」したときの期限（日付 YYYY-MM-DD、日本時間）
ALTER TABLE events ADD COLUMN reopen_until TEXT DEFAULT NULL;

-- 2) ゲスト回答の編集用合言葉（端末に保存した値のSHA-256。合言葉そのものは保存しない）
CREATE TABLE IF NOT EXISTS guest_attendances (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  school TEXT DEFAULT '',
  district TEXT DEFAULT '',
  experience_years INTEGER,
  attended_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  token TEXT DEFAULT ''
);
CREATE TABLE IF NOT EXISTS guest_answers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guest_id INTEGER NOT NULL,
  event_id INTEGER NOT NULL,
  question_id INTEGER NOT NULL,
  answer_text TEXT DEFAULT '',
  answered_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(guest_id, question_id)
);
ALTER TABLE guest_attendances ADD COLUMN edit_token_hash TEXT DEFAULT '';
CREATE INDEX IF NOT EXISTS idx_guest_attendances_event ON guest_attendances(event_id, name, school);

-- 4) ログインの試しすぎ防止（メールアドレスごとに1行。主キーで1行だけ読む）
CREATE TABLE IF NOT EXISTS login_attempts (
  key TEXT PRIMARY KEY,
  fail_count INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT DEFAULT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
