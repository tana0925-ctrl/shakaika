-- 新着の振り返り・スマホへの通知（2026-10 追加・事務局＝管理者向け）
-- 既存の表は変更しない。振り返りが送られたとき（裏の処理で）reflection_feed に1行入る／更新される。

-- 1) 新着の振り返り（1人 × 1つの振り返り につき1行。直されたら updated_at が新しくなり、また「新着」になる）
--    kind: survey=研修会後のアンケート / recall=前回の学びカード / annual=マイページの今年度の振り返り
CREATE TABLE IF NOT EXISTS reflection_feed (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK(kind IN ('survey','recall','annual')),
  respondent_type TEXT NOT NULL CHECK(respondent_type IN ('member','guest')),
  respondent_id INTEGER NOT NULL,
  scope_key TEXT NOT NULL,                 -- survey/recall: 研修会ID、annual: 'fy年度'
  event_id INTEGER,
  fiscal_year INTEGER,
  content_hash TEXT NOT NULL DEFAULT '',   -- 同じ内容の再送では新着にしない
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(kind, respondent_type, respondent_id, scope_key)
);
CREATE INDEX IF NOT EXISTS idx_reflection_feed_updated ON reflection_feed(updated_at);
CREATE INDEX IF NOT EXISTS idx_reflection_feed_member ON reflection_feed(respondent_type, respondent_id, updated_at);

-- 2) 既読（事務局ごと）。read_at >= 新着の updated_at なら既読
CREATE TABLE IF NOT EXISTS feed_reads (
  admin_id INTEGER NOT NULL,
  item_id INTEGER NOT NULL,
  read_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (admin_id, item_id)
);

-- 3) 事務局ごとの設定（行が無い人は初期値：全員・1日1回まとめて）
--    scope_mode: all=全員（ゲストもふくむ） / selected=選択した人だけ（会員） / none=受け取らない（新着も通知もなし）
--    push_mode: instant=その都度 / daily=1日1回まとめて（夜）
CREATE TABLE IF NOT EXISTS admin_notify_settings (
  admin_id INTEGER PRIMARY KEY,
  scope_mode TEXT NOT NULL DEFAULT 'all' CHECK(scope_mode IN ('all','selected','none')),
  push_mode TEXT NOT NULL DEFAULT 'daily' CHECK(push_mode IN ('instant','daily')),
  read_all_before TEXT DEFAULT NULL,       -- 「すべて既読」を押した時刻
  last_push_at TEXT DEFAULT NULL,          -- 最後に「その都度」の通知を送った時刻
  last_daily_on TEXT DEFAULT NULL,         -- 最後に夜のまとめを確認した日（日本時間 YYYY-MM-DD）
  last_daily_at TEXT DEFAULT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 4) 「選択した人」：事務局ごとに、振り返りを受け取る会員（会員一覧・会員詳細のON/OFF、設定画面の検索で選ぶ）
CREATE TABLE IF NOT EXISTS admin_watch_members (
  admin_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (admin_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_admin_watch_members_user ON admin_watch_members(user_id);

-- 5) スマホ通知の受け取り先（事務局ごと・端末ごと）。期限切れ（404/410）は自動で消す
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  admin_id INTEGER NOT NULL,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  device_label TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_ok_at TEXT DEFAULT NULL
);
CREATE INDEX IF NOT EXISTS idx_push_subscriptions_admin ON push_subscriptions(admin_id);

-- 6) 小さな状態（まとめ送信の呼び出しが短時間に重ならないように）
CREATE TABLE IF NOT EXISTS notify_state (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL DEFAULT ''
);
