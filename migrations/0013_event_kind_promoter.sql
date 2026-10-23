-- 2026-10-24 会の「種類」と、会員の「推進部員」のしるし（1枚シートの参加率を種類ごとに出すため）
-- 既存の行の他の列は書き換えない。追加した列の初期値を入れるだけ。

-- 1) イベントの種類：training=研修（全員向け・スキルアップ研修会・授業力アップなど）
--                    research=研究（小学校部会・中学校部会・小中合同など）
--                    other=その他（全体会・フィールドワークなど、会名から判断できないもの）
--    管理者がイベント作成・編集（✏️）で変えられる。
ALTER TABLE events ADD COLUMN event_kind TEXT NOT NULL DEFAULT 'other' CHECK(event_kind IN ('training','research','other'));

-- 既存の回は会名から初期値を入れる（「部会」「小中合同」「研究」→研究、「スキルアップ」「授業力アップ」「研修」→研修、ほか→その他）
UPDATE events SET event_kind = CASE
  WHEN instr(title, '部会') > 0 OR instr(title, '小中合同') > 0 OR instr(title, '研究') > 0 THEN 'research'
  WHEN instr(title, 'スキルアップ') > 0 OR instr(title, '授業力アップ') > 0 OR instr(title, '研修') > 0 THEN 'training'
  ELSE 'other' END;

-- 2) 推進部員のしるし（1=推進部員）。初期値は全員0（OFF）。管理者が会員一覧・会員詳細でON/OFF。
ALTER TABLE users ADD COLUMN promoter INTEGER NOT NULL DEFAULT 0;
