// ========== 新着の振り返り・スマホへの通知（事務局＝管理者向け） ==========
// ・振り返り（アンケート回答／前回の学びカード／今年度の振り返り）が送られたら、裏の処理（waitUntil）で
//   reflection_feed に1行入れる。送信そのものは待たせない・失敗しても送信は成立（例外はすべて握りつぶす）。
// ・受け取る対象は事務局ごとに3択：全員（ゲストもふくむ）／選択した人（会員）／受け取らない。初期値は「全員」。
//   選択した人は、会員一覧・会員詳細のON/OFFと、この画面の名前検索で選ぶ（admin_watch_members）。グループは使わない。
// ・既読は事務局ごと（feed_reads）。「すべて既読」は read_all_before に時刻を入れるだけ（1行の書き込み）。
// ・スマホ通知（Web Push）：本文に名前や中身は入れない（「新しい振り返りが3件あります」）。通知は補助で、
//   届かなくても管理画面の「新着」で必ず分かる。秘密鍵は Cloudflare のシークレット VAPID_PRIVATE_KEY。
// ・タイミング：その都度（短時間に続いたら INSTANT_GAP_MIN 分ごとにまとめる）／1日1回まとめて（夜 DAILY_HOUR 時以降）。
//   まとめ送信は /api/notify/tick（別のCron Workerが10分ごとに呼ぶ。管理画面を開いたときにも裏で呼ぶ）。
import { GV_ADMIN_CSS } from './growth_common'

type Deps = { authMiddleware: any; adminMiddleware: any; commonHead: string }

// ---- 設定（必要ならここの数字だけ変える） ----
const FEED_DAYS = 60            // 新着として扱う期間（日）
const LIST_LIMIT = 100          // 一覧に出す最大件数
const COUNT_LIMIT = 200         // 件数を数える上限（それ以上は「200件以上」）
const WATCH_MAX = 300           // 「選択した人」の上限
const INSTANT_GAP_MIN = 10      // 「その都度」で、前の通知から何分あいていれば次を送るか（その間の分はまとめる）
const DAILY_HOUR = 20           // 「1日1回まとめて」を送る時刻（日本時間、この時刻以降の最初の呼び出しで送る）
const TICK_GAP_SEC = 50         // まとめ送信の呼び出しが重なったときに間引く秒数
const SITE_URL = 'https://shakaika.pages.dev'

export const KIND_LABEL: Record<string, string> = { survey: '研修会後のアンケート', recall: '前回の学びカード', annual: '今年度の振り返り' }
const RECALL_LABEL: Record<string, string> = { tried: 'やってみた', a_little: 'ちょっとだけ', not_yet: 'まだ', changed: '考えが変わった' }
const SCOPES = ['all', 'selected', 'none']
const TIMINGS = ['instant', 'daily']

function utcStr(ms: number): string { return new Date(ms).toISOString().slice(0, 19).replace('T', ' ') }
function jstDate(ms: number): string { return new Date(ms + 9 * 3600 * 1000).toISOString().slice(0, 10) }
function jstHour(ms: number): number { return new Date(ms + 9 * 3600 * 1000).getUTCHours() }
async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('')
}

// ---- 受け取る対象 ----
type Eff = { mode: string; members: number[] }
function modeOf(row: any): string { return row && SCOPES.indexOf(row.scope_mode) >= 0 ? row.scope_mode : 'all' }
function timingOf(row: any): string { return row && TIMINGS.indexOf(row.push_mode) >= 0 ? row.push_mode : 'daily' }
async function loadWatch(db: D1Database, adminId: number): Promise<number[]> {
  const { results } = await db.prepare('SELECT user_id FROM admin_watch_members WHERE admin_id = ? LIMIT ' + WATCH_MAX).bind(adminId).all() as any
  return (results || []).map((r: any) => Number(r.user_id)).filter((n: number) => Number.isFinite(n) && n > 0)
}
async function loadEff(db: D1Database, adminId: number, row: any): Promise<Eff> {
  const mode = modeOf(row)
  return { mode, members: mode === 'selected' ? await loadWatch(db, adminId) : [] }
}
function eligible(eff: Eff, rtype: string, rid: number): boolean {
  if (eff.mode === 'all') return true
  if (eff.mode === 'selected') return rtype === 'member' && eff.members.indexOf(rid) >= 0
  return false
}
// 対象の範囲（SQL）。f = reflection_feed
function scopeSql(eff: Eff): string {
  if (eff.mode === 'all') return '1=1'
  if (eff.mode === 'selected' && eff.members.length) return "(f.respondent_type = 'member' AND f.respondent_id IN (" + eff.members.join(',') + '))'
  return '0=1'
}
// 未読の条件（SQL）
function unreadWhere(adminId: number, eff: Eff, readAllBefore: string | null, now: number): { sql: string; binds: any[] } {
  let since = utcStr(now - FEED_DAYS * 86400 * 1000)
  if (readAllBefore && readAllBefore > since) since = readAllBefore
  return {
    sql: 'f.updated_at > ? AND ' + scopeSql(eff) + " AND NOT (f.respondent_type = 'member' AND f.respondent_id = ?) " +
      'AND NOT EXISTS (SELECT 1 FROM feed_reads r WHERE r.admin_id = ? AND r.item_id = f.id AND r.read_at >= f.updated_at)',
    binds: [since, adminId, adminId]
  }
}
async function loadAdmin(db: D1Database, adminId: number): Promise<{ row: any; eff: Eff }> {
  const row = await db.prepare('SELECT * FROM admin_notify_settings WHERE admin_id = ?').bind(adminId).first() as any
  return { row, eff: await loadEff(db, adminId, row) }
}
async function countUnread(db: D1Database, adminId: number, eff: Eff, row: any, now: number, newerThan?: string | null): Promise<number> {
  if (eff.mode === 'none') return 0
  const w = unreadWhere(adminId, eff, row ? row.read_all_before : null, now)
  let sql = w.sql
  const binds = w.binds.slice()
  if (newerThan) { sql += ' AND f.updated_at > ?'; binds.push(newerThan) }
  const r = await db.prepare('SELECT COUNT(*) AS n FROM (SELECT f.id FROM reflection_feed f WHERE ' + sql + ' LIMIT ' + COUNT_LIMIT + ')').bind(...binds).first() as any
  return r ? Number(r.n) || 0 : 0
}
function countText(n: number): string { return n >= COUNT_LIMIT ? COUNT_LIMIT + '件以上' : n + '件' }

// ================= Web Push（RFC 8291 aes128gcm ＋ VAPID） =================
function b64uToBytes(s: string): Uint8Array {
  s = String(s || '').replace(/-/g, '+').replace(/_/g, '/')
  while (s.length % 4) s += '='
  const bin = atob(s)
  const u = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i)
  return u
}
function bytesToB64u(buf: ArrayBuffer | Uint8Array): string {
  const u = buf instanceof Uint8Array ? buf : new Uint8Array(buf)
  let bin = ''
  for (let i = 0; i < u.length; i++) bin += String.fromCharCode(u[i])
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
function concat(...parts: Uint8Array[]): Uint8Array {
  let n = 0
  for (const p of parts) n += p.length
  const out = new Uint8Array(n)
  let o = 0
  for (const p of parts) { out.set(p, o); o += p.length }
  return out
}
async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, bytes: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, bytes * 8)
  return new Uint8Array(bits)
}

export async function encryptPayload(p256dhB64u: string, authB64u: string, payload: string): Promise<Uint8Array> {
  const uaPublic = b64uToBytes(p256dhB64u)
  const authSecret = b64uToBytes(authB64u)
  if (uaPublic.length !== 65 || authSecret.length < 16) throw new Error('bad subscription keys')
  const asKeys = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']) as CryptoKeyPair
  const asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', asKeys.publicKey) as ArrayBuffer)
  const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, [])
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey } as any, asKeys.privateKey, 256))
  const enc = new TextEncoder()
  const ikm = await hkdf(authSecret, shared, concat(enc.encode('WebPush: info\0'), uaPublic, asPublic), 32)
  const salt = new Uint8Array(16)
  crypto.getRandomValues(salt)
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16)
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12)
  const plain = concat(enc.encode(payload), new Uint8Array([2]))
  const aesKey = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt'])
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aesKey, plain))
  const header = new Uint8Array(16 + 4 + 1 + 65)
  header.set(salt, 0)
  new DataView(header.buffer).setUint32(16, 4096)
  header[20] = 65
  header.set(asPublic, 21)
  return concat(header, cipher)
}

let _vapidKey: { pub: string; key: CryptoKey } | null = null
async function vapidSigningKey(env: any): Promise<{ pub: string; key: CryptoKey } | null> {
  const pub = String(env.VAPID_PUBLIC_KEY || '').trim()
  const d = String(env.VAPID_PRIVATE_KEY || '').trim()
  if (!pub || !d) return null
  if (_vapidKey && _vapidKey.pub === pub) return _vapidKey
  const p = b64uToBytes(pub)
  if (p.length !== 65) return null
  const jwk = { kty: 'EC', crv: 'P-256', x: bytesToB64u(p.slice(1, 33)), y: bytesToB64u(p.slice(33, 65)), d, ext: true }
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign'])
  _vapidKey = { pub, key }
  return _vapidKey
}
export async function vapidAuth(env: any, endpoint: string): Promise<string | null> {
  const k = await vapidSigningKey(env)
  if (!k) return null
  const aud = new URL(endpoint).origin
  const enc = new TextEncoder()
  const h = bytesToB64u(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })))
  const sub = String(env.VAPID_SUBJECT || SITE_URL)
  const c = bytesToB64u(enc.encode(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub })))
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, k.key, enc.encode(h + '.' + c))
  return 'vapid t=' + h + '.' + c + '.' + bytesToB64u(sig) + ', k=' + k.pub
}
export function pushConfigured(env: any): boolean { return !!(env && env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY) }

// 1つの端末へ送る。戻り値：'ok' | 'gone'（期限切れで削除した） | 'fail'
async function sendOne(env: any, sub: any, payload: any): Promise<string> {
  try {
    const auth = await vapidAuth(env, sub.endpoint)
    if (!auth) return 'fail'
    const body = await encryptPayload(sub.p256dh, sub.auth, JSON.stringify(payload))
    const res = await fetch(sub.endpoint, {
      method: 'POST',
      headers: { 'Authorization': auth, 'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream', 'TTL': '86400', 'Urgency': 'normal' },
      body
    })
    if (res.status === 404 || res.status === 410) {
      await env.DB.prepare('DELETE FROM push_subscriptions WHERE id = ?').bind(sub.id).run()
      return 'gone'
    }
    if (res.ok) {
      await env.DB.prepare("UPDATE push_subscriptions SET last_ok_at = datetime('now') WHERE id = ?").bind(sub.id).run()
      return 'ok'
    }
    return 'fail'
  } catch (e) { return 'fail' }
}
// 事務局1人の全端末へ送る（文に名前や中身は入れない）
async function pushToAdmin(env: any, adminId: number, body: string, tag: string): Promise<{ sent: number; gone: number; devices: number }> {
  const { results } = await env.DB.prepare('SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE admin_id = ? LIMIT 10').bind(adminId).all() as any
  const subs = results || []
  let sent = 0, gone = 0
  const payload = { title: '学びの道しるべ（事務局）', body, url: '/admin/news', tag }
  for (const s of subs) {
    const r = await sendOne(env, s, payload)
    if (r === 'ok') sent++
    else if (r === 'gone') gone++
  }
  return { sent, gone, devices: subs.length }
}

// ================= 振り返りが送られたとき（裏の処理） =================
export type FeedInput = { kind: 'survey' | 'recall' | 'annual'; rtype: 'member' | 'guest'; rid: number; eventId?: number | null; fy?: number | null; content: string }

// ルートから呼ぶ：絶対に送信を遅くしない・壊さない
export function notifyReflection(c: any, input: FeedInput) {
  try {
    const p = recordFeed(c.env, input).catch(() => { /* 通知の失敗は無視 */ })
    try { c.executionCtx.waitUntil(p) } catch (e) { /* waitUntil が使えない環境でも送信は成立 */ }
  } catch (e) { /* ignore */ }
}

async function recordFeed(env: any, it: FeedInput) {
  const db: D1Database = env.DB
  if (!it || !it.rid) return
  const scope = it.kind === 'annual' ? 'fy' + (it.fy || 0) : String(it.eventId || 0)
  const hash = await sha256Hex(String(it.content || ''))
  const prev = await db.prepare('SELECT id, content_hash FROM reflection_feed WHERE kind = ? AND respondent_type = ? AND respondent_id = ? AND scope_key = ?')
    .bind(it.kind, it.rtype, it.rid, scope).first() as any
  if (prev && prev.content_hash === hash) return   // 同じ内容の再送は新着にしない
  await db.prepare(
    "INSERT INTO reflection_feed (kind, respondent_type, respondent_id, scope_key, event_id, fiscal_year, content_hash, created_at, updated_at) VALUES (?,?,?,?,?,?,?,datetime('now'),datetime('now')) " +
    "ON CONFLICT(kind, respondent_type, respondent_id, scope_key) DO UPDATE SET content_hash = excluded.content_hash, event_id = excluded.event_id, fiscal_year = excluded.fiscal_year, updated_at = datetime('now')"
  ).bind(it.kind, it.rtype, it.rid, scope, it.eventId || null, it.fy || null, hash).run()
  if (!pushConfigured(env)) return
  await instantPush(env, it.rtype, it.rid)
}

// 「その都度」の事務局へ（前の通知から INSTANT_GAP_MIN 分以内なら送らず、あとでまとめる）
async function instantPush(env: any, rtype: string, rid: number) {
  const db: D1Database = env.DB
  const { results } = await db.prepare(
    "SELECT s.* FROM admin_notify_settings s JOIN users u ON u.id = s.admin_id AND u.role = 'admin' " +
    "WHERE s.push_mode = 'instant' AND s.scope_mode <> 'none' AND EXISTS (SELECT 1 FROM push_subscriptions p WHERE p.admin_id = s.admin_id) LIMIT 50"
  ).all() as any
  const now = Date.now()
  const gapEdge = utcStr(now - INSTANT_GAP_MIN * 60 * 1000)
  for (const row of (results || [])) {
    if (rtype === 'member' && row.admin_id === rid) continue
    if (row.last_push_at && row.last_push_at > gapEdge) continue  // 少し前に送ったばかり → まとめ送信で
    const eff = await loadEff(db, row.admin_id, row)
    if (!eligible(eff, rtype, rid)) continue
    await sendInstant(env, row, eff, now)
  }
}
async function sendInstant(env: any, row: any, eff: Eff, now: number): Promise<boolean> {
  const n = await countUnread(env.DB, row.admin_id, eff, row, now, row.last_push_at || null)
  if (n <= 0) return false
  const total = await countUnread(env.DB, row.admin_id, eff, row, now)
  await env.DB.prepare("UPDATE admin_notify_settings SET last_push_at = datetime('now') WHERE admin_id = ?").bind(row.admin_id).run()
  await pushToAdmin(env, row.admin_id, '新しい振り返りが' + countText(total) + 'あります', 'shakaika-news')
  return true
}

// ================= まとめ送信（Cron Worker が10分ごとに呼ぶ。管理画面を開いたときにも裏で呼ぶ） =================
export async function runTick(env: any): Promise<any> {
  const db: D1Database = env.DB
  if (!pushConfigured(env)) return { skipped: 'not_configured' }
  const now = Date.now()
  const got = await db.prepare(
    'INSERT INTO notify_state (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v WHERE notify_state.v < ? RETURNING v'
  ).bind('last_tick', utcStr(now), utcStr(now - TICK_GAP_SEC * 1000)).first()
  if (!got) return { skipped: 'throttled' }
  const { results } = await db.prepare(
    "SELECT DISTINCT p.admin_id FROM push_subscriptions p JOIN users u ON u.id = p.admin_id AND u.role = 'admin' LIMIT 50"
  ).all() as any
  const today = jstDate(now)
  const isEvening = jstHour(now) >= DAILY_HOUR
  const gapEdge = utcStr(now - INSTANT_GAP_MIN * 60 * 1000)
  let instant = 0, daily = 0
  for (const a of (results || [])) {
    const row = await db.prepare('SELECT * FROM admin_notify_settings WHERE admin_id = ?').bind(a.admin_id).first() as any
    if (modeOf(row) === 'none') continue
    const eff = await loadEff(db, a.admin_id, row)
    if (timingOf(row) === 'instant') {
      if (row.last_push_at && row.last_push_at > gapEdge) continue
      if (await sendInstant(env, row, eff, now)) instant++
    } else {
      if (!isEvening || (row && row.last_daily_on === today)) continue
      const since = (row && row.last_daily_at) ? row.last_daily_at : utcStr(now - 86400 * 1000)
      const fresh = await countUnread(db, a.admin_id, eff, row, now, since)
      await db.prepare(
        "INSERT INTO admin_notify_settings (admin_id, last_daily_on, last_daily_at, updated_at) VALUES (?, ?, datetime('now'), datetime('now')) " +
        "ON CONFLICT(admin_id) DO UPDATE SET last_daily_on = excluded.last_daily_on, last_daily_at = excluded.last_daily_at"
      ).bind(a.admin_id, today).run()
      if (fresh > 0) {
        const total = await countUnread(db, a.admin_id, eff, row, now)
        await pushToAdmin(env, a.admin_id, '新しい振り返りが' + countText(total) + 'あります', 'shakaika-daily')
        daily++
      }
    }
  }
  return { ok: true, admins: (results || []).length, instant, daily }
}

// ================= 画面・API =================
export function registerNotify(app: any, deps: Deps) {
  const { authMiddleware, adminMiddleware, commonHead } = deps

  // Service Worker（通知を受けて表示し、タップで新着一覧を開く）
  app.get('/sw.js', (c: any) => new Response(SW_JS, { headers: { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-cache' } }))
  // アプリとしてインストール（ホーム画面に追加）するための設定。全ページで読み込む（commonHead）。
  // 開くと / → ログイン画面 → ログイン済みなら会員はマイページ、管理者は管理画面へ自動で進む。
  // iPhoneはホーム画面から開いたときだけ通知を受け取れる（通知・新着は管理者だけ）。
  const manifest = (c: any) => new Response(JSON.stringify(APP_MANIFEST), { headers: { 'Content-Type': 'application/manifest+json; charset=utf-8', 'Cache-Control': 'no-cache' } })
  app.get('/manifest.webmanifest', manifest)
  app.get('/admin.webmanifest', manifest)   // 以前の名前（すでに追加した端末のため）

  // まとめ送信（Cron Worker から。だれが呼んでも「送る時期になったものだけ」送る。短時間の重複は間引く）
  const tick = async (c: any) => {
    try { return c.json(await runTick(c.env)) } catch (e) { return c.json({ ok: false }) }
  }
  app.post('/api/notify/tick', tick)
  app.get('/api/notify/tick', tick)

  // 件数（管理画面のバッジ用）。ついでに裏でまとめ送信の時期かを確認
  app.get('/api/notify/summary', authMiddleware, adminMiddleware, async (c: any) => {
    const me = c.get('user')
    try {
      try { c.executionCtx.waitUntil(runTick(c.env).catch(() => {})) } catch (e) { /* ignore */ }
      const a = await loadAdmin(c.env.DB, me.id)
      const n = await countUnread(c.env.DB, me.id, a.eff, a.row, Date.now())
      return c.json({ unread: n, unread_text: countText(n), mode: a.eff.mode, selected_count: a.eff.members.length })
    } catch (e) {
      return c.json({ unread: 0, mode: 'all', error: 'not_ready' })
    }
  })

  // 一覧（未読だけ／最近30日の既読もふくむ）
  app.get('/api/notify/feed', authMiddleware, adminMiddleware, async (c: any) => {
    const me = c.get('user')
    const db: D1Database = c.env.DB
    const a = await loadAdmin(db, me.id)
    if (a.eff.mode === 'none') return c.json({ items: [], mode: 'none', limit: LIST_LIMIT })
    const now = Date.now()
    const showRead = c.req.query('read') === '1'
    const where = showRead
      ? { sql: 'f.updated_at > ? AND ' + scopeSql(a.eff) + " AND NOT (f.respondent_type = 'member' AND f.respondent_id = ?)", binds: [utcStr(now - 30 * 86400 * 1000), me.id] }
      : unreadWhere(me.id, a.eff, a.row ? a.row.read_all_before : null, now)
    const readBefore = (a.row && a.row.read_all_before) || ''
    const { results } = await db.prepare(
      "SELECT f.id, f.kind, f.respondent_type, f.respondent_id, f.event_id, f.fiscal_year, datetime(f.updated_at, '+9 hours') AS at, f.updated_at AS at_utc, " +
      'e.title AS event_title, e.event_date, u.school AS school, ' +
      "CASE WHEN f.respondent_type = 'member' THEN u.name ELSE g.name END AS name, " +
      '(SELECT r.read_at FROM feed_reads r WHERE r.admin_id = ? AND r.item_id = f.id) AS read_at ' +
      'FROM reflection_feed f LEFT JOIN events e ON e.id = f.event_id ' +
      "LEFT JOIN users u ON f.respondent_type = 'member' AND u.id = f.respondent_id " +
      "LEFT JOIN guest_attendances g ON f.respondent_type = 'guest' AND g.id = f.respondent_id " +
      'WHERE ' + where.sql + ' ORDER BY f.updated_at DESC LIMIT ' + LIST_LIMIT
    ).bind(me.id, ...where.binds).all() as any
    const items = (results || []).map((r: any) => ({
      id: r.id, kind: r.kind, kind_label: KIND_LABEL[r.kind] || r.kind, guest: r.respondent_type === 'guest',
      member_id: r.respondent_type === 'member' ? r.respondent_id : null,
      name: r.name || (r.respondent_type === 'guest' ? '（ゲスト・統合済み）' : '（不明）'), school: r.school || '',
      event_title: r.event_title || '', event_date: r.event_date || '', fiscal_year: r.fiscal_year, at: r.at,
      read: !!((r.read_at && r.read_at >= r.at_utc) || (readBefore && r.at_utc <= readBefore))
    }))
    return c.json({ items, mode: a.eff.mode, limit: LIST_LIMIT })
  })

  // 1件を開く（中身を見せて既読にする）
  app.get('/api/notify/item/:id', authMiddleware, adminMiddleware, async (c: any) => {
    const me = c.get('user')
    const db: D1Database = c.env.DB
    const id = parseInt(c.req.param('id'), 10) || 0
    const f = await db.prepare('SELECT * FROM reflection_feed WHERE id = ?').bind(id).first() as any
    if (!f) return c.json({ error: '見つかりません' }, 404)
    let detail: any = {}
    if (f.kind === 'survey') {
      const sql = f.respondent_type === 'member'
        ? 'SELECT q.question_text, q.sort_order, a.answer_text FROM custom_answers a JOIN survey_questions q ON q.id = a.question_id WHERE a.event_id = ? AND a.user_id = ? ORDER BY q.sort_order, q.id'
        : 'SELECT q.question_text, q.sort_order, a.answer_text FROM guest_answers a JOIN survey_questions q ON q.id = a.question_id WHERE a.event_id = ? AND a.guest_id = ? ORDER BY q.sort_order, q.id'
      const { results } = await db.prepare(sql).bind(f.event_id, f.respondent_id).all() as any
      detail.answers = (results || []).filter((r: any) => String(r.answer_text || '').trim()).map((r: any) => ({ q: r.question_text, a: String(r.answer_text || '').slice(0, 2000) }))
    } else if (f.kind === 'recall') {
      const r = await db.prepare('SELECT rr.status, rr.note, rr.source_answer_text, e.title AS src_title FROM recall_reflections rr LEFT JOIN events e ON e.id = rr.source_event_id WHERE rr.user_id = ? AND rr.event_id = ?').bind(f.respondent_id, f.event_id).first() as any
      if (r) detail = { status: RECALL_LABEL[r.status] || '', note: r.note || '', source: String(r.source_answer_text || '').slice(0, 2000), src_title: r.src_title || '' }
    } else if (f.kind === 'annual') {
      const r = await db.prepare('SELECT goal, reflection FROM annual_notes WHERE user_id = ? AND fiscal_year = ?').bind(f.respondent_id, f.fiscal_year).first() as any
      if (r) detail = { goal: String(r.goal || '').slice(0, 8000), reflection: String(r.reflection || '').slice(0, 8000) }
    }
    await db.prepare("INSERT INTO feed_reads (admin_id, item_id, read_at) VALUES (?, ?, datetime('now')) ON CONFLICT(admin_id, item_id) DO UPDATE SET read_at = datetime('now')").bind(me.id, id).run()
    return c.json({ kind: f.kind, detail })
  })

  // 既読にする（すべて）
  app.post('/api/notify/read', authMiddleware, adminMiddleware, async (c: any) => {
    const me = c.get('user')
    let body: any = {}
    try { body = await c.req.json() } catch (e) { /* ignore */ }
    if (body && body.all) {
      await c.env.DB.prepare(
        "INSERT INTO admin_notify_settings (admin_id, read_all_before, updated_at) VALUES (?, datetime('now'), datetime('now')) " +
        "ON CONFLICT(admin_id) DO UPDATE SET read_all_before = datetime('now'), updated_at = datetime('now')"
      ).bind(me.id).run()
    }
    return c.json({ success: true })
  })

  // 設定（受け取る対象・タイミング・選択した人・端末の数）
  app.get('/api/notify/settings', authMiddleware, adminMiddleware, async (c: any) => {
    const me = c.get('user')
    const db: D1Database = c.env.DB
    const row = await db.prepare('SELECT * FROM admin_notify_settings WHERE admin_id = ?').bind(me.id).first() as any
    const { results } = await db.prepare(
      'SELECT u.id, u.name, u.school FROM admin_watch_members w JOIN users u ON u.id = w.user_id WHERE w.admin_id = ? ORDER BY u.name LIMIT ' + WATCH_MAX
    ).bind(me.id).all() as any
    const subs = await db.prepare('SELECT COUNT(*) AS n FROM push_subscriptions WHERE admin_id = ?').bind(me.id).first() as any
    return c.json({
      mode: modeOf(row), timing: timingOf(row), selected: results || [],
      devices: subs ? Number(subs.n) : 0, push_ready: pushConfigured(c.env), daily_hour: DAILY_HOUR, instant_gap_min: INSTANT_GAP_MIN
    })
  })
  app.post('/api/notify/settings', authMiddleware, adminMiddleware, async (c: any) => {
    const me = c.get('user')
    let body: any = {}
    try { body = await c.req.json() } catch (e) { return c.json({ error: '入力が不正です' }, 400) }
    const mode = SCOPES.indexOf(body.mode) >= 0 ? body.mode : 'all'
    const timing = TIMINGS.indexOf(body.timing) >= 0 ? body.timing : 'daily'
    await c.env.DB.prepare(
      "INSERT INTO admin_notify_settings (admin_id, scope_mode, push_mode, updated_at) VALUES (?, ?, ?, datetime('now')) " +
      "ON CONFLICT(admin_id) DO UPDATE SET scope_mode = excluded.scope_mode, push_mode = excluded.push_mode, updated_at = datetime('now')"
    ).bind(me.id, mode, timing).run()
    return c.json({ success: true })
  })

  // 選択した人：一覧（会員一覧の表示用）・ON/OFF
  app.get('/api/notify/watch', authMiddleware, adminMiddleware, async (c: any) => {
    const me = c.get('user')
    const row = await c.env.DB.prepare('SELECT scope_mode FROM admin_notify_settings WHERE admin_id = ?').bind(me.id).first() as any
    return c.json({ mode: modeOf(row), ids: await loadWatch(c.env.DB, me.id) })
  })
  app.post('/api/notify/watch', authMiddleware, adminMiddleware, async (c: any) => {
    const me = c.get('user')
    const db: D1Database = c.env.DB
    let body: any = {}
    try { body = await c.req.json() } catch (e) { return c.json({ error: '入力が不正です' }, 400) }
    const uid = parseInt(String(body.user_id || ''), 10) || 0
    const u = await db.prepare('SELECT id FROM users WHERE id = ?').bind(uid).first()
    if (!u) return c.json({ error: '会員が見つかりません' }, 404)
    if (body.on) {
      const n = await db.prepare('SELECT COUNT(*) AS n FROM admin_watch_members WHERE admin_id = ?').bind(me.id).first() as any
      if (n && Number(n.n) >= WATCH_MAX) return c.json({ error: '選べるのは' + WATCH_MAX + '人までです' }, 400)
      await db.prepare("INSERT OR IGNORE INTO admin_watch_members (admin_id, user_id, created_at) VALUES (?, ?, datetime('now'))").bind(me.id, uid).run()
    } else {
      await db.prepare('DELETE FROM admin_watch_members WHERE admin_id = ? AND user_id = ?').bind(me.id, uid).run()
    }
    const row = await db.prepare('SELECT scope_mode FROM admin_notify_settings WHERE admin_id = ?').bind(me.id).first() as any
    return c.json({ success: true, on: !!body.on, mode: modeOf(row) })
  })
  // 名前・学校名で会員をさがす（設定画面で選ぶ用。最大30人）
  app.get('/api/notify/members', authMiddleware, adminMiddleware, async (c: any) => {
    const me = c.get('user')
    const q = String(c.req.query('q') || '').trim().replace(/[\s　]+/g, '').slice(0, 30)
    if (!q) return c.json({ members: [] })
    const like = '%' + q.replace(/[\\%_]/g, (m: string) => '\\' + m) + '%'
    const { results } = await c.env.DB.prepare(
      "SELECT u.id, u.name, u.school, (SELECT 1 FROM admin_watch_members w WHERE w.admin_id = ? AND w.user_id = u.id) AS on_ " +
      "FROM users u WHERE REPLACE(REPLACE(u.name, ' ', ''), '　', '') LIKE ? ESCAPE '\\' OR u.school LIKE ? ESCAPE '\\' ORDER BY u.name LIMIT 30"
    ).bind(me.id, like, like).all() as any
    return c.json({ members: (results || []).map((r: any) => ({ id: r.id, name: r.name, school: r.school || '', on: !!r.on_ })) })
  })

  // スマホ通知：公開鍵・受け取り登録・解除・テスト
  app.get('/api/notify/vapid', authMiddleware, adminMiddleware, (c: any) => c.json({ key: pushConfigured(c.env) ? String(c.env.VAPID_PUBLIC_KEY).trim() : null }))
  app.post('/api/notify/subscribe', authMiddleware, adminMiddleware, async (c: any) => {
    const me = c.get('user')
    let body: any = {}
    try { body = await c.req.json() } catch (e) { return c.json({ error: '入力が不正です' }, 400) }
    const ep = String(body.endpoint || '')
    const p256dh = String((body.keys && body.keys.p256dh) || '')
    const auth = String((body.keys && body.keys.auth) || '')
    if (!/^https:\/\//.test(ep) || ep.length > 1000 || !p256dh || p256dh.length > 200 || !auth || auth.length > 100) return c.json({ error: '登録できませんでした' }, 400)
    const label = String(body.label || '').slice(0, 40)
    const n = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM push_subscriptions WHERE admin_id = ? AND endpoint <> ?').bind(me.id, ep).first() as any
    if (n && Number(n.n) >= 10) return c.json({ error: '登録できる端末は10台までです。使っていない端末を解除してください' }, 400)
    await c.env.DB.prepare(
      "INSERT INTO push_subscriptions (admin_id, endpoint, p256dh, auth, device_label, created_at) VALUES (?,?,?,?,?,datetime('now')) " +
      'ON CONFLICT(endpoint) DO UPDATE SET admin_id = excluded.admin_id, p256dh = excluded.p256dh, auth = excluded.auth, device_label = excluded.device_label'
    ).bind(me.id, ep, p256dh, auth, label).run()
    return c.json({ success: true })
  })
  app.post('/api/notify/unsubscribe', authMiddleware, adminMiddleware, async (c: any) => {
    const me = c.get('user')
    let body: any = {}
    try { body = await c.req.json() } catch (e) { /* ignore */ }
    await c.env.DB.prepare('DELETE FROM push_subscriptions WHERE admin_id = ? AND endpoint = ?').bind(me.id, String((body && body.endpoint) || '')).run()
    return c.json({ success: true })
  })
  app.post('/api/notify/test', authMiddleware, adminMiddleware, async (c: any) => {
    const me = c.get('user')
    if (!pushConfigured(c.env)) return c.json({ error: '通知の準備（鍵の設定）がまだです' }, 503)
    const r = await pushToAdmin(c.env, me.id, 'テスト通知です。タップすると新着の一覧が開きます', 'shakaika-test')
    return c.json({ success: true, ...r })
  })

  app.get('/admin/news', (c: any) => c.html(newsPage(commonHead)))
}

// ================= アプリの設定（manifest） =================
export const APP_MANIFEST = {
  id: '/', name: '社会科同好会 学びの道しるべ', short_name: '学びの道しるべ', description: '社会科同好会の研修会・学びの記録',
  start_url: '/', scope: '/', display: 'standalone', lang: 'ja', background_color: '#fffaf0', theme_color: '#d84315',
  icons: [
    { src: '/static/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
    { src: '/static/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
    { src: '/static/icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }
  ]
}

// ================= Service Worker =================
const SW_JS = `
self.addEventListener('install', function (e) { self.skipWaiting(); });
self.addEventListener('activate', function (e) { e.waitUntil(self.clients.claim()); });
self.addEventListener('push', function (e) {
  var d = {};
  try { d = e.data ? e.data.json() : {}; } catch (err) { d = {}; }
  var title = d.title || '学びの道しるべ（事務局）';
  var opt = {
    body: d.body || '新しい振り返りがあります',
    icon: '/static/icons/icon-192.png',
    badge: '/static/icons/badge-72.png',
    tag: d.tag || 'shakaika-news',
    renotify: true,
    data: { url: d.url || '/admin/news' }
  };
  e.waitUntil(self.registration.showNotification(title, opt));
});
self.addEventListener('notificationclick', function (e) {
  e.notification.close();
  var url = (e.notification.data && e.notification.data.url) || '/admin/news';
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (list) {
    for (var i = 0; i < list.length; i++) {
      var w = list[i];
      try {
        if (new URL(w.url).pathname === '/admin/news' && 'focus' in w) { if (w.navigate) w.navigate(url); return w.focus(); }
      } catch (err) {}
    }
    return self.clients.openWindow(url);
  }));
});
`

// ================= 新着の画面 =================
function newsPage(commonHead: string): string {
  return `<!DOCTYPE html><html lang="ja"><head>${commonHead}
<meta name="robots" content="noindex, nofollow">
<title>新着の振り返り - 学びの道しるべ</title>
<style>${GV_ADMIN_CSS}
.badge{display:inline-block;min-width:22px;padding:2px 9px;border-radius:12px;background:#e65100;color:#fff;font-size:13px;font-weight:700;text-align:center}
.badge.zero{background:#bbb}
.head{display:flex;align-items:center;gap:10px;flex-wrap:wrap;font-size:16px;font-weight:700;color:#1a237e}
.tabs{display:flex;gap:6px;flex-wrap:wrap;margin:10px 0}
.tab{padding:7px 14px;border-radius:18px;border:2px solid #c5cae9;background:#fff;color:#1a237e;font-size:13px;font-weight:700;cursor:pointer;font-family:inherit}
.tab.on{background:#1a237e;color:#fff;border-color:#1a237e}
.it{border:1px solid #e0e0e0;border-radius:12px;padding:10px 12px;margin-bottom:8px;background:#fff;cursor:pointer}
.it.unread{border-left:5px solid #e65100}
.it.read{opacity:.75}
.it .l1{display:flex;gap:6px;align-items:center;flex-wrap:wrap;font-size:14px;font-weight:700;color:#222}
.it .l2{font-size:12px;color:#777;margin-top:3px}
.it .body{margin-top:8px;font-size:13px;line-height:1.7;display:none;cursor:auto}
.it.open .body{display:block}
.qa{background:#fafafa;border-left:3px solid #c5cae9;padding:5px 8px;margin:5px 0;white-space:pre-wrap;word-break:break-word}
.qa .q{font-size:11px;color:#999;display:block}
.opt{display:flex;align-items:center;gap:8px;padding:7px 0;font-size:14px;cursor:pointer}
.opt input{width:18px;height:18px;flex:none}
.opt small{color:#888;font-size:12px}
.howto{background:#fff8e1;border-radius:10px;padding:10px 12px;font-size:13px;line-height:1.8;margin-top:10px}
.howto ol{margin:4px 0 0 18px;padding:0}
.st{font-size:12px;min-height:16px;margin-top:6px}
.sel{border:1px solid #e8eaf6;border-radius:10px;padding:8px 10px;margin:6px 0 4px 26px;background:#fafbff}
.mrow{display:flex;align-items:center;gap:8px;padding:5px 0;border-bottom:1px solid #f0f0f0;font-size:14px}
.mrow:last-child{border-bottom:none}
.mrow .sc{color:#888;font-size:12px}
.mrow button{margin-left:auto}
</style></head><body>
<div class="top-bar">
  <div class="logo"><i class="fas fa-bell"></i> 新着の振り返り</div>
  <div class="nav"><a href="/admin" class="btn-sm btn-back"><i class="fas fa-arrow-left"></i> 管理画面</a></div>
</div>
<div class="container">
  <div class="card">
    <div class="head"><span>新しい振り返り</span> <span class="badge zero" id="cnt">-</span>
      <button class="btn btn-gray" id="readAll" type="button" style="margin-left:auto"><i class="fas fa-check-double"></i> すべて既読</button></div>
    <div class="note" id="scope" style="margin-top:6px"></div>
    <div class="tabs"><button class="tab on" data-t="u" type="button">未読</button><button class="tab" data-t="r" type="button">最近30日（既読もふくむ）</button></div>
    <div id="list"><div class="msg"><i class="fas fa-spinner fa-spin"></i> 読み込み中...</div></div>
    <div class="note">押すと中身が開き、既読になります。対象：研修会後のアンケート（会員・ゲスト）、前回の学びカード、マイページの今年度の振り返り。</div>
  </div>

  <div class="card" id="setCard">
    <h2><i class="fas fa-user-check"></i> 受け取る対象</h2>
    <label class="opt"><input type="radio" name="sm" value="all"> 全員 <small>（全会員とゲストの振り返り）</small></label>
    <label class="opt"><input type="radio" name="sm" value="selected"> 選択した人 <small>（下で選んだ会員だけ）</small></label>
    <div class="sel" id="selBox">
      <div class="note">選んだ人：<span id="selCount">0</span>人（会員一覧の各行の <i class="fas fa-bell"></i> や、会員の詳細からも選べます）</div>
      <div id="selList"></div>
      <div style="margin-top:8px;display:flex;gap:6px;flex-wrap:wrap"><input type="text" id="q" placeholder="名前または学校名でさがす" style="flex:1;min-width:160px"><button class="btn btn-gray" id="qBtn" type="button"><i class="fas fa-search"></i></button></div>
      <div id="qList"></div>
    </div>
    <label class="opt"><input type="radio" name="sm" value="none"> 受け取らない <small>（新着の表示も通知もなし）</small></label>

    <h2 style="margin-top:16px"><i class="fas fa-clock"></i> 通知のタイミング</h2>
    <label class="opt"><input type="radio" name="pm" value="daily"> 1日1回まとめて <small>（夜${DAILY_HOUR}時ごろ）</small></label>
    <label class="opt"><input type="radio" name="pm" value="instant"> その都度 <small>（続けて来たときは${INSTANT_GAP_MIN}分ほどまとめます）</small></label>
    <button class="btn btn-primary" id="saveSet" type="button"><i class="fas fa-save"></i> 設定を保存</button>
    <div class="st" id="setSt"></div>

    <h2 style="margin-top:16px"><i class="fas fa-mobile-alt"></i> この端末で通知を受け取る</h2>
    <div class="note">通知の文には名前や中身は出ません（例：「新しい振り返りが3件あります」）。届かなくても、この画面と管理画面の「新着」で分かります。</div>
    <div style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap">
      <button class="btn btn-orange" id="subBtn" type="button"><i class="fas fa-bell"></i> この端末で通知を受け取る</button>
      <button class="btn btn-gray" id="unsubBtn" type="button" style="display:none"><i class="fas fa-bell-slash"></i> この端末の通知をやめる</button>
      <button class="btn btn-gray" id="testBtn" type="button" style="display:none"><i class="fas fa-paper-plane"></i> テスト通知を送る</button>
    </div>
    <div class="st" id="pushSt"></div>
    <div class="howto" id="iosHow" style="display:none"><b><i class="fab fa-apple"></i> iPhone・iPad</b>（iOS 16.4以降）
      <ol><li>Safariでこの画面を開き、共有ボタン（□に↑）→「ホーム画面に追加」</li>
      <li>ホーム画面の「学びの道しるべ」アイコンから開き、もう一度ログイン</li>
      <li>「この端末で通知を受け取る」→「許可」</li></ol></div>
    <div class="howto" id="andHow" style="display:none"><b><i class="fab fa-android"></i> Android</b>：Chromeでこの画面を開き、「この端末で通知を受け取る」→「許可」。<br>（ホーム画面に追加しておくと、すぐ開けて便利です）</div>
    <div class="note" style="margin-top:8px"><a href="/app-install" style="color:#d84315">📱 ホーム画面に追加のしかた</a></div>
    <div class="howto" style="background:#f5f5f5"><b>通知が来ないとき</b>
      <ol><li>「テスト通知を送る」で届くか確かめる</li>
      <li>スマホの設定で、このサイト（iPhoneは「学びの道しるべ」アプリ）の通知が「許可」になっているか</li>
      <li>おやすみモード・省電力モードになっていないか</li>
      <li>それでも来ないときは「この端末の通知をやめる」→もう一度「受け取る」</li></ol></div>
  </div>
</div>
<script>
const token = localStorage.getItem('token');
const user = JSON.parse(localStorage.getItem('user') || 'null');
if (!token || !user || user.role !== 'admin') { window.location.href = '/login?redirect=/admin/news'; throw new Error('redirect'); }
function esc(s) { return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
async function api(path, opt) {
  opt = opt || {};
  opt.headers = Object.assign({ 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' }, opt.headers || {});
  const r = await fetch(path, opt);
  if (r.status === 401 || r.status === 403) { localStorage.clear(); window.location.href = '/login?redirect=/admin/news'; throw new Error('auth'); }
  let d = null; try { d = await r.json(); } catch (e) {}
  if (!r.ok) throw new Error((d && d.error) || ('エラー (' + r.status + ')'));
  return d;
}
const MODE_TEXT = { all: '受け取る対象：全員', selected: '受け取る対象：選択した人', none: '受け取る対象：受け取らない（新着は表示されません）' };
let tab = 'u';
function fmtDate(s) { if (!s) return ''; var m = String(s).match(/^(\\d{4})-(\\d{2})-(\\d{2})/); return m ? (+m[2]) + '/' + (+m[3]) : s; }
async function loadSummary() {
  try {
    const s = await api('/api/notify/summary');
    const b = document.getElementById('cnt');
    b.textContent = s.unread_text || (s.unread + '件');
    b.className = 'badge' + (s.unread ? '' : ' zero');
    document.getElementById('scope').textContent = (MODE_TEXT[s.mode] || '') + (s.mode === 'selected' ? '（' + s.selected_count + '人）' : '');
  } catch (e) {}
}
async function loadList() {
  const el = document.getElementById('list');
  el.innerHTML = '<div class="msg"><i class="fas fa-spinner fa-spin"></i> 読み込み中...</div>';
  try {
    const d = await api('/api/notify/feed' + (tab === 'r' ? '?read=1' : ''));
    if (d.mode === 'none') { el.innerHTML = '<div class="msg">「受け取らない」になっています（下の設定で変えられます）</div>'; return; }
    if (!d.items.length) { el.innerHTML = '<div class="msg">' + (tab === 'u' ? '新しい振り返りはありません' : '最近30日の振り返りはありません') + '</div>'; return; }
    el.innerHTML = d.items.map(function (it) {
      var when = it.kind === 'annual' ? (it.fiscal_year ? it.fiscal_year + '年度' : '') : (esc(it.event_title) + (it.event_date ? '（' + fmtDate(it.event_date) + '）' : ''));
      return '<div class="it ' + (it.read ? 'read' : 'unread') + '" data-id="' + it.id + '">'
        + '<div class="l1">' + esc(it.name) + (it.guest ? ' <span class="pill gray">ゲスト</span>' : (it.school ? ' <span class="note">' + esc(it.school) + '</span>' : '')) + ' <span class="pill warn">' + esc(it.kind_label) + '</span>' + (it.read ? ' <span class="pill gray">既読</span>' : '') + '</div>'
        + '<div class="l2">' + when + ' ・ ' + esc(String(it.at || '').slice(5, 16).replace('-', '/')) + '</div>'
        + '<div class="body"></div></div>';
    }).join('') + (d.items.length >= d.limit ? '<div class="note">新しい順に' + d.limit + '件まで表示しています。</div>' : '');
    el.querySelectorAll('.it').forEach(function (n) { n.addEventListener('click', function (ev) { if (ev.target.closest('.body')) return; openItem(n, d.items.find(function (x) { return String(x.id) === n.dataset.id; })); }); });
  } catch (e) { el.innerHTML = '<div class="msg err">' + esc(e.message) + '</div>'; }
}
async function openItem(n, it) {
  if (n.classList.contains('open')) { n.classList.remove('open'); return; }
  n.classList.add('open');
  const body = n.querySelector('.body');
  body.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';
  try {
    const d = await api('/api/notify/item/' + it.id);
    var h = '', x = d.detail || {};
    if (d.kind === 'survey') h = (x.answers && x.answers.length) ? x.answers.map(function (a) { return '<div class="qa"><span class="q">' + esc(a.q) + '</span>' + esc(a.a) + '</div>'; }).join('') : '<div class="note">記入された回答はありません</div>';
    else if (d.kind === 'recall') h = '<div class="qa"><span class="q">前回（' + esc(x.src_title || '') + '）に書いた「試してみたいこと」</span>' + esc(x.source || '') + '</div>'
      + '<div class="qa"><span class="q">やってみたか</span>' + esc(x.status || '（ボタンなし）') + '</div>' + (x.note ? '<div class="qa"><span class="q">一言</span>' + esc(x.note) + '</div>' : '');
    else if (d.kind === 'annual') h = '<div class="qa"><span class="q">今年度の振り返り</span>' + esc(x.reflection || '') + '</div>' + (x.goal ? '<div class="qa"><span class="q">今年度の目標</span>' + esc(x.goal) + '</div>' : '');
    if (it.member_id) h += '<div style="margin-top:6px"><a class="btn-sm" style="background:#e8f5e9;color:#2e7d32" href="/admin/portfolio?uid=' + it.member_id + '"><i class="fas fa-seedling"></i> 学びの記録を見る</a></div>';
    body.innerHTML = h;
    if (!it.read) { it.read = true; n.classList.remove('unread'); n.classList.add('read'); loadSummary(); }
  } catch (e) { body.innerHTML = '<span class="err">' + esc(e.message) + '</span>'; }
}
document.querySelectorAll('.tab').forEach(function (b) { b.addEventListener('click', function () {
  tab = b.dataset.t; document.querySelectorAll('.tab').forEach(function (x) { x.classList.toggle('on', x === b); }); loadList();
}); });
document.getElementById('readAll').addEventListener('click', async function () {
  if (!confirm('いま出ている新着をすべて既読にしますか？')) return;
  try { await api('/api/notify/read', { method: 'POST', body: JSON.stringify({ all: true }) }); loadSummary(); loadList(); } catch (e) { alert(e.message); }
});

// ---- 設定 ----
let S = null;
async function loadSettings() {
  try {
    S = await api('/api/notify/settings');
    document.querySelectorAll('input[name=sm]').forEach(function (r) { r.checked = r.value === S.mode; });
    document.querySelectorAll('input[name=pm]').forEach(function (r) { r.checked = r.value === S.timing; });
    renderSel(); syncMode(); refreshPush();
  } catch (e) { document.getElementById('setSt').innerHTML = '<span class="err">' + esc(e.message) + '</span>'; }
}
function renderSel() {
  document.getElementById('selCount').textContent = S.selected.length;
  document.getElementById('selList').innerHTML = S.selected.map(function (m) {
    return '<div class="mrow"><b>' + esc(m.name) + '</b> <span class="sc">' + esc(m.school || '') + '</span><button class="btn-sm" style="background:#ffebee;color:#c62828" data-off="' + m.id + '" type="button">外す</button></div>';
  }).join('') || '<div class="note">まだ選ばれていません</div>';
  document.querySelectorAll('[data-off]').forEach(function (b) { b.addEventListener('click', function () { setWatch(+b.dataset.off, false); }); });
}
function syncMode() { var m = (document.querySelector('input[name=sm]:checked') || {}).value; document.getElementById('selBox').style.display = m === 'selected' ? '' : 'none'; }
document.querySelectorAll('input[name=sm]').forEach(function (r) { r.addEventListener('change', syncMode); });
async function setWatch(id, on) {
  try {
    await api('/api/notify/watch', { method: 'POST', body: JSON.stringify({ user_id: id, on: on }) });
    S = Object.assign(S, { selected: (await api('/api/notify/settings')).selected });
    renderSel(); if (document.getElementById('q').value.trim()) search(); loadSummary(); loadList();
  } catch (e) { alert(e.message); }
}
async function search() {
  const q = document.getElementById('q').value.trim();
  const el = document.getElementById('qList');
  if (!q) { el.innerHTML = ''; return; }
  try {
    const d = await api('/api/notify/members?q=' + encodeURIComponent(q));
    el.innerHTML = d.members.length ? d.members.map(function (m) {
      return '<div class="mrow"><b>' + esc(m.name) + '</b> <span class="sc">' + esc(m.school || '（学校名なし）') + '</span>'
        + (m.on ? '<button class="btn-sm" style="background:#ffebee;color:#c62828" data-w="' + m.id + '" data-on="0" type="button">外す</button>' : '<button class="btn-sm" style="background:#e8eaf6;color:#1a237e" data-w="' + m.id + '" data-on="1" type="button"><i class="fas fa-plus"></i> 選ぶ</button>') + '</div>';
    }).join('') : '<div class="note">見つかりませんでした</div>';
    el.querySelectorAll('[data-w]').forEach(function (b) { b.addEventListener('click', function () { setWatch(+b.dataset.w, b.dataset.on === '1'); }); });
  } catch (e) { el.innerHTML = '<span class="err">' + esc(e.message) + '</span>'; }
}
document.getElementById('qBtn').addEventListener('click', search);
document.getElementById('q').addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); search(); } });
document.getElementById('saveSet').addEventListener('click', async function () {
  const st = document.getElementById('setSt');
  const sm = (document.querySelector('input[name=sm]:checked') || {}).value || 'all';
  const pm = (document.querySelector('input[name=pm]:checked') || {}).value || 'daily';
  try {
    await api('/api/notify/settings', { method: 'POST', body: JSON.stringify({ mode: sm, timing: pm }) });
    S.mode = sm; S.timing = pm;
    st.innerHTML = '<span style="color:#2e7d32"><i class="fas fa-check"></i> 保存しました</span>' + (sm === 'selected' && !S.selected.length ? '（まだだれも選ばれていません）' : '');
    loadSummary(); loadList();
  } catch (e) { st.innerHTML = '<span class="err">' + esc(e.message) + '</span>'; }
});

// ---- スマホ通知 ----
const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const standalone = (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || window.navigator.standalone === true;
const canPush = ('serviceWorker' in navigator) && ('PushManager' in window) && ('Notification' in window);
if (!(isIOS && standalone)) document.getElementById(isIOS ? 'iosHow' : 'andHow').style.display = 'block';
function b64uToU8(s) { s = s.replace(/-/g, '+').replace(/_/g, '/'); while (s.length % 4) s += '='; var b = atob(s), u = new Uint8Array(b.length); for (var i = 0; i < b.length; i++) u[i] = b.charCodeAt(i); return u; }
async function currentSub() {
  if (!canPush) return null;
  const reg = await navigator.serviceWorker.getRegistration('/');
  return reg ? await reg.pushManager.getSubscription() : null;
}
function pushMsg(html, err) { document.getElementById('pushSt').innerHTML = err ? '<span class="err">' + html + '</span>' : html; }
function deviceLabel() { var u = navigator.userAgent; return /iPhone/.test(u) ? 'iPhone' : /iPad/.test(u) ? 'iPad' : /Android/.test(u) ? 'Android' : /Windows/.test(u) ? 'Windows' : /Mac/.test(u) ? 'Mac' : 'その他'; }
async function refreshPush() {
  const sub = document.getElementById('subBtn'), un = document.getElementById('unsubBtn'), te = document.getElementById('testBtn');
  if (!canPush) {
    sub.disabled = true;
    pushMsg(isIOS && !standalone ? 'iPhoneでは、ホーム画面に追加した「学びの道しるべ」アイコンから開いたときだけ通知を受け取れます（下の手順）。' : 'このブラウザは通知に対応していません。', !isIOS);
    return;
  }
  if (S && !S.push_ready) { sub.disabled = true; pushMsg('通知の準備（鍵の設定）がまだです。新着はこの画面で確認できます。'); return; }
  try {
    const s = await currentSub();
    if (s) { try { await api('/api/notify/subscribe', { method: 'POST', body: JSON.stringify(Object.assign(s.toJSON(), { label: deviceLabel() })) }); } catch (e) {} }
    sub.style.display = s ? 'none' : ''; un.style.display = s ? '' : 'none'; te.style.display = (S && S.devices) || s ? '' : 'none';
    if (Notification.permission === 'denied') pushMsg('この端末では通知がブロックされています。スマホ（ブラウザ）の設定で、このサイトの通知を「許可」にしてください。', true);
    else pushMsg(s ? '<span style="color:#2e7d32"><i class="fas fa-check"></i> この端末は通知を受け取ります</span>' + (S && S.mode === 'none' ? '（ただし上で「受け取らない」になっています）' : '') : (S && S.devices ? 'ほかの端末で ' + S.devices + '台 登録されています。' : ''));
  } catch (e) { pushMsg(esc(e.message), true); }
}
document.getElementById('subBtn').addEventListener('click', async function () {
  const btn = this; btn.disabled = true;
  try {
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') { pushMsg('通知が「許可」されませんでした。もう一度押すか、スマホの設定で許可してください。', true); btn.disabled = false; return; }
    const v = await api('/api/notify/vapid');
    if (!v.key) throw new Error('通知の準備（鍵の設定）がまだです');
    const reg = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
    await navigator.serviceWorker.ready;
    let s = await reg.pushManager.getSubscription();
    if (!s) s = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64uToU8(v.key) });
    await api('/api/notify/subscribe', { method: 'POST', body: JSON.stringify(Object.assign(s.toJSON(), { label: deviceLabel() })) });
    if (S) S.devices = (S.devices || 0) + 1;
    pushMsg('<span style="color:#2e7d32"><i class="fas fa-check"></i> 登録しました。「テスト通知を送る」で確かめられます。</span>');
  } catch (e) { pushMsg('登録できませんでした：' + esc(e.message), true); }
  btn.disabled = false;
  refreshPush();
});
document.getElementById('unsubBtn').addEventListener('click', async function () {
  try {
    const s = await currentSub();
    if (s) { await api('/api/notify/unsubscribe', { method: 'POST', body: JSON.stringify({ endpoint: s.endpoint }) }); await s.unsubscribe(); }
    if (S && S.devices) S.devices--;
    pushMsg('この端末の通知をやめました。');
  } catch (e) { pushMsg(esc(e.message), true); }
  refreshPush();
});
document.getElementById('testBtn').addEventListener('click', async function () {
  try {
    const r = await api('/api/notify/test', { method: 'POST', body: '{}' });
    pushMsg(r.sent ? '<span style="color:#2e7d32">テスト通知を送りました（' + r.sent + '台）。数秒〜1分ほどで届きます。</span>' : '送れませんでした（登録された端末：' + r.devices + '台' + (r.gone ? '、期限切れで削除：' + r.gone + '台' : '') + '）。もう一度「この端末で通知を受け取る」を押してください。', !r.sent);
  } catch (e) { pushMsg(esc(e.message), true); }
});

loadSummary(); loadList(); loadSettings();
</script></body></html>`
}
