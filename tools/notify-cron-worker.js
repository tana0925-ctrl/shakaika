// 新着の振り返り：まとめ送信を10分ごとに呼ぶための小さな Cloudflare Worker（Cron Trigger: */10 * * * *）
// Cloudflare Pages には Cron が無いため、別の Worker から /api/notify/tick を呼ぶ。
// /api/notify/tick は「送る時期になったものだけ」送り、短時間の重複は間引くので、だれが呼んでも安全。
// ダッシュボードの Worker「shakaika-notify-cron」にこの内容（1行にまとめたもの）を貼っている（鍵や秘密は不要）。
export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(fetch('https://shakaika.pages.dev/api/notify/tick', { method: 'POST', headers: { 'User-Agent': 'shakaika-notify-cron' } }))
  },
  async fetch() {
    return new Response('ok')
  }
}
