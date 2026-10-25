// ========== 利用状況（人数だけ・管理者のみ） ==========
// ・会員がページを開いたとき、ページごとの「開かれた回数（日ごと）」と「使った人数（週ごと）」だけを数える。
// ・誰が開いたかは画面に出さない・記録として残さない：
//   週ごとの人数を数えるために、その週だけの合言葉（usage_salt）と会員IDから作った読めない記号（usage_week_seen）を使う。
//   週が変わったら人数だけ（usage_week_people）を残して、記号と合言葉は消す（あとから誰だったかを戻せない）。
// ・管理者とゲストは数えない。数えるのに失敗しても、ページの表示には影響しない。
import { GV_ADMIN_CSS } from './growth_common'

type Deps = { authMiddleware: any; adminMiddleware: any; commonHead: string }

// 数えるページ（それ以外のページは数えない）
export const USAGE_PAGES: { key: string; label: string }[] = [
  { key: 'mypage', label: 'マイページ' },
  { key: 'portfolio', label: '学びの記録' },
  { key: 'report', label: '成長レポート' },
  { key: 'insights', label: 'みんなの気づき' },
  { key: 'attend', label: '受付QR' },
  { key: 'app', label: 'ホーム画面から' }
]
const KEYS = USAGE_PAGES.map((p) => p.key).concat(['_any'])

function pageKeyOf(path: string): string | null {
  const p = String(path || '').replace(/\/+$/, '') || '/'
  if (p === '/mypage') return 'mypage'
  if (p === '/mypage/portfolio') return 'portfolio'
  if (p === '/mypage/report') return 'report'
  if (p === '/mypage/insights') return 'insights'
  if (/^\/attend\/[^/]+$/.test(p)) return 'attend'
  return null
}

// 日本時間の日付（YYYY-MM-DD）と、その週の月曜日
function jstDay(ms?: number): string {
  return new Date((ms || Date.now()) + 9 * 3600 * 1000).toISOString().slice(0, 10)
}
function mondayOf(day: string): string {
  const d = new Date(day + 'T00:00:00Z')
  const wd = (d.getUTCDay() + 6) % 7 // 月=0
  return new Date(d.getTime() - wd * 86400000).toISOString().slice(0, 10)
}
async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('')
}
function randomHex(n: number): string {
  const u = new Uint8Array(n); crypto.getRandomValues(u)
  return Array.from(u).map((b) => b.toString(16).padStart(2, '0')).join('')
}

// 前の週の記号を人数にまとめて、記号と合言葉を消す（その週の最初の1回だけ動く）
async function closeOldWeeks(db: D1Database, week: string) {
  await db.prepare('INSERT OR REPLACE INTO usage_week_people (week, page, people) SELECT week, page, COUNT(*) FROM usage_week_seen WHERE week < ? GROUP BY week, page').bind(week).run()
  await db.prepare('DELETE FROM usage_week_seen WHERE week < ?').bind(week).run()
  await db.prepare('DELETE FROM usage_salt WHERE week < ?').bind(week).run()
}

async function recordUsage(db: D1Database, uid: number, keys: string[]) {
  const day = jstDay()
  const week = mondayOf(day)
  let salt = (await db.prepare('SELECT salt FROM usage_salt WHERE week = ?').bind(week).first() as any)?.salt
  if (!salt) {
    const r = await db.prepare('INSERT OR IGNORE INTO usage_salt (week, salt) VALUES (?, ?)').bind(week, randomHex(16)).run()
    salt = (await db.prepare('SELECT salt FROM usage_salt WHERE week = ?').bind(week).first() as any)?.salt
    if (r.meta && r.meta.changes) await closeOldWeeks(db, week)
  }
  if (!salt) return
  const h = (await sha256Hex(salt + ':' + uid)).slice(0, 32)
  const stmts: any[] = []
  for (const k of keys) {
    stmts.push(db.prepare('INSERT INTO usage_daily (day, page, views) VALUES (?, ?, 1) ON CONFLICT(day, page) DO UPDATE SET views = views + 1').bind(day, k))
    stmts.push(db.prepare('INSERT OR IGNORE INTO usage_week_seen (week, page, h) VALUES (?, ?, ?)').bind(week, k, h))
  }
  await db.batch(stmts)
}

// 全ページの <head> に入れる（commonHead）：ログインした会員だけ、数えるページで1回送る
export const USAGE_HEAD_SCRIPT = `<script>
(function(){
  try {
    var p = location.pathname.replace(/\\/+$/, '') || '/';
    if (!(/^\\/mypage(\\/(portfolio|report|insights))?$/.test(p) || /^\\/attend\\/[^\\/]+$/.test(p))) return;
    var t = localStorage.getItem('token'); if (!t) return;
    var u = JSON.parse(localStorage.getItem('user') || 'null'); if (!u || u.role === 'admin') return;
    var app = (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || window.navigator.standalone === true;
    var body = JSON.stringify({ path: p, app: !!app });
    setTimeout(function(){ fetch('/api/usage/ping', { method: 'POST', headers: { 'Authorization': 'Bearer ' + t, 'Content-Type': 'application/json' }, body: body, keepalive: true }).catch(function(){}); }, 800);
  } catch (e) {}
})();
</script>`

export function registerUsage(app: any, deps: Deps) {
  const { authMiddleware, adminMiddleware, commonHead } = deps

  app.post('/api/usage/ping', authMiddleware, async (c: any) => {
    const user = c.get('user')
    if (!user || user.role === 'admin') return c.json({ ok: true })
    let body: any = {}
    try { body = await c.req.json() } catch (e) {}
    const key = pageKeyOf(body.path)
    if (!key) return c.json({ ok: true })
    const keys = [key, '_any']
    if (body.app === true) keys.push('app')
    const job = recordUsage(c.env.DB, Number(user.id), keys).catch(() => {})
    try { c.executionCtx.waitUntil(job) } catch (e) { await job }
    return c.json({ ok: true })
  })

  app.get('/api/admin/usage', authMiddleware, adminMiddleware, async (c: any) => {
    const db = c.env.DB
    const today = jstDay()
    const thisWeek = mondayOf(today)
    const nWeeks = 12
    const weeks: string[] = []
    for (let i = 0; i < nWeeks; i++) weeks.push(new Date(new Date(thisWeek + 'T00:00:00Z').getTime() - i * 7 * 86400000).toISOString().slice(0, 10))
    const oldest = weeks[weeks.length - 1]
    const from30 = jstDay(Date.now() - 29 * 86400000)
    try {
      const [cur, past, daily, mem, first] = await Promise.all([
        db.prepare('SELECT week, page, COUNT(*) AS n FROM usage_week_seen WHERE week >= ? GROUP BY week, page').bind(oldest).all(),
        db.prepare('SELECT week, page, people AS n FROM usage_week_people WHERE week >= ?').bind(oldest).all(),
        db.prepare('SELECT day, page, views FROM usage_daily WHERE day >= ?').bind(oldest).all(),
        db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'member'").first(),
        db.prepare('SELECT MIN(day) AS d FROM usage_daily').first()
      ])
      const W: Record<string, any> = {}
      for (const w of weeks) { W[w] = {}; for (const k of KEYS) W[w][k] = { people: 0, views: 0 } }
      for (const r of ((past as any).results || [])) if (W[r.week] && W[r.week][r.page]) W[r.week][r.page].people = r.n
      for (const r of ((cur as any).results || [])) if (W[r.week] && W[r.week][r.page]) W[r.week][r.page].people = r.n
      const D: Record<string, number> = {}
      for (const r of ((daily as any).results || [])) {
        const w = mondayOf(r.day)
        if (W[w] && W[w][r.page]) W[w][r.page].views += r.views
        if (r.page === '_any' && r.day >= from30) D[r.day] = (D[r.day] || 0) + r.views
      }
      const days: { day: string; views: number }[] = []
      for (let i = 29; i >= 0; i--) { const d = jstDay(Date.now() - i * 86400000); days.push({ day: d, views: D[d] || 0 }) }
      return c.json({
        ready: true, today, this_week: thisWeek, members: (mem as any)?.n || 0, since: (first as any)?.d || null,
        pages: USAGE_PAGES, weeks: weeks.map((w) => ({ week: w, pages: W[w] })), days
      })
    } catch (e) {
      return c.json({ ready: false, pages: USAGE_PAGES, weeks: [], days: [] })
    }
  })

  app.get('/admin/usage', (c: any) => c.html(usagePage(commonHead)))
}

function usagePage(commonHead: string): string {
  return `<!DOCTYPE html><html lang="ja"><head>${commonHead}
<meta name="robots" content="noindex, nofollow">
<title>利用状況 - 学びの道しるべ</title>
<style>${GV_ADMIN_CSS}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px;margin-bottom:6px}
.tile{background:#f5f6fb;border-radius:12px;padding:10px 12px}
.tile .n{font-size:24px;font-weight:700;color:#1a237e;line-height:1.2}
.tile .l{font-size:11px;color:#666}
.wrapx{overflow-x:auto}
table.u{border-collapse:collapse;width:100%;font-size:13px;min-width:560px}
table.u th,table.u td{border-bottom:1px solid #eee;padding:7px 6px;text-align:right;white-space:nowrap}
table.u th{background:#e8eaf6;color:#1a237e;font-size:12px;text-align:center}
table.u td:first-child{text-align:left}
table.u tr.now td{background:#fff8e1}
.v{display:block;font-size:10.5px;color:#999}
.bars{display:flex;align-items:flex-end;gap:3px;height:110px;padding:6px 0;border-bottom:1px solid #ddd}
.bars div{flex:1;background:#7986cb;border-radius:3px 3px 0 0;min-height:1px;position:relative}
.bars div.zero{background:#e0e0e0}
.bl{display:flex;justify-content:space-between;font-size:10.5px;color:#888;margin-top:3px}
.muted{color:#888;font-size:12px}
</style></head><body>
<div class="top-bar">
  <div class="logo"><i class="fas fa-chart-line"></i> 利用状況</div>
  <div class="nav">
    <a href="/admin" class="btn-sm btn-back"><i class="fas fa-arrow-left"></i> 管理画面</a>
    <a href="/admin/analytics" class="btn-sm btn-back"><i class="fas fa-chart-bar"></i> 分析</a>
  </div>
</div>
<div class="container">
  <div class="card">
    <div class="note"><b>人数だけを数えています。</b>誰が開いたかは記録していません（週ごとの人数を数えるための記号も、週が変わると消えます）。管理者とゲストは数えません。<br>
    「使った人」はその週に1回でも開いた会員の人数、小さい数字は開かれた回数です。「ホーム画面から」は、ホーム画面に追加したアイコンから開いた人です。</div>
  </div>
  <div id="out"><div class="card"><p class="muted">読み込み中...</p></div></div>
</div>
<script>
${ADMIN_GUARD_JS}
function wlabel(w){ var d=new Date(w+'T00:00:00Z'); var e=new Date(d.getTime()+6*86400000); function f(x){return (x.getUTCMonth()+1)+'/'+x.getUTCDate();} return f(d)+'〜'+f(e); }
async function load(){
  var out=document.getElementById('out');
  try{
    var d=await api('/api/admin/usage');
    if(!d.ready){ out.innerHTML='<div class="card"><p class="muted">まだ準備ができていません（記録用の表がありません）。</p></div>'; return; }
    var W=d.weeks, cur=W[0], prev=W[1];
    var h='<div class="card"><h2><i class="fas fa-users"></i> 今週と先週</h2><div class="tiles">';
    h+='<div class="tile"><div class="n">'+cur.pages._any.people+'人</div><div class="l">今週使った会員（'+wlabel(cur.week)+'）<br>会員'+d.members+'人中</div></div>';
    h+='<div class="tile"><div class="n">'+prev.pages._any.people+'人</div><div class="l">先週使った会員（'+wlabel(prev.week)+'）</div></div>';
    h+='<div class="tile"><div class="n">'+cur.pages._any.views+'回</div><div class="l">今週開かれた回数</div></div>';
    h+='<div class="tile"><div class="n">'+cur.pages.app.people+'人</div><div class="l">今週ホーム画面から開いた会員</div></div>';
    h+='</div>'+(d.since?'<p class="muted">'+esc(d.since)+' から数えています。</p>':'<p class="muted">まだ記録がありません。会員がページを開くと数え始めます。</p>')+'</div>';
    h+='<div class="card"><h2><i class="fas fa-table"></i> 週ごとの使った人数（直近12週）</h2><div class="wrapx"><table class="u"><tr><th>週（月〜日）</th><th>使った人</th>';
    d.pages.forEach(function(p){ h+='<th>'+esc(p.label)+'</th>'; });
    h+='</tr>';
    W.forEach(function(w,i){
      h+='<tr'+(i===0?' class="now"':'')+'><td>'+wlabel(w.week)+(i===0?'（今週）':'')+'</td>';
      h+='<td><b>'+w.pages._any.people+'人</b><span class="v">'+w.pages._any.views+'回</span></td>';
      d.pages.forEach(function(p){ var x=w.pages[p.key]; h+='<td>'+x.people+'人<span class="v">'+x.views+'回</span></td>'; });
      h+='</tr>';
    });
    h+='</table></div></div>';
    var mx=1; d.days.forEach(function(x){ if(x.views>mx) mx=x.views; });
    h+='<div class="card"><h2><i class="fas fa-chart-bar"></i> 日ごとの開かれた回数（直近30日）</h2><div class="bars">';
    d.days.forEach(function(x){ h+='<div class="'+(x.views?'':'zero')+'" style="height:'+Math.max(1,Math.round(x.views/mx*100))+'%" title="'+esc(x.day)+'：'+x.views+'回"></div>'; });
    var a=d.days[0].day, b=d.days[d.days.length-1].day;
    h+='</div><div class="bl"><span>'+a.slice(5).replace('-','/')+'</span><span>いちばん多い日 '+mx+'回</span><span>'+b.slice(5).replace('-','/')+'</span></div></div>';
    out.innerHTML=h;
  }catch(e){ out.innerHTML='<div class="card"><p style="color:#c62828">'+esc(e.message)+'</p></div>'; }
}
load();
</script></body></html>`
}

const ADMIN_GUARD_JS = `
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
