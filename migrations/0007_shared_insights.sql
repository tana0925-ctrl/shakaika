-- 2026-10-23 みんなの気づき（振り返りの紹介）
-- 1) 紹介の同意：回答フォームの最後の任意欄。1人（会員/ゲスト）× 1つの研修会につき1行。
--    anon=名前なしで紹介してよい / named=名前ありで紹介してよい / none=どちらも選ばなかった（紹介しない）
--    この機能より前の回答には行が無い＝同意なし（紹介の対象外）。
CREATE TABLE IF NOT EXISTS share_consents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER NOT NULL,
  respondent_type TEXT NOT NULL CHECK(respondent_type IN ('member','guest')),
  respondent_id INTEGER NOT NULL,          -- member: users.id / guest: guest_attendances.id
  consent TEXT NOT NULL CHECK(consent IN ('anon','named','none')),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(event_id, respondent_type, respondent_id)
);
CREATE INDEX IF NOT EXISTS idx_share_consents_event ON share_consents(event_id, consent);

-- 2) 運営が採用した紹介文（元の回答は書き換えず、編集後の文面をここに別に保存）
--    表示のたびに share_consents を確認し、同意が無くなっていれば出さない。名前の有無も同意に従う。
CREATE TABLE IF NOT EXISTS shared_insights (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER NOT NULL,
  respondent_type TEXT NOT NULL CHECK(respondent_type IN ('member','guest')),
  respondent_id INTEGER NOT NULL,
  question_id INTEGER NOT NULL,
  body TEXT NOT NULL,                      -- 紹介する文面（運営が編集したもの）
  adopted_by INTEGER,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(event_id, respondent_type, respondent_id, question_id)
);
CREATE INDEX IF NOT EXISTS idx_shared_insights_event ON shared_insights(event_id);
