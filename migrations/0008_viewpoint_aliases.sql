-- 成長の視点の「読みかえ表」（2026-10 追加）
-- 回答に出てくる選択肢名（表記ゆれ）を、集計用の共通の視点名にまとめる対応表。
-- 元の回答（custom_answers / guest_answers）は書き換えない。管理者が画面で見直し・修正できる。
-- canonical = '' は「集計に入れない」。
CREATE TABLE IF NOT EXISTS viewpoint_aliases (
  alias TEXT PRIMARY KEY,
  canonical TEXT NOT NULL DEFAULT '',
  updated_by INTEGER,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

INSERT OR IGNORE INTO viewpoint_aliases (alias, canonical) VALUES
  ('授業をつくる', '授業をつくる'),
  ('授業を作る', '授業をつくる'),
  ('授業をする', '授業をする'),
  ('授業をする・磨く', '授業をする'),
  ('子どもを見る', '子どもを見る'),
  ('子どもを見る・評価する', '子どもを見る'),
  ('生徒を見る', '子どもを見る'),
  ('つながる', 'つながる'),
  ('仲間とつながる', 'つながる'),
  ('深める', '深める'),
  ('研究・発信する', '深める'),
  ('資料', '資料'),
  ('対話', '対話'),
  ('探究', '探究'),
  ('校内支援', '校内支援'),
  ('学校経営', '学校経営'),
  ('会員支援', '会員支援'),
  ('後進育成', '後進育成'),
  ('運営貢献', '運営貢献'),
  ('対外連携', '対外連携'),
  ('カフート', 'その他');  -- 2026-10 先生の判断で「その他」にまとめる（あとで変更可）
