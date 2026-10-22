/**
 * smoke.js — Pruebas automatizadas de humo (Node ≥18, sin dependencias).
 *   node smoke.js            (desde la raíz del proyecto)   ·   npm test
 * 1) Lee index.html y verifica el ORDEN EXACTO de scripts v2.
 * 2) Carga js/*.js en ese orden sobre un DOM simulado con Telegram WebApp, red /v2 y
 *    WebSocket simulados, y ejercita arranque, seguridad, chat, pagos y navegación.
 */
const fs = require('fs'), vm = require('vm'), path = require('path');
const ROOT = process.argv[2] ? path.resolve(process.argv[2]) : __dirname;
const results = []; const ok = (c, m) => { results.push((c ? 'PASS ' : 'FAIL ') + m); if (!c) process.exitCode = 1; };

// ---------------- DOM mínimo ----------------
const byId = new Map(); const listeners = {};
class ClassList { constructor(){ this.s = new Set(); } add(...c){ c.forEach(x=>this.s.add(x)); } remove(...c){ c.forEach(x=>this.s.delete(x)); } contains(c){ return this.s.has(c); } toggle(c,f){ const on = f===undefined ? !this.s.has(c) : f; on?this.s.add(c):this.s.delete(c); return on; } replace(a,b){ if(this.s.has(a)){this.s.delete(a);this.s.add(b);} } }
class El {
  constructor(tag){ this.tagName = String(tag).toUpperCase(); this.classList = new ClassList(); this.children = []; this.style = {}; this.dataset = {}; this.attrs = {}; this._html=''; this.textContent=''; this.parentElement=null; this.value=''; }
  set id(v){ this._id=v; byId.set(v,this); } get id(){ return this._id||''; }
  set className(v){ this.classList = new ClassList(); String(v).split(/\s+/).filter(Boolean).forEach(c=>this.classList.add(c)); } get className(){ return [...this.classList.s].join(' '); }
  set innerHTML(v){ this._html = String(v); this.children=[]; } get innerHTML(){ return this._html; }
  insertAdjacentHTML(_p, html){ this._html += html; const m = /id="([^"]+)"/g; let r; while((r=m.exec(html))){ if(!byId.has(r[1])){ const e=new El('div'); e.id=r[1]; if(/class="[^"]*hidden/.test(html.slice(r.index-200, r.index+200))) e.classList.add('hidden'); } } }
  appendChild(c){ this.children.push(c); c.parentElement=this; return c; }
  remove(){ if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(x=>x!==this); if(this._id) byId.delete(this._id); }
  setAttribute(k,v){ this.attrs[k]=String(v); if(k==='id') this.id=v; if(k.startsWith('data-')) this.dataset[k.slice(5).replace(/-(\w)/g,(_,c)=>c.toUpperCase())]=String(v); if(k==='class') this.className=v; }
  getAttribute(k){ return this.attrs[k] ?? null; } removeAttribute(k){ delete this.attrs[k]; }
  addEventListener(){} querySelector(){ return null; } querySelectorAll(){ return []; } closest(){ return null; } matches(){ return false; }
  focus(){} click(){ this.clicked=true; } play(){ return Promise.resolve(); } select(){}
  get childElementCount(){ return this.children.length; } get nextElementSibling(){ return null; }
}
const body = new El('body'); body.contains = () => true;
const document = {
  body, readyState: 'complete', visibilityState: 'visible',
  createElement: (t)=>new El(t), createTextNode: (t)=>({ nodeType:3, textContent:t }),
  getElementById: (id)=>byId.get(id)||null,
  querySelectorAll: (sel)=> sel.startsWith('[id^="view-"]') ? [...byId.values()].filter(e=>e.id.startsWith('view-')) : [],
  querySelector: ()=>null,
  addEventListener: (e,f)=>{ (listeners['doc:'+e]=listeners['doc:'+e]||[]).push(f); },
  execCommand: ()=>true,
};
['view-splash','view-feed','view-login','view-consent','view-captcha','feed-container','modal-global-chat','global-chat-messages','chat-messages','floating-video-bunker','bunker-webcam-feed'].forEach(id=>{ const e=new El('div'); e.id=id; body.appendChild(e); });

// ---------------- Telegram WebApp mock ----------------
const tgCalls = [];
const TG = {
  initData: 'query_id=AA&user=%7B%22id%22%3A42%7D&auth_date=1&hash=x', initDataUnsafe: { user: { id: 42, language_code: 'es' }, start_param: 'ref_7' },
  platform: 'android', themeParams: {},
  isVersionAtLeast: (v)=> parseFloat(v) <= 8.0,
  ready(){ tgCalls.push('ready'); }, expand(){ tgCalls.push('expand'); }, close(){ tgCalls.push('close'); },
  setHeaderColor(){}, setBackgroundColor(){}, setBottomBarColor(){}, disableVerticalSwipes(){ tgCalls.push('noswipe'); },
  onEvent(){}, enableClosingConfirmation(){ tgCalls.push('closeConfirm:on'); }, disableClosingConfirmation(){ tgCalls.push('closeConfirm:off'); },
  BackButton: { show(){ tgCalls.push('back:show'); }, hide(){ tgCalls.push('back:hide'); }, onClick(){} },
  MainButton: { setParams(){ tgCalls.push('main:show'); }, onClick(){}, offClick(){}, hide(){ tgCalls.push('main:hide'); }, showProgress(){}, hideProgress(){} },
  HapticFeedback: { impactOccurred(s){ tgCalls.push('haptic:'+s); }, notificationOccurred(s){ tgCalls.push('notify:'+s); }, selectionChanged(){} },
  openInvoice(link, cb){ tgCalls.push('invoice:'+link); setTimeout(()=>cb('paid'), 5); },
  openTelegramLink(u){ tgCalls.push('tglink:'+u); }, openLink(u){ tgCalls.push('link:'+u); },
  showAlert(m, cb){ tgCalls.push('alert'); cb && cb(); }, showConfirm(m, cb){ tgCalls.push('confirm'); cb(true); },
};

// ---------------- red simulada (/v2) ----------------
const net = []; let level = 0; let orderPolls = 0;
const API = 'https://alpha-bunker-backend-production.up.railway.app';
function json(status, obj){ return Promise.resolve({ ok: status<400, status, json: ()=>Promise.resolve(obj) }); }
function fetchMock(url, init){
  init = init || {}; const p = url.replace(API,''); net.push((init.method||'GET')+' '+p+(init.body?' '+init.body:''));
  if (p==='/v2/auth/telegram') return json(200, { access_token:'AT', access_expires_at: Math.floor(Date.now()/1000)+3600 });
  if (p==='/v2/auth/login') return json(200, { access_token:'AT2', access_expires_at: Math.floor(Date.now()/1000)+3600, refresh_token:'RT' });
  if (p==='/v2/auth/me') return json(200, { id: 42, display_name: 'Tester', role: 'fan', access_level: level, kyc_status:'unverified', referral_code:'ref_abc', age_confirmed: true });
  if (p==='/v2/wallet/me') return json(200, { alpha_balance: 150 });
  if (p.startsWith('/v2/posts/feed')) return json(200, { posts: [
    { id: 1, creator_id: 9, author: '"><img src=x onerror=alert(1)>', content: '<script>alert(2)</script>', media_url: "https://cdn.x/a.jpg'),alert(3)//", likes_count: 2 },
    { id: 2, creator_id: 9, author: 'c', is_locked: true, price_alpha: 30, media_url: 'https://cdn.x/SECRET.jpg', preview_url: 'https://cdn.x/blur.jpg' },
  ]});
  if (p==='/v2/auth/ws-ticket') return json(200, { ticket: 'tk' });
  if (p==='/v2/payments/stars/invoice') return json(200, { invoice_link: 'https://t.me/$inv', order_id: 'o1' });
  if (p==='/v2/payments/orders/o1') { orderPolls++; level = 2; return json(200, { status: 'paid' }); }
  if (p==='/v2/wallet/tip') return json(402, { detail: 'Saldo insuficiente' });
  return json(404, { detail: 'not mocked' });
}

// ---------------- WebSocket mock ----------------
const sockets = [];
class WS { constructor(u){ this.url=u; this.readyState=0; this.sent=[]; sockets.push(this); setTimeout(()=>{ this.readyState=1; this.onopen && this.onopen(); }, 1); }
  send(d){ this.sent.push(JSON.parse(d)); } close(){ this.readyState=3; } }
WS.OPEN = 1; WS.CONNECTING = 0;

// ---------------- contexto global ----------------
const store = {}; const ls = { getItem:k=>k in store?store[k]:null, setItem:(k,v)=>{store[k]=String(v);}, removeItem:k=>{delete store[k];}, clear:()=>{for(const k in store)delete store[k];} };
const historyStack = [null]; let popHandlers = [];
const win = {
  document, localStorage: ls, sessionStorage: { getItem:()=>null, setItem(){}, clear(){} },
  Telegram: { WebApp: TG }, fetch: fetchMock, WebSocket: WS, MutationObserver: class { observe(){} },
  navigator: { mediaDevices: null, clipboard: { writeText: ()=>Promise.resolve() } },
  location: { search: '', reload(){ results.push('INFO reload'); } },
  history: { pushState(s){ historyStack.push(s); }, back(){ historyStack.pop(); const s = historyStack[historyStack.length-1]; setTimeout(()=>popHandlers.forEach(f=>f({state:s})),0); } },
  addEventListener: (e,f)=>{ if(e==='popstate') popHandlers.push(f); },
  getComputedStyle: ()=>({ zIndex: '0' }), scrollTo(){}, requestAnimationFrame: (f)=>setTimeout(f,16), cancelAnimationFrame(){}, crypto: require('crypto').webcrypto,
  setTimeout, clearTimeout, setInterval: ()=>0, clearInterval(){}, console, Promise, URL, URLSearchParams, Blob, atob,
  Option: class { constructor(t,v){ this.text=t; this.value=v; } }, MediaStream: class {},
};
win.window = win; win.self = win; win.globalThis = win;
const ctx = vm.createContext(win);

// ---------------- 1) orden de scripts en index.html ----------------
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const srcs = [...html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"[^>]*>/g)].map((m) => ({ src: m[1].split('?')[0], tag: m[0] }));
const EXPECTED = ['js/config.js', 'telegram-web-app.js', 'tonconnect-ui.min.js', 'js/translations.js', 'js/translations_patch.js',
  'js/hybrid_bridge.js', 'js/media_manager.js', 'js/api_v2.js', 'js/chat_v2.js', 'js/ui_bridge.js', 'js/webrtc_room.js', 'js/app.js', 'js/app_secure.js'];
const seq = srcs.filter((s) => EXPECTED.some((e) => s.src.endsWith(e)));
ok(seq.map((s) => EXPECTED.find((e) => s.src.endsWith(e))).join(',') === EXPECTED.join(','), 'index.html: orden de scripts v2 exacto (1→11)');
ok(!seq.some((s) => /\b(defer|async)\b/.test(s.tag)), 'index.html: scripts v2 sin defer/async');
ok(!srcs.some((s) => /js\/(api|chat|security)\.js$/.test(s.src)), 'index.html: sin <script> de api.js / chat.js / security.js legacy');
ok(/viewport-fit=cover/.test(html), 'index.html: viewport-fit=cover');
const csp = (html.match(/Content-Security-Policy" content="([^"]+)"/) || [])[1] || '';
ok(/connect-src[^;]*https:\/\/alpha-bunker-backend-production\.up\.railway\.app/.test(csp) && /connect-src[^;]*wss:\/\/alpha-bunker-backend-production\.up\.railway\.app/.test(csp), 'CSP: Railway HTTPS + WSS en connect-src');
ok(/connect-src[^;]*tonapi\.io/.test(csp) && /script-src[^;]*unpkg\.com/.test(csp) && /script-src[^;]*telegram\.org/.test(csp), 'CSP: TON Connect y Telegram permitidos');
['login-email', 'login-password', 'reg-name-input', 'reg-email-input', 'reg-password-input', 'admin-price', 'feed-container', 'floating-video-bunker'].forEach((id) =>
  ok(html.includes('id="' + id + '"'), 'index.html contiene #' + id));

// ---------------- 2) carga de módulos en el orden de index.html ----------------
const order = seq.filter((s) => s.src.startsWith('js/')).map((s) => s.src.replace(/^js\//, '').replace(/\.js$/, ''));
for (const f of order) {
  let src = fs.readFileSync(path.join(ROOT,'js',f+'.js'),'utf8');
  if (f==='translations') src = src.replace('const translations', 'var translations');
  if (f==='app') src = src.replace('const app = {', 'var app = {');
  try { vm.runInContext(src, ctx, { filename: f+'.js' }); ok(true, 'carga '+f+'.js'); }
  catch(e){ ok(false, 'carga '+f+'.js → '+e.message); }
}

(async () => {
  const W = win, app = W.app;
  // 1. arranque
  listeners['doc:DOMContentLoaded'].forEach(f=>f());
  await new Promise(r=>setTimeout(r, 1500));
  ok(app.userId === '42', 'identidad tomada del servidor (userId=42) — sin IDs 99xxxxxx');
  ok(!byId.get('view-feed').classList.contains('hidden'), 'enruta al feed tras AppBridge.init');
  ok(net.some(l=>l.startsWith('POST /v2/auth/telegram')), 'TMA se autentica con initData firmado');
  ok(app.userId === '42' && W.AppBridge.isTelegram(), 'entorno detectado como Telegram Mini App');
  ok(!net.some(l=>/"user_id"|"sender_id"|"follower_id"/.test(l)), 'ningún request lleva user_id/sender_id del cliente');
  ok(tgCalls.includes('ready') && tgCalls.includes('noswipe'), 'Telegram ready/expand/disableVerticalSwipes aplicados');
  ok(!app.isAdminUser(), 'no hay admin por ID fijo en cliente');
  ok(app.getTrans('toast_invoice_gen').includes('Stars'), 'clave i18n antes ausente ahora resuelve');
  ok(app.getTrans('clave_inexistente') === '', 'getTrans devuelve "" (no la clave) si falta → fallbacks funcionan');

  // 2. render del feed: XSS y contenido bloqueado
  const html = byId.get('feed-container').innerHTML;
  ok(!/<img src=x onerror/.test(html) && !/<script>/.test(html), 'autor/contenido maliciosos escapados');
  ok(!/onclick=/.test(html), 'feed sin onclick interpolados (usa data-act)');
  ok(!html.includes('SECRET.jpg') && html.includes('blur.jpg'), 'post bloqueado usa preview_url, nunca media_url');
  ok(!html.includes("a.jpg'),alert(3)"), 'URL con comilla no rompe atributos (escapada)');

  // 3. bloqueo de endpoints legacy
  let blocked = false; try { await W.fetch(API+'/wallet/transfer', {method:'POST'}); } catch(e){ blocked = e.status === 410; }
  ok(blocked, 'fetch a endpoint legacy /wallet/transfer bloqueado (410)');

  // 4. chat: payload legacy en string con señalización NO va al socket de texto
  app.currentRoomId = 'slam';
  W.BunkerChat.initGlobal(null, null, 'slam');
  await new Promise(r=>setTimeout(r, 20));
  W.BunkerChat.sendGlobal(JSON.stringify({ type: 'webrtc_offer', target_id: 5, sdp: 'x', room_id: 'otra' }));
  W.BunkerChat.sendGlobal(JSON.stringify({ text: 'hola', media_url: null }));
  await new Promise(r=>setTimeout(r, 20));
  const textSock = sockets.find(s=>s.url.includes('/rooms/slam/text'));
  const sigSock = sockets.find(s=>s.url.includes('/video/rooms/slam/signal'));
  ok(textSock && textSock.url.startsWith('wss://alpha-bunker-backend-production.up.railway.app/v2/chat/rooms/slam/text?ticket='), 'WebSocket usa wsBaseUrl de config.js + ticket de un solo uso');
  ok(textSock && textSock.sent.some(m=>m.type==='chat' && m.text==='hola'), 'texto llega al socket de sala como chat');
  ok(textSock && !textSock.sent.some(m=>String(m.text||'').includes('webrtc_offer')), 'oferta WebRTC ya no se publica como mensaje de chat');
  ok(sigSock && sigSock.sent.some(m=>m.type==='webrtc_offer' && !('room_id' in m)), 'oferta enrutada al socket de señalización sin room_id del cliente');
  ok(W.BunkerChat.globalSocket && W.BunkerChat.globalSocket.readyState === 1, 'getter de compatibilidad globalSocket operativo');

  // 5. Stars: nivel solo cambia si el BACKEND confirma la orden
  await app.buyPackageStars('veteran');
  ok(tgCalls.some(c=>c.startsWith('invoice:')), 'Telegram.WebApp.openInvoice usado');
  ok(orderPolls > 0 && app.userData.access_tier === 2, 'rango actualizado tras confirmación del servidor (pollOrder)');
  ok(tgCalls.includes('closeConfirm:on') && tgCalls.includes('closeConfirm:off'), 'enableClosingConfirmation durante el pago');

  // 6. propina con saldo insuficiente → manejo de 402
  const tipOk = await app.sendTipFromPost('9', 50, 1);
  ok(tipOk === false && net.some(l=>l.startsWith('POST /v2/wallet/tip')), 'propina vía /v2/wallet/tip y 402 gestionado');

  // 7. login standalone desde los campos de index.html (usa /v2/auth/login, nunca user_id)
  const le = new El('input'); le.id = 'login-email'; le.value = 'a@b.co';
  const lp = new El('input'); lp.id = 'login-password'; lp.value = 'secreto123';
  await app.loginWithEmail();
  ok(net.some(l => l.startsWith('POST /v2/auth/login') && l.includes('a@b.co')), 'login lee #login-email/#login-password y llama /v2/auth/login');
  ok(lp.value === '', 'contraseña se limpia del campo tras el login');
  const sb = new El('h3'); sb.id = 'sidebar-name'; app.updateProfileUI();
  ok(sb.textContent === 'Tester', 'cabecera del menú lateral muestra el alias del servidor');

  // 8. navegación: history.go(-n) desapila todo
  const nav = W.AppBridge.navigation; let closed = 0;
  nav.push('a', ()=>closed++); nav.push('b', ()=>closed++);
  popHandlers.forEach(f=>f({ state: null }));
  ok(nav.depth() === 0 && closed === 2, 'popstate a profundidad 0 desapila 2 niveles (fix go(-n))');

  const fails = results.filter(r => r.startsWith('FAIL')).length;
  console.log(results.join('\n'));
  console.log('\nResultado: ' + results.filter(r => r.startsWith('PASS')).length + ' PASS, ' + fails + ' FAIL');
  console.log('\nTelegram calls:', [...new Set(tgCalls)].join(', '));
})().catch(e=>{ console.error('ERROR', e); process.exitCode = 1; });