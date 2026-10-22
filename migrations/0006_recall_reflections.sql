-- 2026-10-22 前回の学びを思い出すカード（出席直後に表示）
-- 会員が「前回の『明日以降、試してみたいこと』」を見て、任意で押した／書いた内容を保存する。
-- 1人の会員 × 1つの研修会（今回）につき1行。前回の回答（研修会・質問・その時の文）にも紐づける。
CREATE TABLE IF NOT EXISTS recall_reflections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  event_id INTEGER NOT NULL,             -- 今回の研修会
  source_event_id INTEGER NOT NULL,      -- 前回の研修会
  source_question_id INTEGER NOT NULL,   -- 前回の質問（survey_questions.id）
  source_answer_text TEXT DEFAULT '',    -- 表示した前回の回答（その時点の文）
  status TEXT DEFAULT NULL CHECK(status IS NULL OR status IN ('tried','a_little','not_yet','changed')),
  note TEXT DEFAULT '',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE,
  UNIQUE(user_id, event_id)
);
CREATE INDEX IF NOT EXISTS idx_recall_reflections_event ON recall_reflections(event_id);
CREATE INDEX IF NOT EXISTS idx_recall_reflections_source ON recall_reflections(source_event_id);
-- 前回の回答をすばやく探すため（会員ごとの回答を引く）
CREATE INDEX IF NOT EXISTS idx_custom_answers_user ON custom_answers(user_id);
