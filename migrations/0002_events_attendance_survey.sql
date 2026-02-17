-- Events table
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  description TEXT DEFAULT '',
  event_date TEXT NOT NULL,
  event_code TEXT UNIQUE NOT NULL,
  is_active INTEGER DEFAULT 1,
  created_by INTEGER NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (created_by) REFERENCES users(id)
);

-- Attendances table
CREATE TABLE IF NOT EXISTS attendances (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  attended_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE(event_id, user_id)
);

-- Custom survey questions per event
CREATE TABLE IF NOT EXISTS survey_questions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER NOT NULL,
  question_text TEXT NOT NULL,
  question_type TEXT NOT NULL CHECK(question_type IN ('text', 'radio', 'rating')),
  options TEXT DEFAULT '',
  sort_order INTEGER DEFAULT 0,
  FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE
);

-- Survey answers
CREATE TABLE IF NOT EXISTS survey_answers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  satisfaction INTEGER CHECK(satisfaction BETWEEN 1 AND 5),
  comment TEXT DEFAULT '',
  answered_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE(event_id, user_id)
);

-- Custom question answers
CREATE TABLE IF NOT EXISTS custom_answers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  question_id INTEGER NOT NULL,
  answer_text TEXT DEFAULT '',
  FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (question_id) REFERENCES survey_questions(id) ON DELETE CASCADE,
  UNIQUE(event_id, user_id, question_id)
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_attendances_event ON attendances(event_id);
CREATE INDEX IF NOT EXISTS idx_attendances_user ON attendances(user_id);
CREATE INDEX IF NOT EXISTS idx_survey_answers_event ON survey_answers(event_id);
CREATE INDEX IF NOT EXISTS idx_events_code ON events(event_code);
CREATE INDEX IF NOT EXISTS idx_custom_answers_event ON custom_answers(event_id);
