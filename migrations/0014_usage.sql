-- 利用状況（人数だけ）。誰が開いたかは残さない（src/growth_usage.ts）
CREATE TABLE IF NOT EXISTS usage_daily (
  day TEXT NOT NULL,          -- 日本時間 YYYY-MM-DD
  page TEXT NOT NULL,         -- mypage / portfolio / report / insights / attend / app / _any
  views INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, page)
);
CREATE TABLE IF NOT EXISTS usage_salt (
  week TEXT PRIMARY KEY,      -- その週の月曜日。今週の分だけ残る
  salt TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS usage_week_seen (
  week TEXT NOT NULL,
  page TEXT NOT NULL,
  h TEXT NOT NULL,            -- 週の合言葉と会員IDから作った記号（週が変わると消す）
  PRIMARY KEY (week, page, h)
);
CREATE TABLE IF NOT EXISTS usage_week_people (
  week TEXT NOT NULL,
  page TEXT NOT NULL,
  people INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (week, page)
);
