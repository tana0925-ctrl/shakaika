-- 2026-10-24 「みんなの気づき」の対象にする回かどうか（イベントごと・管理者が作成／編集で設定）
-- 1=対象（振り返りの最後に紹介の同意欄が付き、採用したものが表示される） / 0=対象外
-- 既定値1：既存の回はすべて対象のまま（今までの動きを変えない）。既存の行は書き換えない。
-- 0にしても share_consents・shared_insights の行は消さない（表示しないだけ。1に戻せば再表示）。
ALTER TABLE events ADD COLUMN insights_enabled INTEGER NOT NULL DEFAULT 1;
