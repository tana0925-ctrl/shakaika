# 社会科同好会 成長の道しるべ（学びのコンパス）

## Project Overview
- **Name**: 社会科同好会 成長の道しるべ
- **Goal**: 会員が自分の現在地と次のステップを選択・記録でき、管理者が全会員の状況を一覧で把握できるWebアプリ
- **Features**: 
  - 会員登録・ログイン認証
  - 5つの成長視点 x 4段階ステップの対話型ルーブリック
  - 各セルをクリックして「今の自分」を選択・メモ付きで保存
  - 管理者ダッシュボード（全会員の選択状況を一覧表示）
  - CSV(Excel対応)エクスポート機能
  - A4横印刷対応

## URLs
- **ログインページ**: `/login`
- **マイページ（会員用）**: `/mypage`
- **管理者ダッシュボード**: `/admin`
- **DB初期化**: `/api/init`（初回アクセス時に1度実行）

## API Endpoints
| Method | Path | 説明 |
|--------|------|------|
| GET | `/api/init` | DB初期化＆管理者アカウント作成 |
| POST | `/api/auth/register` | 会員登録 |
| POST | `/api/auth/login` | ログイン |
| GET | `/api/auth/me` | 現在のユーザー情報取得 |
| GET | `/api/selections` | 自分の選択状況取得 |
| POST | `/api/selections` | 選択を保存/更新 |
| DELETE | `/api/selections/:viewpoint` | 選択を削除 |
| GET | `/api/admin/members` | 全会員一覧（管理者のみ） |
| PUT | `/api/admin/members/:id/role` | 役割変更（管理者のみ） |
| DELETE | `/api/admin/members/:id` | 会員削除（管理者のみ） |
| GET | `/api/admin/export` | CSV エクスポート（管理者のみ） |

## Default Admin Account
- **Email**: admin@example.com
- **Password**: admin123

## Data Architecture
- **Database**: Cloudflare D1 (SQLite)
- **Tables**: 
  - `users` - 会員情報（名前、メール、パスワードハッシュ、役割）
  - `selections` - 各会員の選択記録（視点、ステップ、メモ）
- **Authentication**: SHA-256ハッシュ + Bearer Token

## User Guide
1. `/api/init` にアクセスしてデータベースを初期化
2. `/login` で新規登録またはログイン
3. マイページでルーブリック表のセルをクリックして「今の自分」を選択
4. メモを追加して「保存する」ボタンを押す
5. 管理者は `/admin` で全会員の選択状況を確認、CSVダウンロード可能

## Deployment
- **Platform**: Cloudflare Pages
- **Status**: 開発中（ローカル動作確認済み）
- **Tech Stack**: Hono + TypeScript + D1 + Vite + Wrangler
- **Last Updated**: 2026-02-16

## 前回の学びカード（2026-10-22 追加）
会員が受付QRで出席すると、前回の「明日以降、試してみたいこと」をカードで表示。任意で「やってみた／ちょっとだけ／まだ／考えが変わった」と一言を残せる（recall_reflections テーブル、migration 0006）。本人と管理者のみ閲覧可。

## みんなの気づき（2026-10-23 追加）
- 回答フォーム（会員・ゲスト共通）の最後に、任意の同意欄「名前なしで紹介してもよい／名前ありで紹介してもよい」が自動で付く（質問ではないのでCSV・質問数には入らない）。同意は share_consents（anon / named / none）。この機能より前の回答には行が無く、紹介の対象外。
- 管理者：イベント管理 → 各回の「みんなの気づき」タブで、同意した人の文章回答だけを一覧。文面を直して「採用」／取り消し。採用文は shared_insights に別保存（元の回答は書き換えない）。
- 表示：会員が受付QRで出席した画面（前回の学びカードの下）に「前回のみんなの気づき」、マイページ → /mypage/insights に研修会ごとの一覧。どちらもログインした会員のみ。名前あり同意は名前だけ（学校名なし）、名前なし同意は名前を出さない。表示のたびに今の同意を確認する。
- ゲストの受付画面には出さない（ログイン不要の画面のため、外部の人に見えてしまうおそれがある）。
- migration 0007（D1に適用済み）。
