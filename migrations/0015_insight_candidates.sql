-- 2026-10-26 みんなの気づき：AIに掲載候補を選んでもらう（管理者のみ）
-- 既存のテーブル・行は変えない（新しいテーブルを2つ足すだけ）。
-- 1) 掲載候補：外部AIの返事（[PICK:回答ID] 理由）を取り込んだもの。1つの回の候補は取り込むたびに入れ替える。
--    採用済みの紹介文（shared_insights）・元の回答には触らない。
CREATE TABLE IF NOT EXISTS insight_candidates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER NOT NULL,
  respondent_type TEXT NOT NULL CHECK(respondent_type IN ('member','guest')),
  respondent_id INTEGER NOT NULL,
  question_id INTEGER NOT NULL,
  reason TEXT NOT NULL DEFAULT '',          -- AIが書いた理由
  sort_order INTEGER NOT NULL DEFAULT 0,    -- AIの返事の順（並びのためだけ。順位ではない）
  created_by INTEGER,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(event_id, respondent_type, respondent_id, question_id)
);
CREATE INDEX IF NOT EXISTS idx_insight_candidates_event ON insight_candidates(event_id);

-- 2) 「みんなの気づき」の設定（全体で1つずつ）。行が無い＝初期値。
--    allow_non_candidate：'0'=採用ボタンは掲載候補にだけ（初期） / '1'=候補以外からも採用できる
CREATE TABLE IF NOT EXISTS insight_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_by INTEGER,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
