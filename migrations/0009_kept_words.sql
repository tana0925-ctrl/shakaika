-- 印象に残った言葉（2026-10 追加）
-- 会員本人が、自分のアンケートの記述から選んで残す言葉（短くしてもよい）。年度末の成長レポートにのる。
-- 元の回答（custom_answers）は書き換えない。見られるのは本人と管理者だけ。
CREATE TABLE IF NOT EXISTS kept_words (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  event_id INTEGER NOT NULL,
  question_id INTEGER NOT NULL,
  body TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE(user_id, event_id, question_id)
);
CREATE INDEX IF NOT EXISTS idx_kept_words_user ON kept_words(user_id);
