-- 重複のまとめ（2026-10 追加）
-- 自動統合はしない。管理者が見比べて「同じ人」と確定したときだけ統合し、その記録を残す（元に戻せる）。
-- merge_logs.detail に、元に戻すための記録（付け替えた行のID、ゲストの元の行など）をJSONで保存する。
CREATE TABLE IF NOT EXISTS merge_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK(kind IN ('guest_to_member','member_to_member')),
  source_id INTEGER NOT NULL,            -- 統合される側（guest_attendances.id または users.id）
  target_id INTEGER NOT NULL,            -- 残る側（users.id）
  summary TEXT DEFAULT '',
  detail TEXT NOT NULL DEFAULT '{}',
  merged_by INTEGER,
  merged_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  undone_by INTEGER,
  undone_at DATETIME DEFAULT NULL
);
CREATE INDEX IF NOT EXISTS idx_merge_logs_source ON merge_logs(kind, source_id);

-- 「別人」と確認した組（候補一覧から外す）。a_id/b_id は member_member なら小さいID・大きいID、guest_member なら guest_id・user_id
CREATE TABLE IF NOT EXISTS duplicate_dismissals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK(kind IN ('guest_member','member_member')),
  a_id INTEGER NOT NULL,
  b_id INTEGER NOT NULL,
  created_by INTEGER,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(kind, a_id, b_id)
);
