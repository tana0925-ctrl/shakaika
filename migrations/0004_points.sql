-- Points table for motivation/gamification system
CREATE TABLE IF NOT EXISTS points (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  event_id INTEGER,
  points INTEGER NOT NULL DEFAULT 1,
  reason TEXT NOT NULL DEFAULT 'event_survey',
  fiscal_year INTEGER NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE SET NULL,
  UNIQUE(user_id, event_id)
);
CREATE INDEX IF NOT EXISTS idx_points_user_fy ON points(user_id, fiscal_year);
