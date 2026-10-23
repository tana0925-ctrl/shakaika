// ========== アプリとしてインストール（ホーム画面に追加）の案内 ==========
// ・ブラウザの自動の案内は出さない（beforeinstallprompt を preventDefault して取っておく）。
// ・マイページ（会員）と管理画面（管理者）の上の方に、小さな「📱 ホーム画面に追加」カードを1つだけ出す。
//   ×で閉じたらその端末では二度と出さない。ホーム画面から開いている時・追加済みの時は出さない。
// ・閉じた後でも追加できるよう、/app-install（追加のしかた）へのリンクをプロフィール設定・新着の設定に置く。
// ・受付QRの画面など研修会中に使う画面には出さない（カードはマイページと管理画面だけ）。

// 全ページの <head> に入れる（commonHead）：自動の案内を止めて、ボタンで使えるように取っておく
export const A2HS_HEAD_SCRIPT = `<script>
(function(){
  window.__bip = null;
  window.addEventListener('beforeinstallprompt', function(e){ e.preventDefault(); window.__bip = e; try { document.dispatchEvent(new Event('a2hs-ready')); } catch(_){} });
  window.addEventListener('appinstalled', function(){ window.__bip = null; try { localStorage.setItem('a2hs_done','1'); } catch(_){} try { document.dispatchEvent(new Event('a2hs-done')); } catch(_){} });
})();
</script>`

// iPhoneの共有ボタンの絵（□に↑）
const SHARE_SVG = '<svg width="18" height="20" viewBox="0 0 18 22" style="vertical-align:-4px" aria-hidden="true"><path d="M9 1v12M5 5l4-4 4 4" fill="none" stroke="#1565c0" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M6 8H2v13h14V8h-4" fill="none" stroke="#1565c0" stroke-width="2" stroke-linejoin="round"/></svg>'
const PLUS_SVG = '<svg width="18" height="18" viewBox="0 0 18 18" style="vertical-align:-4px" aria-hidden="true"><rect x="1" y="1" width="16" height="16" rx="4" fill="none" stroke="#333" stroke-width="1.6"/><path d="M9 5v8M5 9h8" stroke="#333" stroke-width="1.6" stroke-linecap="round"/></svg>'

export const IOS_STEPS_HTML =
  '<ol style="margin:6px 0 0 18px;padding:0;line-height:1.9">' +
  '<li>Safariの下（iPadは上）にある共有ボタン ' + SHARE_SVG + ' を押す</li>' +
  '<li>メニューを上にずらして「ホーム画面に追加」' + PLUS_SVG + ' を押す</li>' +
  '<li>右上の「追加」を押す → ホーム画面に「学びの道しるべ」ができます</li>' +
  '</ol><div style="font-size:11px;color:#888;margin-top:4px">※ ChromeなどSafari以外で開いているときは、Safariで開き直してください。ホーム画面のアイコンから開いたら、最初に一度ログインしてください。</div>'

// マイページ・管理画面に入れるカード（HTML＋動き）。表示条件を満たさないときは何も出さない
export function a2hsCardHtml(): string {
  return `<div id="a2hsCard" style="display:none;position:relative;margin:0 0 14px;padding:10px 40px 10px 14px;background:#fff;border:1px solid #ffe0b2;border-radius:12px;box-shadow:0 1px 4px rgba(0,0,0,.05);font-size:13px;color:#555;line-height:1.6">
  <button type="button" id="a2hsClose" aria-label="閉じる" style="position:absolute;top:4px;right:6px;background:none;border:none;font-size:20px;color:#aaa;cursor:pointer;padding:2px 8px">&times;</button>
  <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
    <span style="font-weight:700;color:#d84315">📱 ホーム画面に追加</span>
    <span>アプリのようにすぐ開けます</span>
    <button type="button" id="a2hsBtn" style="padding:5px 14px;border-radius:16px;border:none;background:#d84315;color:#fff;font-weight:700;font-size:12px;cursor:pointer;font-family:inherit">追加する</button>
  </div>
  <div id="a2hsIos" style="display:none;margin-top:6px">${IOS_STEPS_HTML}</div>
</div>
<script>
(function(){
  var card = document.getElementById('a2hsCard'); if (!card) return;
  function ls(k, v) { try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch(e) { return null; } }
  var standalone = (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || window.navigator.standalone === true;
  if (standalone || ls('a2hs_closed') === '1' || ls('a2hs_done') === '1') return;
  var ua = navigator.userAgent;
  var isIOS = /iPhone|iPad|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  function show() { card.style.display = 'block'; }
  function hide() { card.style.display = 'none'; }
  document.getElementById('a2hsClose').addEventListener('click', function(){ ls('a2hs_closed', '1'); hide(); });
  document.getElementById('a2hsBtn').addEventListener('click', function(){
    if (window.__bip) {
      var ev = window.__bip; window.__bip = null;
      ev.prompt();
      ev.userChoice.then(function(r){ if (r && r.outcome === 'accepted') { ls('a2hs_done', '1'); hide(); } }).catch(function(){});
    } else if (isIOS) {
      var s = document.getElementById('a2hsIos'); s.style.display = s.style.display === 'none' ? 'block' : 'none';
    } else {
      location.href = '/app-install';
    }
  });
  document.addEventListener('a2hs-done', hide);
  if (isIOS) show();                      // iPhone/iPad：手順を出すボタン
  else if (window.__bip) show();           // Android/Chrome：追加できるときだけ
  else document.addEventListener('a2hs-ready', show);
})();
</script>`
}

// 「ホーム画面に追加のしかた」（だれでも見られる説明だけのページ）
export function registerInstallHelp(app: any, commonHead: string) {
  app.get('/app-install', (c: any) => c.html(`<!DOCTYPE html><html lang="ja"><head>${commonHead}
<title>ホーム画面に追加のしかた - 学びの道しるべ</title>
<style>
.wrap{max-width:560px;margin:0 auto;padding:20px 16px 50px}
.box{background:#fff;border:1px solid #f0e6d2;border-radius:14px;padding:14px 16px;margin-bottom:14px;font-size:14px;color:#555;line-height:1.7}
.box h2{font-size:16px;color:#d84315;margin:0 0 6px}
.btn{padding:8px 18px;border-radius:18px;border:none;background:#d84315;color:#fff;font-weight:700;font-size:14px;cursor:pointer;font-family:inherit}
</style></head><body>
<div class="wrap">
  <h1 style="font-family:'Zen Maru Gothic',sans-serif;color:#d84315;font-size:20px;margin:0 0 6px">📱 ホーム画面に追加のしかた</h1>
  <p style="font-size:13px;color:#777;margin:0 0 14px">ホーム画面に「学びの道しるべ」アイコンができ、アプリのようにすぐ開けます。開くとログイン後、会員の方はマイページ、事務局の方は管理画面に進みます。</p>
  <div class="box" id="instBox" style="display:none"><h2>この端末ですぐ追加</h2><button class="btn" id="instBtn" type="button">ホーム画面に追加する</button></div>
  <div class="box"><h2>iPhone・iPad（Safari）</h2>${IOS_STEPS_HTML}</div>
  <div class="box"><h2>Android（Chrome）</h2><ol style="margin:6px 0 0 18px;padding:0;line-height:1.9"><li>Chromeでこのサイトを開く</li><li>右上の︙（メニュー）→「ホーム画面に追加」または「アプリをインストール」</li><li>「追加」（「インストール」）を押す</li></ol></div>
  <div class="box" style="font-size:12px;color:#888">追加をやめたいときは、ホーム画面のアイコンを長押しして削除してください。記録などのデータは消えません。</div>
  <p style="text-align:center"><a href="/" style="color:#d84315;font-weight:700">← もどる</a></p>
</div>
<script>
(function(){
  var standalone = (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || window.navigator.standalone === true;
  var box = document.getElementById('instBox');
  function ready(){ if (!standalone && window.__bip) box.style.display = 'block'; }
  ready(); document.addEventListener('a2hs-ready', ready);
  document.getElementById('instBtn').addEventListener('click', function(){
    if (!window.__bip) return; var ev = window.__bip; window.__bip = null; ev.prompt();
    ev.userChoice.then(function(r){ if (r && r.outcome === 'accepted') { try { localStorage.setItem('a2hs_done','1'); } catch(e){} box.style.display = 'none'; } }).catch(function(){});
  });
})();
</script></body></html>`))
}
