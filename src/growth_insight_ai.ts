// ========== みんなの気づき：AIに掲載候補を選んでもらう（管理者のみ） ==========
// ・アプリの中でAIは動かさない。①同意した人の振り返り（名前・学校・メールは伏せ、回答IDだけ）と指示文をコピー
//   → 外部AI（ChatGPT等）に貼る → ②返ってきた文（[PICK:回答ID] 理由）を貼り付けて取り込む。
// ・取り込んだ候補は insight_candidates に保存（migration 0015）。元の回答・採用済みの紹介文は書き換えない。
// ・回答IDは「M＋会員の回答の行番号」「G＋ゲストの回答の行番号」。名前やメールは含まない。
// ・設定（insight_settings.allow_non_candidate）：0＝採用ボタンは掲載候補にだけ（初期）／1＝候補以外からも採用できる。

type Deps = {
  authMiddleware: any
  adminMiddleware: any
  aiMask: (text: string, tokens: string[]) => { text: string; hits: Record<string, number> }
  aiLoadNameTokens: (db: any) => Promise<string[]>
  aiSchoolTypeLabel: (t: string) => string
}

// AIに選んでもらう最大件数（ここを変えると指示文・取り込みの上限の両方が変わる）
export const INSIGHT_AI_MAX_PICKS = 5
const REASON_MAX = 200
const ANSWER_MAX = 600

// ---- 設定 ----
export async function getAllowNonCandidate(db: any): Promise<boolean> {
  try {
    const r = await db.prepare("SELECT value FROM insight_settings WHERE key = 'allow_non_candidate'").first() as any
    return !!r && String(r.value) === '1'
  } catch (e) { return false } // migration前は初期値（候補だけ）
}

// ---- 返事の読み取り（全角・バックスラッシュ・記号のゆれを吸収） ----
export type ParsedPick = { id: string; reason: string; raw: string }
export type ParseResult = { picks: ParsedPick[]; bad: string[] }

function normalizeLine(s: string): string {
  let t = String(s || '')
  try { t = t.normalize('NFKC') } catch (e) { /* ignore */ }
  return t
    .replace(/\\/g, '')                                  // \[PICK:...\] のようなエスケープ
    .replace(/[［【〔〈《「『｛{]/g, '[')
    .replace(/[］】〕〉》」』｝}]/g, ']')
    .replace(/[＜<]/g, '[').replace(/[＞>]/g, ']')
    .replace(/[：﹕︰]/g, ':')
    .replace(/[‐‑‒–—―－−]/g, '-')
    .replace(/\*\*|__|`/g, '')                            // 太字・コード記号
}

export function parsePickText(input: string): ParseResult {
  const lines = String(input || '').replace(/\r\n?/g, '\n').split('\n')
  const picks: ParsedPick[] = []
  const bad: string[] = []
  let cur: ParsedPick | null = null
  for (const rawLine of lines) {
    const line = normalizeLine(rawLine)
    const segs = line.split(/pick/i)
    if (segs.length > 1) {
      // 1行に複数の目印があっても拾う（segs[0] は目印より前）
      cur = null
      for (let i = 1; i < segs.length; i++) {
        const seg = segs[i].replace(/^\s*[:=]?\s*/, '')
        const m = seg.match(/^\[?\s*([MG])[\s\-_.#]*(\d{1,9})\s*\]?/i)
        if (!m) { bad.push(rawLine.trim().slice(0, 120)); continue }
        const id = m[1].toUpperCase() + String(parseInt(m[2], 10))
        const reason = seg.slice(m[0].length).replace(/^[\s\]:\-|、。,.)）]+/, '').replace(/\[\s*$/, '').trim()
        cur = { id, reason, raw: rawLine.trim().slice(0, 120) }
        picks.push(cur)
      }
      continue
    }
    // 目印の次の行に理由が続いている場合（空行・見出しで区切る）
    const t = line.trim()
    if (!t) { cur = null; continue }
    if (cur && cur.reason.length < REASON_MAX && !/^#/.test(t)) {
      const add = t.replace(/^(理由|りゆう)\s*[:]\s*/, '').replace(/^[-・*]\s*/, '')
      cur.reason = (cur.reason ? cur.reason + ' ' : '') + add
    }
  }
  for (const p of picks) p.reason = p.reason.slice(0, REASON_MAX)
  return { picks, bad }
}

// ---- 同意した人の振り返り（文章の回答）を集める ----
type AnsRow = { code: string; rtype: string; rid: number; qid: number; qtext: string; text: string; st: string }
async function loadConsentedAnswers(db: any, eventId: number): Promise<{ rows: AnsRow[]; choices: Map<string, string[]> }> {
  const { results: m } = await db.prepare(
    "SELECT ca.id, ca.user_id AS rid, ca.question_id AS qid, ca.answer_text, q.question_text, q.question_type, q.sort_order, u.school_type " +
    "FROM custom_answers ca JOIN share_consents sc ON sc.event_id = ca.event_id AND sc.respondent_type = 'member' AND sc.respondent_id = ca.user_id " +
    "JOIN survey_questions q ON q.id = ca.question_id AND q.event_id = ca.event_id LEFT JOIN users u ON u.id = ca.user_id " +
    "WHERE ca.event_id = ? AND sc.consent IN ('anon','named') AND trim(ca.answer_text) <> '' ORDER BY sc.updated_at, ca.user_id, q.sort_order"
  ).bind(eventId).all() as any
  const { results: g } = await db.prepare(
    "SELECT ga.id, ga.guest_id AS rid, ga.question_id AS qid, ga.answer_text, q.question_text, q.question_type, q.sort_order " +
    "FROM guest_answers ga JOIN share_consents sc ON sc.event_id = ga.event_id AND sc.respondent_type = 'guest' AND sc.respondent_id = ga.guest_id " +
    "JOIN survey_questions q ON q.id = ga.question_id AND q.event_id = ga.event_id " +
    "WHERE ga.event_id = ? AND sc.consent IN ('anon','named') AND trim(ga.answer_text) <> '' ORDER BY sc.updated_at, ga.guest_id, q.sort_order"
  ).bind(eventId).all() as any
  const rows: AnsRow[] = []
  const choices = new Map<string, string[]>()
  const take = (r: any, rtype: string, st: string) => {
    const pk = rtype + ':' + r.rid
    if (r.question_type === 'text') {
      rows.push({ code: (rtype === 'member' ? 'M' : 'G') + r.id, rtype, rid: Number(r.rid), qid: Number(r.qid), qtext: String(r.question_text || ''), text: String(r.answer_text || ''), st })
    } else if (r.question_type === 'radio') {
      if (!choices.has(pk)) choices.set(pk, [])
      choices.get(pk)!.push(String(r.answer_text || ''))
    }
  }
  for (const r of (m || [])) take(r, 'member', r.school_type || '')
  for (const r of (g || [])) take(r, 'guest', '')
  return { rows, choices }
}

function buildPrompt(evTitle: string, rows: AnsRow[], choices: Map<string, string[]>, masked: (s: string) => string, stLabel: (t: string) => string): string {
  const N = INSIGHT_AI_MAX_PICKS
  const L: string[] = []
  L.push('あなたは、教員向け研修会の運営を手伝うアシスタントです。')
  L.push('以下は、研修会のあとに参加者が書いた振り返りです（本人が「紹介してもよい」と同意したものだけ）。')
  L.push('次の回の受付画面などで、ほかの参加者に紹介する「みんなの気づき」の掲載候補を選んでください。')
  L.push('')
  L.push('【選び方】')
  L.push('・研修の参加者が読んで参考になる・刺激になるものを、最大' + N + '件選んでください（' + N + '件に満たなくてもかまいません）。')
  L.push('・いろいろな視点・校種の人の声が入るようにしてください（同じような内容・同じ人ばかりにならないように。「参加者○」が同じものは同じ人です）。')
  L.push('・次のものは選ばないでください：個人が特定される内容／誰かを悪く言う・傷つける内容／他の人の実名が入っているもの。')
  L.push('・［会員名］［先生］［個人名］などの印は、元の文に人の名前があった所です。こうした印がある振り返りは選ばないでください。［学校名］の印があるものを選ぶときは、理由の最後に「（学校名を消して紹介）」と書いてください。')
  L.push('・理由には「優れている」「一番」「上位」などの評価や順位づけの言葉を使わず、読む人にとってどんなヒントになるかを短く（60字くらいまで）書いてください。')
  L.push('')
  L.push('【返事の形式】次の形だけで、1件につき1行で書いてください。前置きやまとめは不要です。')
  L.push('[PICK:回答ID] 理由')
  L.push('例）[PICK:M123] 子どもの問いを単元全体につなげる工夫が具体的で、明日の授業づくりのヒントになる')
  L.push('')
  L.push('【研修会】' + evTitle)
  L.push('【振り返り】（全' + rows.length + '件）')
  // 同じ人の回答が分かるように、名前の代わりに「参加者1・2…」の番号をつける（この文の中だけの番号）
  const personNo = new Map<string, number>()
  for (const r of rows) { const pk = r.rtype + ':' + r.rid; if (!personNo.has(pk)) personNo.set(pk, personNo.size + 1) }
  for (const r of rows) {
    const pk = r.rtype + ':' + r.rid
    const who = '参加者' + personNo.get(pk) + '・' + (r.rtype === 'guest' ? 'ゲスト参加' : ('校種：' + stLabel(r.st)))
    L.push('')
    L.push('[回答ID:' + r.code + '] ' + who)
    const ch = (choices.get(pk) || []).map((s) => masked(s).slice(0, 60)).filter(Boolean)
    if (ch.length) L.push('（この人が選んだ項目：' + ch.join('／') + '）')
    L.push('問い：' + masked(r.qtext).slice(0, 120))
    let t = masked(r.text).replace(/\s*\n+\s*/g, ' ').trim()
    if (t.length > ANSWER_MAX) t = t.slice(0, ANSWER_MAX) + '…（以下略）'
    L.push('振り返り：' + t)
  }
  L.push('')
  L.push('（ここまで）上の【返事の形式】で、最大' + N + '件を返してください。')
  return L.join('\n')
}

export function registerInsightAi(app: any, deps: Deps) {
  const { authMiddleware, adminMiddleware } = deps

  // 設定の読み取り・変更（全体で1つ）
  app.get('/api/admin/insights/settings', authMiddleware, adminMiddleware, async (c: any) => {
    return c.json({ allow_non_candidate: await getAllowNonCandidate(c.env.DB), max_picks: INSIGHT_AI_MAX_PICKS })
  })
  app.put('/api/admin/insights/settings', authMiddleware, adminMiddleware, async (c: any) => {
    let body: any = {}
    try { body = await c.req.json() } catch (e) { return c.json({ error: '入力が不正です' }, 400) }
    const v = (body.allow_non_candidate === true || body.allow_non_candidate === 1 || body.allow_non_candidate === '1') ? '1' : '0'
    try {
      await c.env.DB.prepare(
        "INSERT INTO insight_settings (key, value, updated_by, updated_at) VALUES ('allow_non_candidate', ?, ?, datetime('now')) " +
        "ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_by=excluded.updated_by, updated_at=datetime('now')"
      ).bind(v, c.get('user').id).run()
    } catch (e) { return c.json({ error: '保存できませんでした（準備中）' }, 500) }
    return c.json({ success: true, allow_non_candidate: v === '1' })
  })

  // ① AIに渡す文（名前・学校・メールは伏せ、回答IDだけ）
  app.get('/api/admin/events/:id/insights/ai-prompt', authMiddleware, adminMiddleware, async (c: any) => {
    const id = parseInt(c.req.param('id'))
    if (isNaN(id)) return c.json({ error: '不正なIDです' }, 400)
    const db = c.env.DB
    const ev = await db.prepare('SELECT id, title, insights_enabled FROM events WHERE id = ?').bind(id).first() as any
    if (!ev) return c.json({ error: 'イベントが見つかりません' }, 404)
    if (ev.insights_enabled === 0) return c.json({ error: 'この回は「みんなの気づき」の対象外です' }, 403)
    const { rows, choices } = await loadConsentedAnswers(db, id)
    if (!rows.length) return c.json({ count: 0, text: '' })
    // 伏せる名前：登録会員の名前＋この回のゲストの名前
    const tokens = await deps.aiLoadNameTokens(db)
    try {
      const { results: gs } = await db.prepare('SELECT name FROM guest_attendances WHERE event_id = ?').bind(id).all() as any
      for (const gRow of (gs || [])) {
        const raw = String(gRow.name || '').trim()
        if (!raw) continue
        const compact = raw.replace(/[\s　]+/g, '')
        if (compact.length >= 2) tokens.push(compact)
        for (const part of raw.split(/[\s　]+/)) if (part && part.length >= 2) tokens.push(part)
      }
    } catch (e) { /* ignore */ }
    const uniq = Array.from(new Set(tokens)).sort((a, b) => b.length - a.length)
    const masked = (s: string) => deps.aiMask(s, uniq).text
    const text = buildPrompt(String(ev.title || ''), rows, choices, masked, deps.aiSchoolTypeLabel)
    return c.json({ count: rows.length, text, max_picks: INSIGHT_AI_MAX_PICKS })
  })

  // ② AIの返事を取り込む（この回の候補は入れ替え。採用済みの紹介文には触らない）
  app.post('/api/admin/events/:id/insights/ai-import', authMiddleware, adminMiddleware, async (c: any) => {
    const id = parseInt(c.req.param('id'))
    if (isNaN(id)) return c.json({ error: '不正なIDです' }, 400)
    let body: any = {}
    try { body = await c.req.json() } catch (e) { return c.json({ error: '入力が不正です' }, 400) }
    const input = typeof body.text === 'string' ? body.text.slice(0, 50000) : ''
    if (!input.trim()) return c.json({ error: 'AIの返事を貼り付けてください' }, 400)
    const db = c.env.DB
    const ev = await db.prepare('SELECT id, insights_enabled FROM events WHERE id = ?').bind(id).first() as any
    if (!ev) return c.json({ error: 'イベントが見つかりません' }, 404)
    if (ev.insights_enabled === 0) return c.json({ error: 'この回は「みんなの気づき」の対象外です' }, 403)
    const { rows } = await loadConsentedAnswers(db, id)
    const byCode = new Map<string, AnsRow>()
    for (const r of rows) byCode.set(r.code, r)
    const parsed = parsePickText(input)
    const failed: { mark: string; why: string }[] = parsed.bad.map((b) => ({ mark: b, why: '回答IDが読み取れませんでした' }))
    const ignored: string[] = []
    const ok: { row: AnsRow; reason: string }[] = []
    const seen = new Set<string>()
    for (const p of parsed.picks) {
      const r = byCode.get(p.id)
      if (!r) { failed.push({ mark: p.raw, why: '回答ID ' + p.id + ' はこの回の同意した振り返りにありません' }); continue }
      if (seen.has(p.id)) { failed.push({ mark: p.raw, why: '同じ回答IDが2回出てきました（1回目だけ使います）' }); continue }
      seen.add(p.id)
      if (ok.length >= INSIGHT_AI_MAX_PICKS) { ignored.push(p.raw); continue }
      ok.push({ row: r, reason: p.reason })
    }
    if (!ok.length) {
      return c.json({ error: '取り込める候補がありませんでした（今までの候補はそのままです）', saved: 0, failed, ignored, max_picks: INSIGHT_AI_MAX_PICKS }, 400)
    }
    const uid = c.get('user').id
    const S: any[] = [db.prepare('DELETE FROM insight_candidates WHERE event_id = ?').bind(id)]
    ok.forEach((o, i) => {
      S.push(db.prepare(
        "INSERT INTO insight_candidates (event_id, respondent_type, respondent_id, question_id, reason, sort_order, created_by, created_at) VALUES (?,?,?,?,?,?,?,datetime('now'))"
      ).bind(id, o.row.rtype, o.row.rid, o.row.qid, o.reason, i, uid))
    })
    try { await db.batch(S) } catch (e) { return c.json({ error: '保存できませんでした（準備中の可能性があります）' }, 500) }
    return c.json({ success: true, saved: ok.length, failed, ignored, max_picks: INSIGHT_AI_MAX_PICKS })
  })

  // 候補をすべて外す（採用済みの紹介文はそのまま）
  app.delete('/api/admin/events/:id/insights/candidates', authMiddleware, adminMiddleware, async (c: any) => {
    const id = parseInt(c.req.param('id'))
    if (isNaN(id)) return c.json({ error: '不正なIDです' }, 400)
    try { await c.env.DB.prepare('DELETE FROM insight_candidates WHERE event_id = ?').bind(id).run() } catch (e) { /* ignore */ }
    return c.json({ success: true })
  })
}

// 管理画面の「みんなの気づき」タブ用：この回の候補（キー：種類:ID:質問ID → 理由・順番）
export async function loadCandidateMap(db: any, eventId: number): Promise<Map<string, { reason: string; order: number }>> {
  const map = new Map<string, { reason: string; order: number }>()
  try {
    const { results } = await db.prepare('SELECT respondent_type, respondent_id, question_id, reason, sort_order FROM insight_candidates WHERE event_id = ? ORDER BY sort_order').bind(eventId).all() as any
    for (const r of (results || [])) map.set(r.respondent_type + ':' + r.respondent_id + ':' + r.question_id, { reason: String(r.reason || ''), order: Number(r.sort_order) || 0 })
  } catch (e) { /* migration前は候補なし */ }
  return map
}
