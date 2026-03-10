-- Sessions table for persistent auth tokens
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  expires_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

-- Annual notes (goal/reflection) per fiscal year
CREATE TABLE IF NOT EXISTS annual_notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  fiscal_year INTEGER NOT NULL,
  goal TEXT DEFAULT '',
  reflection TEXT DEFAULT '',
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE(user_id, fiscal_year)
);
CREATE INDEX IF NOT EXISTS idx_annual_notes_user_year ON annual_notes(user_id, fiscal_year);
