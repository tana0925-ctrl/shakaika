// ========== 運営向け 分析ダッシュボード ＋ 視点の読みかえ表（管理者のみ） ==========
// AIは使わずに動く。AIで要約したいときは、名前を伏せた文章をコピーして外部のAIに貼る。
import {
  GV_CANON, GV_DEFAULT_ALIASES, GV_Q_SQL, GV_ADMIN_CSS, QKIND_LABEL,
  fyRange, parseFY, currentFY, splitChoices, questionKind, loadAliases, canonOf, canonOrder, loadAllNameTokens
} from './growth_common'

type Deps = {
  authMiddleware: any
  adminMiddleware: any
  commonHead: string
  aiMask: (text: string, tokens: string[]) => { text: string; hits: Record<string, number> }
}

const RECALL_KEYS = ['tried', 'a_little', 'not_yet', 'changed']
const RECALL_LABEL: Record<string, string> = { tried: 'やってみた', a_little: 'ちょっとだけ', not_yet: 'まだ', changed: '考えが変わった', none: '一言だけ（ボタンなし）' }

// ---- 年度のデータをまとめて集計 ----
async function buildAnalytics(db: D1Database, fy: number) {
  const [start, end] = fyRange(fy)
  const am = await loadAliases(db)
  const { results: evs } = await db.prepare(
    'SELECT id, title, event_date FROM events WHERE event_date >= ? AND event_date <= ? ORDER BY event_date, id'
  ).bind(start, end).all() as any
  const events: any[] = []
  const byId: Record<number, any> = {}
  for (const e of (evs || [])) {
    const o = {
      id: e.id, title: e.title, date: e.event_date,
      att_m: 0, att_g: 0, resp_m: 0, resp_g: 0,
      has_growth: false, growth_n: 0, growth_total: 0,
      growth_people: {} as Record<string, number>, unmapped: {} as Record<string, number>,
      recall: { tried: 0, a_little: 0, not_yet: 0, changed: 0, none: 0 } as Record<string, number>
    }
    events.push(o); byId[e.id] = o
  }
  const texts: any[] = []
  if (!events.length) return { fy, am, events, texts, uniqueMembers: 0 }

  const q1 = (sql: string) => db.prepare(sql).bind(start, end).all() as any
  const [attM, attG, respM, respG, qs, ansM, ansG, rec, uniq] = await Promise.all([
    q1('SELECT a.event_id, COUNT(*) n FROM attendances a JOIN events e ON e.id = a.event_id WHERE e.event_date >= ? AND e.event_date <= ? GROUP BY a.event_id'),
    q1('SELECT g.event_id, COUNT(*) n FROM guest_attendances g JOIN events e ON e.id = g.event_id WHERE e.event_date >= ? AND e.event_date <= ? GROUP BY g.event_id'),
    q1(`SELECT event_id, COUNT(*) n FROM (
          SELECT sa.event_id, sa.user_id FROM survey_answers sa JOIN events e ON e.id = sa.event_id WHERE e.event_date >= ?1 AND e.event_date <= ?2
          UNION SELECT ca.event_id, ca.user_id FROM custom_answers ca JOIN events e ON e.id = ca.event_id WHERE e.event_date >= ?1 AND e.event_date <= ?2
        ) GROUP BY event_id`),
    q1('SELECT ga.event_id, COUNT(DISTINCT ga.guest_id) n FROM guest_answers ga JOIN events e ON e.id = ga.event_id WHERE e.event_date >= ? AND e.event_date <= ? GROUP BY ga.event_id'),
    q1('SELECT q.id, q.event_id, q.question_text, q.question_type FROM survey_questions q JOIN events e ON e.id = q.event_id WHERE e.event_date >= ? AND e.event_date <= ? ORDER BY q.event_id, q.sort_order'),
    q1("SELECT ca.event_id, ca.user_id AS rid, ca.question_id, ca.answer_text FROM custom_answers ca JOIN events e ON e.id = ca.event_id WHERE e.event_date >= ? AND e.event_date <= ? AND trim(COALESCE(ca.answer_text,'')) <> ''"),
    q1("SELECT ga.event_id, ga.guest_id AS rid, ga.question_id, ga.answer_text FROM guest_answers ga JOIN events e ON e.id = ga.event_id WHERE e.event_date >= ? AND e.event_date <= ? AND trim(COALESCE(ga.answer_text,'')) <> ''"),
    q1('SELECT r.event_id, r.status, COUNT(*) n FROM recall_reflections r JOIN events e ON e.id = r.event_id WHERE e.event_date >= ? AND e.event_date <= ? AND (r.status IS NOT NULL OR trim(COALESCE(r.note,\'\')) <> \'\') GROUP BY r.event_id, r.status').catch(() => ({ results: [] })),
    q1('SELECT COUNT(DISTINCT a.user_id) n FROM attendances a JOIN events e ON e.id = a.event_id WHERE e.event_date >= ? AND e.event_date <= ?')
  ])
  for (const r of (attM.results || [])) if (byId[r.event_id]) byId[r.event_id].att_m = r.n
  for (const r of (attG.results || [])) if (byId[r.event_id]) byId[r.event_id].att_g = r.n
  for (const r of (respM.results || [])) if (byId[r.event_id]) byId[r.event_id].resp_m = r.n
  for (const r of (respG.results || [])) if (byId[r.event_id]) byId[r.event_id].resp_g = r.n
  for (const r of (rec.results || [])) {
    const ev = byId[r.event_id]; if (!ev) continue
    const k = r.status && RECALL_KEYS.indexOf(r.status) >= 0 ? r.status : 'none'
    ev.recall[k] += r.n
  }
  const qInfo: Record<number, any> = {}
  for (const q of (qs.results || [])) {
    const kind = questionKind(q)
    qInfo[q.id] = { kind, text: q.question_text, event_id: q.event_id }
    if (kind === 'growth' && byId[q.event_id]) byId[q.event_id].has_growth = true
  }
  // 成長の視点：1人が同じ視点を表記ちがいで2つ選んでも1回と数える
  const seen: Record<string, Set<string>> = {}
  const handle = (rows: any[], rtype: string) => {
    for (const a of rows) {
      const qi = qInfo[a.question_id]; const ev = byId[a.event_id]
      if (!qi || !ev) continue
      if (qi.kind === 'growth') {
        const key = a.event_id + ':' + rtype + ':' + a.rid
        if (!seen[key]) seen[key] = new Set()
        for (const raw of splitChoices(a.answer_text)) {
          const cn = canonOf(raw, am)
          if (cn === null) { ev.unmapped[raw] = (ev.unmapped[raw] || 0) + 1; continue }
          if (cn === '') continue
          seen[key].add(cn)
        }
      } else if (qi.kind !== 'choice') {
        texts.push({ event_id: a.event_id, kind: qi.kind, q: qi.text, text: String(a.answer_text).slice(0, 2000), rtype })
      }
    }
  }
  handle(ansM.results || [], 'm')
  handle(ansG.results || [], 'g')
  for (const key of Object.keys(seen)) {
    const s = seen[key]; if (!s.size) continue
    const ev = byId[parseInt(key, 10)]; if (!ev) continue
    ev.growth_n += 1
    ev.growth_total += s.size
    s.forEach((cn) => { ev.growth_people[cn] = (ev.growth_people[cn] || 0) + 1 })
  }
  return { fy, am, events, texts, uniqueMembers: (uniq.results && uniq.results[0] && uniq.results[0].n) || 0 }
}

function pct(a: number, b: number): string {
  if (!b) return '－'
  return (Math.round((a / b) * 1000) / 10).toFixed(1) + '%'
}

// ---- AIに貼る用の文章（名前を伏せる） ----
const AN_AI_INSTRUCTION = `あなたは、小学校・中学校の先生が参加する社会科の研修会の運営を手伝うアシスタントです。
以下は、研修会のアンケートの集計と、自由記述の回答です（個人名・学校名などは［ ］で伏せてあります）。

次の2つを、見出しを分けて書いてください。

【1】回答の傾向
・数字と記述から読み取れることだけを書いてください。
・どの数字・どの記述から言えるのかが分かるように書いてください。
・人数が少ない回（おおむね10人未満）は、傾向として言い切らないでください。

【2】運営への提案
・【1】をもとにした「提案」として書いてください（例：「〜してみてはどうか」）。
・3〜5個程度、すぐに試せるものから順に。

守ってほしいこと
・回答に書かれていない成果や変化を断定しないでください（「〜できるようになった」「力が伸びた」などと決めつけない）。
・個人を特定しようとしたり、推測したりしないでください。
・参加者や回どうしに順位や優劣をつけないでください。
・割合は、書いてある分母（何人のうちか）を添えて引用してください。`

export function registerAnalytics(app: any, deps: Deps) {
  const { authMiddleware, adminMiddleware, commonHead, aiMask } = deps

  // 年度の集計
  app.get('/api/admin/analytics', authMiddleware, adminMiddleware, async (c: any) => {
    const db = c.env.DB as D1Database
    const fy = parseFY(c.req.query('fy'))
    const d = await buildAnalytics(db, fy)
    const { results: fyRows } = await db.prepare('SELECT DISTINCT substr(event_date,1,7) ym FROM events ORDER BY ym').all() as any
    const fys: number[] = []
    for (const r of (fyRows || [])) { const m = /^(\d{4})-(\d{2})/.exec(r.ym || ''); if (m) { const f = +m[2] >= 4 ? +m[1] : +m[1] - 1; if (fys.indexOf(f) < 0) fys.push(f) } }
    if (fys.indexOf(currentFY()) < 0) fys.push(currentFY())
    fys.sort()
    const groups: Record<string, string> = {}
    for (const cdef of GV_CANON) groups[cdef.name] = cdef.group
    return c.json({
      fy, fys, canon: canonOrder(d.am), groups, alias_table: d.am.fromTable,
      events: d.events, texts: d.texts, unique_members: d.uniqueMembers
    })
  })

  // AIに貼る用の文章
  app.post('/api/admin/analytics/ai-text', authMiddleware, adminMiddleware, async (c: any) => {
    const db = c.env.DB as D1Database
    let body: any = {}
    try { body = await c.req.json() } catch (e) { /* ignore */ }
    const fy = parseFY(body.fy)
    const eventId = parseInt(String(body.event_id || ''), 10) || 0
    const d = await buildAnalytics(db, fy)
    const evs = eventId ? d.events.filter((e: any) => e.id === eventId) : d.events
    if (!evs.length) return c.json({ error: '対象の研修会がありません' }, 404)
    const tokens = await loadAllNameTokens(db)
    const hits: Record<string, number> = {}
    const mask = (s: string) => { const r = aiMask(s, tokens); for (const k of Object.keys(r.hits)) hits[k] = (hits[k] || 0) + r.hits[k]; return r.text }
    const order = canonOrder(d.am)
    const L: string[] = []
    L.push(AN_AI_INSTRUCTION)
    L.push('')
    L.push('===== 集計（' + fy + '年度' + (eventId ? '・1回分' : '・' + evs.length + '回分') + '） =====')
    L.push('※「参加」は受付をした人数（会員＋ゲスト）、「回答」はアンケートを送った人数。')
    L.push('※成長の視点は複数選択。「選んだ人の割合」の分母は、その質問に答えた人数。')
    let label = 1
    const idx: Record<number, string> = {}
    for (const e of evs) {
      const nm = '回' + (label++)
      idx[e.id] = nm
      const att = e.att_m + e.att_g, resp = e.resp_m + e.resp_g
      L.push('')
      L.push('■ ' + nm + '（' + e.date + '）' + mask(String(e.title || '')))
      L.push('参加 ' + att + '人（会員' + e.att_m + '・ゲスト' + e.att_g + '）／回答 ' + resp + '人（回答率 ' + pct(resp, att) + '）')
      if (e.has_growth && e.growth_n) {
        const parts: string[] = []
        for (const cn of order) { const n = e.growth_people[cn] || 0; if (n) parts.push(cn + ' ' + n + '人（' + pct(n, e.growth_n) + '）') }
        L.push('成長の視点（' + e.growth_n + '人が回答、全選択' + e.growth_total + '件）：' + parts.join('、'))
      }
      const rc = e.recall; const rcTotal = RECALL_KEYS.reduce((s, k) => s + (rc[k] || 0), 0)
      if (rcTotal) L.push('前回の学びカード（前回「試してみたい」と書いたことのその後・' + rcTotal + '人）：' + RECALL_KEYS.map((k) => RECALL_LABEL[k] + ' ' + (rc[k] || 0) + '人').join('、'))
    }
    L.push('')
    L.push('===== 自由記述 =====')
    for (const kind of ['reason', 'try', 'impression', 'other']) {
      const items = d.texts.filter((t: any) => t.kind === kind && idx[t.event_id])
      if (!items.length) continue
      L.push('')
      L.push('【' + QKIND_LABEL[kind] + '】（' + items.length + '件）')
      for (const t of items) L.push('・[' + idx[t.event_id] + '] ' + mask(String(t.text).replace(/\s+/g, ' ').slice(0, 300)))
    }
    L.push('')
    L.push('===== ここまで =====')
    const text = L.join('\n')
    const leaked: string[] = []
    for (const t of tokens) { if (t.length >= 2 && text.indexOf(t) !== -1) leaked.push(t) }
    if (/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.test(text)) leaked.push('メールアドレス')
    if (leaked.length) return c.json({ error: '名前が残っている可能性があるため中止しました（' + leaked.length + '件）。運営に相談してください。' }, 500)
    return c.json({ text, chars: text.length, masked: Object.keys(hits).map((k) => ({ label: k, count: hits[k] })) })
  })

  // 読みかえ表：一覧（＋実際に回答に出てくる選択肢）
  app.get('/api/admin/viewpoint-aliases', authMiddleware, adminMiddleware, async (c: any) => {
    const db = c.env.DB as D1Database
    const am = await loadAliases(db)
    let rows: any[] = []
    if (am.fromTable) {
      const r = await db.prepare("SELECT a.alias, a.canonical, datetime(a.updated_at,'+9 hours') updated_at, u.name updated_by_name FROM viewpoint_aliases a LEFT JOIN users u ON u.id = a.updated_by").all() as any
      rows = r.results || []
    }
    const observed: Record<string, { m: number; g: number; opt: boolean }> = {}
    const bump = (raw: string, k: 'm' | 'g') => { if (!observed[raw]) observed[raw] = { m: 0, g: 0, opt: false }; observed[raw][k]++ }
    const { results: am1 } = await db.prepare(`SELECT ca.answer_text FROM custom_answers ca JOIN survey_questions q ON q.id = ca.question_id WHERE ${GV_Q_SQL}`).all() as any
    for (const r of (am1 || [])) for (const t of splitChoices(r.answer_text)) bump(t, 'm')
    const { results: ag1 } = await db.prepare(`SELECT ga.answer_text FROM guest_answers ga JOIN survey_questions q ON q.id = ga.question_id WHERE ${GV_Q_SQL}`).all() as any
    for (const r of (ag1 || [])) for (const t of splitChoices(r.answer_text)) bump(t, 'g')
    const { results: opts } = await db.prepare(`SELECT DISTINCT q.options FROM survey_questions q WHERE ${GV_Q_SQL}`).all() as any
    for (const r of (opts || [])) for (const t of String(r.options || '').split('|')) { const s = t.trim(); if (s) { if (!observed[s]) observed[s] = { m: 0, g: 0, opt: false }; observed[s].opt = true } }
    return c.json({
      alias_table: am.fromTable,
      aliases: rows,
      observed: Object.keys(observed).map((k) => ({ alias: k, count_m: observed[k].m, count_g: observed[k].g, in_options: observed[k].opt })),
      canon: canonOrder(am),
      canon_default: GV_CANON.map((x) => ({ name: x.name, group: x.group })),
      defaults: GV_DEFAULT_ALIASES
    })
  })

  // 読みかえ表：保存（元の回答は変えない）
  app.put('/api/admin/viewpoint-aliases', authMiddleware, adminMiddleware, async (c: any) => {
    const db = c.env.DB as D1Database
    const me = c.get('user')
    let body: any = {}
    try { body = await c.req.json() } catch (e) { return c.json({ error: '入力が不正です' }, 400) }
    const items = Array.isArray(body.items) ? body.items : []
    if (!items.length) return c.json({ error: '変更がありません' }, 400)
    if (items.length > 200) return c.json({ error: '一度に保存できるのは200件までです' }, 400)
    const stmts: any[] = []
    for (const it of items) {
      const alias = typeof it.alias === 'string' ? it.alias.trim() : ''
      if (!alias || alias.length > 60) return c.json({ error: '選択肢名が不正です' }, 400)
      if (it.remove === true) { stmts.push(db.prepare('DELETE FROM viewpoint_aliases WHERE alias = ?').bind(alias)); continue }
      const canonical = typeof it.canonical === 'string' ? it.canonical.trim() : ''
      if (canonical.length > 30) return c.json({ error: '視点名は30文字以内にしてください' }, 400)
      stmts.push(db.prepare("INSERT INTO viewpoint_aliases (alias, canonical, updated_by, updated_at) VALUES (?,?,?,datetime('now')) ON CONFLICT(alias) DO UPDATE SET canonical = excluded.canonical, updated_by = excluded.updated_by, updated_at = datetime('now')").bind(alias, canonical, me.id))
    }
    try { await db.batch(stmts) } catch (e) { return c.json({ error: '保存できませんでした（読みかえ表がまだ準備されていない可能性があります）' }, 500) }
    return c.json({ success: true, saved: stmts.length })
  })

  // ---- 画面：分析ダッシュボード ----
  app.get('/admin/analytics', (c: any) => c.html(analyticsPage(commonHead)))
  app.get('/admin/viewpoints', (c: any) => c.html(viewpointsPage(commonHead)))
}

const ADMIN_GUARD = `
const token = localStorage.getItem('token');
const user = JSON.parse(localStorage.getItem('user') || 'null');
if (!token || !user || user.role !== 'admin') { window.location.href = '/login'; throw new Error('redirect'); }
function esc(s) { return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
async function api(path, opt) {
  opt = opt || {};
  opt.headers = Object.assign({ 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' }, opt.headers || {});
  const r = await fetch(path, opt);
  if (r.status === 401 || r.status === 403) { localStorage.clear(); window.location.href = '/login'; throw new Error('auth'); }
  let d = null; try { d = await r.json(); } catch (e) {}
  if (!r.ok) throw new Error((d && d.error) || ('エラー (' + r.status + ')'));
  return d;
}
`

function analyticsPage(commonHead: string): string {
  return `<!DOCTYPE html><html lang="ja"><head>${commonHead}
<meta name="robots" content="noindex, nofollow">
<title>分析ダッシュボード - 社会科同好会</title>
<style>${GV_ADMIN_CSS}
.ctrl{display:flex;gap:10px;flex-wrap:wrap;align-items:center}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px;margin-bottom:6px}
.tile{background:#f5f6fb;border-radius:12px;padding:10px 12px}
.tile .n{font-size:24px;font-weight:700;color:#1a237e;line-height:1.2}
.tile .l{font-size:11px;color:#666}
.tile .s{font-size:11px;color:#999}
.bar{height:10px;background:#c5cae9;border-radius:5px;min-width:2px}
.bar.b2{background:#ffcc80}
.barcell{min-width:120px}
.heat{text-align:center !important;font-size:12px;white-space:nowrap}
.denom{font-size:11px;color:#e65100;font-weight:700;margin:4px 0 8px}
.ktabs{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px}
.ktab{padding:6px 12px;border-radius:16px;border:2px solid #c5cae9;background:#fff;color:#1a237e;font-size:12px;font-weight:700;cursor:pointer;font-family:inherit}
.ktab.on{background:#1a237e;color:#fff;border-color:#1a237e}
.words{display:flex;flex-wrap:wrap;gap:6px;margin:6px 0 12px}
.word{background:#eef2ff;color:#1a237e;border-radius:12px;padding:3px 10px;font-size:12px}
.word b{margin-left:4px;color:#e65100}
.tx-ev{margin:10px 0 4px;font-weight:700;font-size:13px;color:#1a237e}
.tx{background:#fafafa;border-left:3px solid #c5cae9;border-radius:0 8px 8px 0;padding:6px 10px;margin:4px 0;font-size:13px;line-height:1.7;white-space:pre-wrap;word-break:break-word}
.tx .g{font-size:10px;color:#999;margin-left:6px}
.tx-q{font-size:11px;color:#999}
.warnbox{background:#fff3e0;border-left:4px solid #e65100;border-radius:0 10px 10px 0;padding:8px 12px;font-size:12px;color:#8d4a00;margin-bottom:12px}
.modal{display:none;position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:300;align-items:center;justify-content:center;padding:12px}
.modal.show{display:flex}
.modal .box{background:#fff;border-radius:14px;max-width:720px;width:100%;max-height:90vh;overflow:auto;padding:16px}
.modal textarea{width:100%;height:46vh;font-size:12px;font-family:inherit;border:2px solid #e0e0e0;border-radius:8px;padding:8px}
</style></head><body>
<div class="top-bar">
  <div class="logo"><i class="fas fa-chart-bar"></i> 分析ダッシュボード</div>
  <div class="nav">
    <a href="/admin" class="btn-sm btn-back"><i class="fas fa-arrow-left"></i> 管理画面</a>
    <a href="/admin/events" class="btn-sm btn-back"><i class="fas fa-calendar-alt"></i> イベント</a>
    <a href="/admin/viewpoints" class="btn-sm btn-back"><i class="fas fa-exchange-alt"></i> 読みかえ表</a>
  </div>
</div>
<div class="container">
  <div class="card">
    <div class="ctrl">
      <select id="fySel" aria-label="年度"></select>
      <select id="evSel" aria-label="表示する回"><option value="">年度全体</option></select>
      <button class="btn btn-gray" id="aiBtn" type="button"><i class="fas fa-copy"></i> AIに貼る用にコピー（名前は伏せます）</button>
    </div>
    <div class="note" style="margin-top:8px">「参加」は受付をした人数（会員＋ゲスト）、「回答」はアンケートを送った人数です。成長の視点は「読みかえ表」で表記ゆれをまとめて数えています（元の回答は変えていません）。</div>
  </div>
  <div id="body"><div class="msg"><i class="fas fa-spinner fa-spin"></i> 読み込み中...</div></div>
</div>
<div class="modal" id="aiModal"><div class="box">
  <h3 style="margin:0 0 6px;color:#1a237e;font-size:16px"><i class="fas fa-copy"></i> AIに貼る用の文章</h3>
  <div class="note" id="aiInfo"></div>
  <textarea id="aiText" readonly></textarea>
  <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:8px;flex-wrap:wrap">
    <span id="aiStatus" class="note" style="margin-right:auto;align-self:center"></span>
    <button class="btn btn-primary" id="aiCopy" type="button"><i class="fas fa-copy"></i> コピー</button>
    <button class="btn btn-gray" id="aiClose" type="button">閉じる</button>
  </div>
</div></div>
<script>
${ADMIN_GUARD}
const RK = ['tried','a_little','not_yet','changed'];
const RL = { tried:'やってみた', a_little:'ちょっとだけ', not_yet:'まだ', changed:'考えが変わった', none:'一言だけ' };
const KL = { reason:'選んだ理由', try:'試してみたいこと', impression:'感想・学び', other:'その他の記述' };
let D = null, curKind = 'reason';
const params = new URLSearchParams(location.search);
function pct(a, b) { if (!b) return '－'; return (Math.round(a / b * 1000) / 10).toFixed(1) + '%'; }
function sumObj(o) { let s = 0; for (const k in o) s += o[k] || 0; return s; }

async function load(fy) {
  const body = document.getElementById('body');
  body.innerHTML = '<div class="msg"><i class="fas fa-spinner fa-spin"></i> 読み込み中...</div>';
  try {
    D = await api('/api/admin/analytics' + (fy ? '?fy=' + fy : ''));
  } catch (e) { body.innerHTML = '<div class="msg err">' + esc(e.message) + '</div>'; return; }
  const fs = document.getElementById('fySel');
  fs.innerHTML = D.fys.map(function(f) { return '<option value="' + f + '"' + (f === D.fy ? ' selected' : '') + '>' + f + '年度</option>'; }).join('');
  const es = document.getElementById('evSel');
  const want = params.get('event') || '';
  es.innerHTML = '<option value="">年度全体（' + D.events.length + '回）</option>' + D.events.map(function(e) { return '<option value="' + e.id + '"' + (String(e.id) === want ? ' selected' : '') + '>' + esc(e.date + ' ' + e.title) + '</option>'; }).join('');
  render();
}

function selEvents() {
  const v = document.getElementById('evSel').value;
  return v ? D.events.filter(function(e) { return String(e.id) === v; }) : D.events;
}

function render() {
  const evs = selEvents();
  const single = evs.length === 1 && document.getElementById('evSel').value;
  const body = document.getElementById('body');
  if (!D.events.length) { body.innerHTML = '<div class="card"><div class="msg">この年度の研修会はまだありません。</div></div>'; return; }
  let h = '';
  if (!D.alias_table) h += '<div class="warnbox">読みかえ表がまだ準備されていないため、初期設定の読みかえで数えています。</div>';
  // 読みかえ未設定
  const um = {};
  evs.forEach(function(e) { for (const k in e.unmapped) um[k] = (um[k] || 0) + e.unmapped[k]; });
  const umk = Object.keys(um);
  if (umk.length) h += '<div class="warnbox"><i class="fas fa-exclamation-triangle"></i> 読みかえが決まっていない選択肢があります（数に入れていません）：' + umk.map(function(k) { return esc(k) + '（' + um[k] + '件）'; }).join('、') + ' → <a href="/admin/viewpoints">読みかえ表で設定</a></div>';

  // 人数
  let am = 0, ag = 0, rm = 0, rg = 0;
  evs.forEach(function(e) { am += e.att_m; ag += e.att_g; rm += e.resp_m; rg += e.resp_g; });
  h += '<div class="card"><h2><i class="fas fa-users"></i> 参加と回答' + (single ? '' : '（' + D.fy + '年度・' + evs.length + '回の合計）') + '</h2><div class="tiles">';
  if (!single) h += tile(evs.length + '回', '研修会の数', '');
  h += tile((am + ag) + '人', single ? '参加人数' : '延べ参加人数', '会員' + am + '・ゲスト' + ag);
  h += tile((rm + rg) + '人', single ? '回答人数' : '延べ回答人数', '会員' + rm + '・ゲスト' + rg);
  h += tile(pct(rm + rg, am + ag), '回答率', '回答 ÷ 参加');
  if (!single) h += tile(D.unique_members + '人', '参加した会員の実人数', 'ゲストは人の区別ができないため含めません');
  h += '</div></div>';

  // 成長の視点
  const gp = {}; let gn = 0, gt = 0;
  evs.forEach(function(e) { gn += e.growth_n; gt += e.growth_total; for (const k in e.growth_people) gp[k] = (gp[k] || 0) + e.growth_people[k]; });
  h += '<div class="card"><h2><i class="fas fa-compass"></i> 成長の視点（複数選択）</h2>';
  if (!gn) {
    h += '<div class="msg">成長の視点の回答はありません。</div>';
  } else {
    h += '<div class="denom">「選んだ人の割合」の分母：視点の質問に答えた' + (single ? '' : '延べ') + gn + '人　／　「全選択に占める割合」の分母：選ばれた視点の合計' + gt + '件</div>';
    h += '<div class="tbl-wrap"><table class="t"><tr><th>視点</th><th class="num">選んだ人</th><th class="num">選んだ人の割合</th><th class="barcell"></th><th class="num">全選択に占める割合</th></tr>';
    let maxN = 0; D.canon.forEach(function(cn) { maxN = Math.max(maxN, gp[cn] || 0); });
    D.canon.forEach(function(cn) {
      const n = gp[cn] || 0; if (!n) return;
      h += '<tr><td>' + esc(cn) + (D.groups[cn] && D.groups[cn] !== '共通' ? ' <span class="pill gray">' + esc(D.groups[cn]) + '</span>' : '') + '</td><td class="num">' + n + '人</td><td class="num"><b>' + pct(n, gn) + '</b></td><td class="barcell"><div class="bar" style="width:' + Math.round(n / maxN * 100) + '%"></div></td><td class="num">' + pct(n, gt) + '</td></tr>';
    });
    h += '</table></div>';
    h += '<div class="note" style="margin-top:6px">1人がいくつも選べるので、「選んだ人の割合」を足すと100%を超えます。「全選択に占める割合」は足すと100%になります。</div>';
  }
  h += '</div>';

  // 回ごとの比較
  if (!single) {
    const used = D.canon.filter(function(cn) { return gp[cn]; });
    h += '<div class="card"><h2><i class="fas fa-table"></i> 回ごとの比較</h2>';
    h += '<div class="note">参加人数がちがう回どうしを比べられるよう、視点は「その回で視点の質問に答えた人のうち、選んだ人の割合」で示しています（かっこ内は人数）。人数が少ない回は、割合が大きく動きやすい点にご注意ください。</div>';
    h += '<div class="tbl-wrap" style="margin-top:8px"><table class="t"><tr><th>日付</th><th>研修会</th><th class="num">参加</th><th class="num">回答（率）</th><th class="num">視点の回答</th>';
    used.forEach(function(cn) { h += '<th class="heat">' + esc(cn) + '</th>'; });
    h += '</tr>';
    evs.forEach(function(e) {
      const att = e.att_m + e.att_g, resp = e.resp_m + e.resp_g;
      h += '<tr><td style="white-space:nowrap">' + esc(e.date) + '</td><td style="min-width:150px"><a href="?fy=' + D.fy + '&event=' + e.id + '" onclick="return pickEv(' + e.id + ')">' + esc(e.title) + '</a></td><td class="num">' + att + '</td><td class="num">' + resp + '（' + pct(resp, att) + '）</td><td class="num">' + (e.has_growth ? e.growth_n + '人' : '<span class="pill gray">質問なし</span>') + '</td>';
      used.forEach(function(cn) {
        const n = e.growth_people[cn] || 0;
        if (!e.growth_n) { h += '<td class="heat" style="color:#ccc">－</td>'; return; }
        const r = n / e.growth_n;
        h += '<td class="heat" style="background:rgba(57,73,171,' + (r * 0.55).toFixed(2) + ');color:' + (r > 0.6 ? '#fff' : '#333') + '">' + pct(n, e.growth_n) + '<br><span style="font-size:10px;opacity:.8">(' + n + ')</span></td>';
      });
      h += '</tr>';
    });
    h += '</table></div></div>';
  }

  // 前回の学びカード
  const rc = { tried:0, a_little:0, not_yet:0, changed:0, none:0 };
  evs.forEach(function(e) { for (const k in rc) rc[k] += e.recall[k] || 0; });
  const rcBtn = RK.reduce(function(s, k) { return s + rc[k]; }, 0);
  h += '<div class="card"><h2><i class="fas fa-bookmark"></i> 前回の学びカード（その後の様子）</h2>';
  if (!rcBtn && !rc.none) {
    h += '<div class="msg">記録はまだありません。</div>';
  } else {
    h += '<div class="denom">割合の分母：ボタンを押した' + (single ? '' : '延べ') + rcBtn + '人（ボタンは任意です）</div>';
    h += '<div class="tbl-wrap"><table class="t"><tr><th>ボタン</th><th class="num">人数</th><th class="num">割合</th><th class="barcell"></th></tr>';
    let mx = 0; RK.forEach(function(k) { mx = Math.max(mx, rc[k]); });
    RK.forEach(function(k) { h += '<tr><td>' + RL[k] + '</td><td class="num">' + rc[k] + '人</td><td class="num">' + pct(rc[k], rcBtn) + '</td><td class="barcell"><div class="bar b2" style="width:' + (mx ? Math.round(rc[k] / mx * 100) : 0) + '%"></div></td></tr>'; });
    h += '</table></div>';
    if (rc.none) h += '<div class="note">ほかに、ボタンは押さず一言だけ書いた人が' + rc.none + '人います。</div>';
    if (!single) {
      h += '<details style="margin-top:8px"><summary class="note" style="cursor:pointer">回ごとに見る</summary><div class="tbl-wrap"><table class="t"><tr><th>研修会</th>';
      RK.forEach(function(k) { h += '<th class="num">' + RL[k] + '</th>'; });
      h += '</tr>';
      evs.forEach(function(e) { const t = RK.reduce(function(s, k) { return s + (e.recall[k] || 0); }, 0); if (!t) return; h += '<tr><td>' + esc(e.date + ' ' + e.title) + '</td>'; RK.forEach(function(k) { h += '<td class="num">' + (e.recall[k] || 0) + '</td>'; }); h += '</tr>'; });
      h += '</table></div></details>';
    }
    h += '<div class="note" style="margin-top:6px">ひとことの内容は、イベント管理の各回「前回のふり返り」タブで見られます。</div>';
  }
  h += '</div>';

  // 自由記述
  h += '<div class="card"><h2><i class="fas fa-comment-dots"></i> 自由記述</h2><div class="ktabs" id="ktabs"></div><div id="kbody"></div></div>';
  body.innerHTML = h;
  renderTexts();
}
function tile(n, l, s) { return '<div class="tile"><div class="n">' + esc(n) + '</div><div class="l">' + esc(l) + '</div>' + (s ? '<div class="s">' + esc(s) + '</div>' : '') + '</div>'; }
function pickEv(id) { document.getElementById('evSel').value = String(id); render(); window.scrollTo(0, 0); return false; }

// 簡単な語の頻度（ブラウザの単語分け機能を使う。AIは使わない）
const STOP = ['今日','今回','本日','自分','思い','思う','感じ','非常','大変','とても','ありがとう','ござい','ございます','先生','部分','以降','明日','試し','是非','ぜひ','いただき','られる','できる','したい','たい','ない','こと','もの','ため','よう','とき','これ','それ','あれ','どれ','ところ','みたい','ので','から','けど','でも','など','また','もっと','すごく','思っ','感じ','考え','皆様','皆さん','みなさん','様々','色々','いろいろ'];
const KEEP_HIRA = ['まとめ','ふり返り','ふりかえり','つながり','めあて','しかけ','ゆさぶり','つぶやき','やりとり','問い','子ども'];
function isHira(s) { for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); if (!(c >= 0x3041 && c <= 0x309f) && c !== 0x30fc) return false; } return true; }
function isNum(s) { return /^[0-9０-９.．]+$/.test(s); }
function wordsOf(text) {
  const out = new Set();
  const t = String(text || '');
  KEEP_HIRA.forEach(function(w) { if (t.indexOf(w) >= 0) out.add(w); });
  if (window.Intl && Intl.Segmenter) {
    const seg = new Intl.Segmenter('ja', { granularity: 'word' });
    for (const s of seg.segment(t)) {
      if (!s.isWordLike) continue;
      const w = s.segment.trim();
      if (w.length < 2 || isHira(w) || isNum(w) || STOP.indexOf(w) >= 0) continue;
      out.add(w);
    }
  } else {
    const re = /[\\u4e00-\\u9fff々]{2,}|[\\u30a1-\\u30f6ー]{2,}|[A-Za-z]{3,}/g;
    let m; while ((m = re.exec(t))) { if (STOP.indexOf(m[0]) < 0) out.add(m[0]); }
  }
  return Array.from(out);
}
function renderTexts() {
  const evs = selEvents(); const ids = {}; evs.forEach(function(e) { ids[e.id] = e; });
  const items = D.texts.filter(function(t) { return ids[t.event_id]; });
  const cnt = {}; items.forEach(function(t) { cnt[t.kind] = (cnt[t.kind] || 0) + 1; });
  const kinds = ['reason','try','impression','other'].filter(function(k) { return cnt[k]; });
  if (!kinds.length) { document.getElementById('kbody').innerHTML = '<div class="msg">自由記述の回答はありません。</div>'; document.getElementById('ktabs').innerHTML = ''; return; }
  if (kinds.indexOf(curKind) < 0) curKind = kinds[0];
  document.getElementById('ktabs').innerHTML = kinds.map(function(k) { return '<button type="button" class="ktab' + (k === curKind ? ' on' : '') + '" data-k="' + k + '">' + KL[k] + '（' + cnt[k] + '）</button>'; }).join('');
  document.querySelectorAll('.ktab').forEach(function(b) { b.addEventListener('click', function() { curKind = b.getAttribute('data-k'); renderTexts(); }); });
  const list = items.filter(function(t) { return t.kind === curKind; });
  const freq = {};
  list.forEach(function(t) { wordsOf(t.text).forEach(function(w) { freq[w] = (freq[w] || 0) + 1; }); });
  const top = Object.keys(freq).filter(function(w) { return freq[w] >= 2; }).sort(function(a, b) { return freq[b] - freq[a]; }).slice(0, 30);
  let h = '<div class="note">よく出てくる語（その語を含む回答の数・2件以上）</div><div class="words">' + (top.length ? top.map(function(w) { return '<span class="word">' + esc(w) + '<b>' + freq[w] + '</b></span>'; }).join('') : '<span class="note">（まだ少ないため表示できません）</span>') + '</div>';
  let last = null;
  list.forEach(function(t) {
    if (t.event_id !== last) { const e = ids[t.event_id]; h += '<div class="tx-ev">' + esc(e.date + ' ' + e.title) + '</div>'; last = t.event_id; }
    h += '<div class="tx">' + (curKind === 'other' ? '<div class="tx-q">' + esc(t.q) + '</div>' : '') + esc(t.text) + (t.rtype === 'g' ? '<span class="g">ゲスト</span>' : '') + '</div>';
  });
  document.getElementById('kbody').innerHTML = h;
}

document.getElementById('fySel').addEventListener('change', function() { params.delete('event'); load(this.value); });
document.getElementById('evSel').addEventListener('change', render);
document.getElementById('aiBtn').addEventListener('click', async function() {
  const btn = this; btn.disabled = true;
  try {
    const d = await api('/api/admin/analytics/ai-text', { method: 'POST', body: JSON.stringify({ fy: D.fy, event_id: document.getElementById('evSel').value || null }) });
    document.getElementById('aiText').value = d.text;
    const m = (d.masked || []).map(function(x) { return x.label + ' ' + x.count + '件'; }).join('、');
    document.getElementById('aiInfo').innerHTML = '名前などを伏せた文章です（' + d.chars + '文字）。' + (m ? '伏せたもの：' + esc(m) + '。' : '') + '<br>コピーして、使っているAI（ChatGPT など）に貼り付けてください。AIには「回答の傾向」と「運営への提案」を分けて書くよう、指示文が入っています。<br><b>貼る前に、名前や学校名が残っていないか、ざっと確かめてください。</b>';
    document.getElementById('aiStatus').textContent = '';
    document.getElementById('aiModal').classList.add('show');
  } catch (e) { alert(e.message); }
  btn.disabled = false;
});
document.getElementById('aiCopy').addEventListener('click', async function() {
  const ta = document.getElementById('aiText');
  try { await navigator.clipboard.writeText(ta.value); } catch (e) { ta.select(); document.execCommand('copy'); }
  document.getElementById('aiStatus').textContent = 'コピーしました';
});
document.getElementById('aiClose').addEventListener('click', function() { document.getElementById('aiModal').classList.remove('show'); });
load(params.get('fy') || '');
</script>
</body></html>`
}

function viewpointsPage(commonHead: string): string {
  return `<!DOCTYPE html><html lang="ja"><head>${commonHead}
<meta name="robots" content="noindex, nofollow">
<title>視点の読みかえ表 - 社会科同好会</title>
<style>${GV_ADMIN_CSS}
.row-unset td{background:#fff8e1}
.chg td{background:#e8f5e9}
.cnt{font-size:12px;color:#777;white-space:nowrap}
.sel{min-width:150px}
.newname{width:130px;display:none;margin-top:4px}
@media(max-width:600px){.upd{display:none}.sel{min-width:120px;max-width:46vw}}
.save-bar{position:sticky;bottom:0;background:#fff;border-top:2px solid #e0e0e0;padding:10px 14px;display:flex;gap:10px;align-items:center;justify-content:flex-end;flex-wrap:wrap}
</style></head><body>
<div class="top-bar">
  <div class="logo"><i class="fas fa-exchange-alt"></i> 視点の読みかえ表</div>
  <div class="nav">
    <a href="/admin" class="btn-sm btn-back"><i class="fas fa-arrow-left"></i> 管理画面</a>
    <a href="/admin/analytics" class="btn-sm btn-back"><i class="fas fa-chart-bar"></i> 分析</a>
  </div>
</div>
<div class="container">
  <div class="card">
    <h2><i class="fas fa-info-circle"></i> この表について</h2>
    <div class="note">小・中・管理職や回によって、成長の視点の選択肢の書き方が少しずつちがいます（例：「授業をする」「授業をする・磨く」）。<br>
    この表で「どの共通の視点として数えるか」を決めます。<b>元の回答は書き換えません。</b>分析ダッシュボード・ポートフォリオ・成長レポートの数え方だけが変わります。<br>
    「数えない」にした選択肢は、集計に入りません。黄色の行は、まだ読みかえが決まっていない選択肢です。</div>
  </div>
  <div class="card">
    <div id="list"><div class="msg"><i class="fas fa-spinner fa-spin"></i> 読み込み中...</div></div>
  </div>
</div>
<div class="save-bar">
  <span id="status" class="note"></span>
  <button class="btn btn-gray" id="resetBtn" type="button">変更を取り消す</button>
  <button class="btn btn-primary" id="saveBtn" type="button" disabled><i class="fas fa-save"></i> 保存する</button>
</div>
<script>
${ADMIN_GUARD}
let V = null; const changes = {};
const NEW = '__new__', SKIP = '__skip__', UNSET = '__unset__';
async function load() {
  try { V = await api('/api/admin/viewpoint-aliases'); } catch (e) { document.getElementById('list').innerHTML = '<div class="msg err">' + esc(e.message) + '</div>'; return; }
  for (const k in changes) delete changes[k];
  render();
}
function curMap() { const m = {}; V.aliases.forEach(function(a) { m[a.alias] = a; }); return m; }
function render() {
  const map = curMap();
  const obs = {}; V.observed.forEach(function(o) { obs[o.alias] = o; });
  const all = Object.keys(Object.assign({}, obs, map));
  const canonIdx = {}; V.canon.forEach(function(c, i) { canonIdx[c] = i; });
  all.sort(function(a, b) {
    const ua = map[a] ? 1 : 0, ub = map[b] ? 1 : 0; if (ua !== ub) return ua - ub;
    const ca = map[a] ? (canonIdx[map[a].canonical] != null ? canonIdx[map[a].canonical] : 99) : 0, cb = map[b] ? (canonIdx[map[b].canonical] != null ? canonIdx[map[b].canonical] : 99) : 0;
    if (ca !== cb) return ca - cb; return a < b ? -1 : 1;
  });
  if (!V.alias_table) { document.getElementById('list').innerHTML = '<div class="msg err">読みかえ表がまだ準備されていません（データベースの更新待ち）。</div>'; return; }
  let h = '<div class="tbl-wrap"><table class="t"><tr><th>回答に出てくる選択肢（元のまま）</th><th>共通の視点として数える</th><th class="upd">最終更新</th></tr>';
  all.forEach(function(al) {
    const a = map[al], o = obs[al] || { count_m: 0, count_g: 0, in_options: false };
    const cur = Object.prototype.hasOwnProperty.call(changes, al) ? changes[al] : (a ? (a.canonical === '' ? SKIP : a.canonical) : UNSET);
    const changed = Object.prototype.hasOwnProperty.call(changes, al);
    let opts = '';
    if (!a) opts += '<option value="' + UNSET + '"' + (cur === UNSET ? ' selected' : '') + '>（未設定）</option>';
    V.canon.forEach(function(cn) { opts += '<option value="' + esc(cn) + '"' + (cur === cn ? ' selected' : '') + '>' + esc(cn) + '</option>'; });
    if (cur !== UNSET && cur !== SKIP && cur !== NEW && V.canon.indexOf(cur) < 0) opts += '<option value="' + esc(cur) + '" selected>' + esc(cur) + '</option>';
    opts += '<option value="' + SKIP + '"' + (cur === SKIP ? ' selected' : '') + '>数えない</option>';
    opts += '<option value="' + NEW + '">＋新しい視点名…</option>';
    h += '<tr class="' + (changed ? 'chg' : (!a ? 'row-unset' : '')) + '"><td><b>' + esc(al) + '</b>' + (o.in_options ? ' <span class="pill gray">選択肢</span>' : '')
      + '<div class="cnt">回答 会員' + o.count_m + '・ゲスト' + o.count_g + '</div></td>'
      + '<td><select class="sel" data-al="' + esc(al) + '">' + opts + '</select><input type="text" class="newname" maxlength="30" placeholder="視点名" data-al="' + esc(al) + '"></td>'
      + '<td class="cnt upd">' + (a && a.updated_at ? esc(a.updated_at.slice(0, 16)) + (a.updated_by_name ? '<br>' + esc(a.updated_by_name) : '') : '') + '</td></tr>';
  });
  h += '</table></div>';
  document.getElementById('list').innerHTML = h;
  document.querySelectorAll('select.sel').forEach(function(s) {
    s.addEventListener('change', function() {
      const al = s.getAttribute('data-al');
      const inp = s.parentElement.querySelector('.newname');
      if (s.value === NEW) { inp.style.display = 'block'; inp.focus(); return; }
      inp.style.display = 'none';
      setChange(al, s.value);
    });
  });
  document.querySelectorAll('input.newname').forEach(function(inp) {
    inp.addEventListener('change', function() { const v = inp.value.trim(); if (v) { setChange(inp.getAttribute('data-al'), v); if (V.canon.indexOf(v) < 0) V.canon.push(v); render(); } });
  });
  updateBar();
}
function setChange(al, v) {
  const a = curMap()[al];
  const orig = a ? (a.canonical === '' ? SKIP : a.canonical) : UNSET;
  if (v === orig) delete changes[al]; else changes[al] = v;
  const tr = document.querySelector('select.sel[data-al="' + CSS.escape(al) + '"]');
  if (tr) tr.closest('tr').className = Object.prototype.hasOwnProperty.call(changes, al) ? 'chg' : (!a ? 'row-unset' : '');
  updateBar();
}
function updateBar() {
  const n = Object.keys(changes).length;
  document.getElementById('saveBtn').disabled = !n;
  document.getElementById('status').textContent = n ? n + '件の変更（まだ保存していません）' : '';
}
document.getElementById('resetBtn').addEventListener('click', function() { for (const k in changes) delete changes[k]; render(); });
document.getElementById('saveBtn').addEventListener('click', async function() {
  const items = Object.keys(changes).map(function(al) { const v = changes[al]; if (v === UNSET) return { alias: al, remove: true }; return { alias: al, canonical: v === SKIP ? '' : v }; });
  this.disabled = true;
  try { await api('/api/admin/viewpoint-aliases', { method: 'PUT', body: JSON.stringify({ items: items }) }); document.getElementById('status').textContent = '保存しました'; await load(); document.getElementById('status').textContent = '保存しました'; }
  catch (e) { document.getElementById('status').textContent = e.message; this.disabled = false; }
});
load();
</script>
</body></html>`
}
