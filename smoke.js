/**
 * smoke.js — Pruebas automatizadas de humo (Node ≥ 18, sin dependencias).
 *   node smoke.js            (desde la raíz del proyecto)   ·   npm test
 *
 * 0) Estático: orden exacto de scripts en index.html, CSP, ids requeridos y que todas
 *    las claves data-i18n del HTML existan en los 6 idiomas.
 * A) Telegram Mini App: initData firmado, pagos Stars, seguridad, chat y navegación.
 * B) APK Capacitor SIN objeto Telegram: arranque, idioma en caliente, login/registro por
 *    email con timeouts y errores, login con Telegram vía bot (deep link, cancelar,
 *    degradación), enlaces nativos y botón atrás.
 * C) APK sin red con sesión guardada: pantalla offline con reintento (sin bucle de recarga).
 * D) WebSocket caído: tope de 10 reintentos, pausa y reanudación con el evento 'online'.
 * Cada escenario corre en un contexto vm aislado con su propio DOM simulado.
 */
'use strict';
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const ROOT = process.argv[2] ? path.resolve(process.argv[2]) : __dirname;
const API = 'https://alpha-bunker-backend.onrender.com';
const LANGS = ['es', 'en', 'it', 'pt', 'de', 'fr'];
const results = [];
function ok(cond, msg) { results.push((cond ? 'PASS ' : 'FAIL ') + msg); if (!cond) process.exitCode = 1; }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

// ====================================================================== 0) comprobaciones estáticas
const srcs = [...html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"[^>]*>/g)].map((m) => ({ src: m[1].split('?')[0], tag: m[0] }));
const EXPECTED = ['js/config.js', 'telegram-web-app.js', 'tonconnect-ui.min.js', 'js/translations.js', 'js/translations_patch.js',
  'js/hybrid_bridge.js', 'js/media_manager.js', 'js/api_v2.js', 'js/chat_v2.js', 'js/ui_bridge.js', 'js/webrtc_room.js', 'js/app.js', 'js/app_secure.js'];
const seq = srcs.filter((s) => EXPECTED.some((e) => s.src.endsWith(e)));
ok(seq.map((s) => EXPECTED.find((e) => s.src.endsWith(e))).join(',') === EXPECTED.join(','), 'index.html: orden de scripts v2 exacto (1→11)');
ok(!seq.some((s) => /\b(defer|async)\b/.test(s.tag)), 'index.html: scripts v2 sin defer/async');
ok(!srcs.some((s) => /js\/(api|chat|security)\.js$/.test(s.src)), 'index.html: sin <script> de api.js / chat.js / security.js legacy');
ok(/viewport-fit=cover/.test(html), 'index.html: viewport-fit=cover');
const csp = (html.match(/Content-Security-Policy" content="([^"]+)"/) || [])[1] || '';
ok(!/railway/i.test(html) && /connect-src[^;]*https:\/\/alpha-bunker-backend\.onrender\.com/.test(csp) && /connect-src[^;]*wss:\/\/alpha-bunker-backend\.onrender\.com/.test(csp), 'CSP: Render HTTPS + WSS en connect-src');
ok(/connect-src[^;]*tonapi\.io/.test(csp) && /script-src[^;]*unpkg\.com/.test(csp) && /script-src[^;]*telegram\.org/.test(csp), 'CSP: TON Connect y Telegram permitidos');
['login-email', 'login-password', 'reg-name-input', 'reg-email-input', 'reg-password-input', 'btn-login-telegram', 'admin-price', 'feed-container', 'floating-video-bunker']
  .forEach((id) => ok(html.includes('id="' + id + '"'), 'index.html contiene #' + id));
const i18nKeys = [...new Set([...html.matchAll(/data-i18n(?:-placeholder|-aria|-title)?="([^"]+)"/g)].map((m) => m[1]))];
ok(i18nKeys.length >= 50, 'index.html: ' + i18nKeys.length + ' claves data-i18n (antes: 0)');
const cfgSrc = fs.readFileSync(path.join(ROOT, 'js', 'config.js'), 'utf8');
ok(/apiBaseUrl:\s*'https:\/\/alpha-bunker-backend\.onrender\.com'/.test(cfgSrc) && /wsBaseUrl:\s*'wss:\/\/alpha-bunker-backend\.onrender\.com'/.test(cfgSrc) && /tonManifestUrl:\s*'https:\/\/alpha-bunker-backend\.onrender\.com\//.test(cfgSrc), 'config.js: apiBaseUrl / wsBaseUrl / tonManifestUrl apuntan a Render');
['js/api.js', 'js/chat.js', 'js/security.js', '_redirects'].forEach((f) => ok(!fs.existsSync(path.join(ROOT, f)), 'proyecto sin archivo legacy ' + f));
ok(fs.existsSync(path.join(ROOT, 'vercel.json')), 'vercel.json presente (sustituye a _redirects, que Vercel ignora)');
const capCfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'capacitor.config.json'), 'utf8'));
ok(!(capCfg.server && capCfg.server.allowNavigation || []).some((h) => /t\.me|telegram/.test(h)), 'capacitor.config.json: t.me/telegram fuera de allowNavigation (no se abren dentro de la WebView)');

// ====================================================================== entorno simulado
function createEnv(opts) {
  const o = Object.assign({ telegram: 'tma', capacitor: false, timeoutMs: null, fetch: null, prefs: {}, wsFail: false, fastTimers: false, three: false }, opts || {});
  const env = { byId: new Map(), all: [], docListeners: {}, winListeners: {}, net: [], tgCalls: [], sockets: [], native: [], reloads: 0, capListeners: {}, prefs: Object.assign({}, o.prefs), gl: { renderers: 0, disposed: 0, contextLost: 0, frames: 0 } };

  class ClassList {
    constructor() { this.s = new Set(); }
    add(...c) { c.forEach((x) => this.s.add(x)); } remove(...c) { c.forEach((x) => this.s.delete(x)); }
    contains(c) { return this.s.has(c); }
    toggle(c, f) { const on = f === undefined ? !this.s.has(c) : f; if (on) this.s.add(c); else this.s.delete(c); return on; }
    replace(a, b) { if (this.s.has(a)) { this.s.delete(a); this.s.add(b); } }
  }
  class El {
    constructor(tag) {
      this.tagName = String(tag).toUpperCase(); this.classList = new ClassList(); this.children = []; this.style = {};
      this.dataset = {}; this.attrs = {}; this._html = ''; this.textContent = ''; this.parentElement = null; this.value = '';
      this.placeholder = ''; this.disabled = false; this.listeners = {}; this.nodeType = 1;
      env.all.push(this);
    }
    set id(v) { this._id = v; env.byId.set(v, this); } get id() { return this._id || ''; }
    set className(v) { this.classList = new ClassList(); String(v).split(/\s+/).filter(Boolean).forEach((c) => this.classList.add(c)); }
    get className() { return [...this.classList.s].join(' '); }
    set innerHTML(v) { this._html = String(v); this.children = []; } get innerHTML() { return this._html; }
    insertAdjacentHTML(_p, h) {
      this._html += h;
      const re = /id="([^"]+)"/g; let r;
      while ((r = re.exec(h))) {
        if (!env.byId.has(r[1])) { const e = new El('div'); e.id = r[1]; if (/class="[^"]*\bhidden\b/.test(h.slice(Math.max(0, r.index - 200), r.index + 200))) e.classList.add('hidden'); }
      }
    }
    appendChild(c) { this.children.push(c); c.parentElement = this; return c; }
    remove() {
      if (this.parentElement) this.parentElement.children = this.parentElement.children.filter((x) => x !== this);
      if (this._id && env.byId.get(this._id) === this) env.byId.delete(this._id);
      this.parentElement = null;
    }
    setAttribute(k, v) {
      this.attrs[k] = String(v);
      if (k === 'id') this.id = v;
      if (k === 'class') this.className = v;
      if (k.startsWith('data-')) this.dataset[k.slice(5).replace(/-(\w)/g, (_, c) => c.toUpperCase())] = String(v);
    }
    getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
    removeAttribute(k) { delete this.attrs[k]; }
    addEventListener(e, f) { (this.listeners[e] = this.listeners[e] || []).push(f); }
    querySelector() { return new El('div'); }
    querySelectorAll(sel) { return queryAll(sel, this); }
    closest() { return null; } matches() { return false; }
    focus() { this.focused = true; } click() { this.clicked = true; } play() { return Promise.resolve(); } select() {}
    get childElementCount() { return this.children.length; } get nextElementSibling() { return null; }
  }
  function attached(el, root) { let n = el; while (n) { if (n === root) return true; n = n.parentElement; } return false; }
  function queryAll(sel, root) {
    const m = /^\[([\w-]+)\]$/.exec(sel);
    if (m) return env.all.filter((e) => e.getAttribute(m[1]) !== null && (!root || root === body || attached(e, root)));
    if (sel.startsWith('[id^="view-"]')) return [...env.byId.values()].filter((e) => e.id.startsWith('view-'));
    return [];
  }

  const body = new El('body');
  body.contains = () => true;
  const document = {
    body, readyState: 'complete', visibilityState: 'visible', documentElement: { lang: 'es' },
    createElement: (t) => new El(t), createTextNode: (t) => ({ nodeType: 3, textContent: t }),
    getElementById: (id) => env.byId.get(id) || null,
    querySelectorAll: (sel) => queryAll(sel, body),
    querySelector: () => null,
    addEventListener: (e, f) => { (env.docListeners[e] = env.docListeners[e] || []).push(f); },
    dispatchEvent: (ev) => { (env.docListeners[ev.type] || []).forEach((f) => f(ev)); return true; },
    execCommand: () => true,
  };

  // DOM real a partir de index.html: todas las etiquetas con id, con sus atributos y clases.
  for (const m of html.matchAll(/<(\w+)\b([^>]*?)\bid="([^"]+)"([^>]*)>/g)) {
    const el = new El(m[1]);
    const attrs = (m[2] + ' id="' + m[3] + '" ' + m[4]);
    for (const a of attrs.matchAll(/([\w:-]+)="([^"]*)"/g)) el.setAttribute(a[1], a[2]);
    body.appendChild(el);
  }

  // ---------------- Telegram
  const TG = {
    initData: o.telegram === 'tma' ? 'query_id=AA&user=%7B%22id%22%3A42%7D&auth_date=1&hash=x' : '',
    initDataUnsafe: o.telegram === 'tma' ? { user: { id: 42, language_code: 'es' }, start_param: 'ref_7' } : {},
    platform: o.telegram === 'tma' ? 'android' : 'unknown', themeParams: {},
    isVersionAtLeast: (v) => parseFloat(v) <= 8.0,
    ready() { env.tgCalls.push('ready'); }, expand() { env.tgCalls.push('expand'); }, close() { env.tgCalls.push('close'); },
    setHeaderColor() {}, setBackgroundColor() {}, setBottomBarColor() {}, disableVerticalSwipes() { env.tgCalls.push('noswipe'); },
    onEvent() {}, enableClosingConfirmation() { env.tgCalls.push('closeConfirm:on'); }, disableClosingConfirmation() { env.tgCalls.push('closeConfirm:off'); },
    BackButton: { show() { env.tgCalls.push('back:show'); }, hide() { env.tgCalls.push('back:hide'); }, onClick() {} },
    MainButton: { setParams() { env.tgCalls.push('main:show'); }, onClick() {}, offClick() {}, hide() { env.tgCalls.push('main:hide'); }, showProgress() {}, hideProgress() {} },
    HapticFeedback: { impactOccurred(s) { env.tgCalls.push('haptic:' + s); }, notificationOccurred(s) { env.tgCalls.push('notify:' + s); }, selectionChanged() {} },
    openInvoice(link, cb) { env.tgCalls.push('invoice:' + link); setTimeout(() => cb('paid'), 5); },
    openTelegramLink(u) { env.tgCalls.push('tglink:' + u); }, openLink(u) { env.tgCalls.push('link:' + u); },
    showAlert(m, cb) { env.tgCalls.push('alert'); if (cb) cb(); }, showConfirm(m, cb) { env.tgCalls.push('confirm'); cb(true); },
  };

  // ---------------- Capacitor
  const Capacitor = o.capacitor ? {
    isNativePlatform: () => true,
    getPlatform: () => 'android',
    Plugins: {
      Preferences: {
        get: async ({ key }) => ({ value: key in env.prefs ? env.prefs[key] : null }),
        set: async ({ key, value }) => { env.prefs[key] = value; },
        remove: async ({ key }) => { delete env.prefs[key]; },
      },
      App: {
        addListener: (evt, fn) => { env.capListeners[evt] = fn; return Promise.resolve({ remove() {} }); },
        minimizeApp: async () => { env.native.push('minimizeApp'); },
        exitApp: () => { env.native.push('exitApp'); },
        getLaunchUrl: async () => ({ url: null }),
      },
      Browser: { open: async ({ url }) => { env.native.push('Browser.open:' + url); } },
      AppLauncher: { openUrl: async ({ url }) => { env.native.push('AppLauncher.openUrl:' + url); return { completed: true }; } },
    },
  } : undefined;

  // ---------------- red
  const json = (status, obj) => Promise.resolve({ ok: status < 400, status, json: () => Promise.resolve(obj) });
  function record(url, init) { const p = url.replace(API, ''); env.net.push((init.method || 'GET') + ' ' + p + (init.body ? ' ' + init.body : '')); return p; }
  env.json = json;
  env.hang = (init) => new Promise((_, rej) => { if (init.signal) init.signal.addEventListener('abort', () => rej(new Error('aborted'))); });
  function fetchImpl(url, init) {
    init = init || {};
    const p = record(url, init);
    if (o.fetch) { const r = o.fetch(p, init, env); if (r) return r; }
    return json(404, { detail: 'not mocked' });
  }

  // ---------------- WebSocket
  class WS {
    constructor(u) {
      this.url = u; this.readyState = 0; this.sent = []; env.sockets.push(this);
      if (o.wsFail) setTimeout(() => { this.readyState = 3; if (this.onclose) this.onclose({ code: 1006, reason: '' }); }, 1);
      else setTimeout(() => { this.readyState = 1; if (this.onopen) this.onopen(); }, 1);
    }
    send(d) { this.sent.push(JSON.parse(d)); } close() { this.readyState = 3; }
  }
  WS.OPEN = 1; WS.CONNECTING = 0;

  // ---------------- window
  const store = {};
  const ls = { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; }, clear: () => { for (const k in store) delete store[k]; } };
  Object.defineProperty(ls, 'keys', { value: () => Object.keys(store) });
  const historyStack = [null];
  const win = {
    document, localStorage: ls, sessionStorage: { getItem: () => null, setItem() {}, clear() {} },
    fetch: fetchImpl, WebSocket: WS, MutationObserver: class { observe() {} },
    navigator: { mediaDevices: null, clipboard: { writeText: () => Promise.resolve() }, vibrate: (p) => { env.native.push('vibrate'); return true; } },
    location: { search: '', href: 'https://localhost/', reload() { env.reloads++; } },
    history: {
      pushState(s) { historyStack.push(s); },
      back() { historyStack.pop(); const s = historyStack[historyStack.length - 1]; setTimeout(() => (env.winListeners.popstate || []).forEach((f) => f({ state: s })), 0); },
    },
    open: (u) => { env.native.push('window.open:' + u); return {}; },
    close: () => { env.native.push('window.close'); },
    addEventListener: (e, f) => { (env.winListeners[e] = env.winListeners[e] || []).push(f); },
    getComputedStyle: () => ({ zIndex: '0' }), scrollTo() {}, requestAnimationFrame: (f) => setTimeout(f, 16), cancelAnimationFrame() {},
    crypto: require('crypto').webcrypto, AbortController, CustomEvent: class { constructor(t, i) { this.type = t; this.detail = i && i.detail; } },
    setTimeout, clearTimeout, setInterval: () => 0, clearInterval() {}, console, Promise, URL, URLSearchParams, Blob, atob,
    Option: class { constructor(t, v) { this.text = t; this.value = v; } }, MediaStream: class {},
  };
  if (o.fastTimers) win.setTimeout = (f, ms) => setTimeout(f, Math.min(ms || 0, 5));
  if (o.three) {
    const disposable = () => ({ dispose() { env.gl.disposed++; } });
    win.THREE = {
      WebGLRenderer: class { constructor() { env.gl.renderers++; } setSize() {} setPixelRatio() {} render() { env.gl.frames++; } dispose() { env.gl.disposed++; } forceContextLoss() { env.gl.contextLost++; } },
      Scene: class { add() {} }, PerspectiveCamera: class { constructor() { this.position = {}; } },
      IcosahedronGeometry: function () { return disposable(); }, MeshBasicMaterial: function () { return disposable(); },
      BufferGeometry: function () { return Object.assign(disposable(), { setAttribute() {} }); }, BufferAttribute: class {},
      PointsMaterial: function () { return disposable(); },
      Mesh: class { constructor() { this.rotation = { x: 0, y: 0 }; } }, Points: class { constructor() { this.rotation = { y: 0 }; } },
    };
  }
  if (o.telegram !== 'absent') win.Telegram = { WebApp: TG };
  if (Capacitor) win.Capacitor = Capacitor;
  win.window = win; win.self = win; win.globalThis = win;
  env.win = win;
  env.ctx = vm.createContext(win);
  env.ls = store;

  env.load = function (label) {
    const order = seq.filter((s) => s.src.startsWith('js/')).map((s) => s.src.replace(/^js\//, '').replace(/\.js$/, ''));
    let loaded = 0;
    for (const f of order) {
      let src = fs.readFileSync(path.join(ROOT, 'js', f + '.js'), 'utf8');
      if (f === 'translations') src = src.replace('const translations', 'var translations');
      if (f === 'app') src = src.replace('const app = {', 'var app = {');
      if (f === 'config' && o.timeoutMs) src = src.replace(/timeoutMs:\s*\d+/, 'timeoutMs: ' + o.timeoutMs);
      try { vm.runInContext(src, env.ctx, { filename: f + '.js' }); loaded++; }
      catch (e) { ok(false, label + ': carga ' + f + '.js → ' + e.message); }
    }
    ok(loaded === order.length, label + ': ' + loaded + '/' + order.length + ' módulos cargados en el orden de index.html');
  };
  env.boot = async function () {
    (env.docListeners.DOMContentLoaded || []).forEach((f) => f());
    await sleep(1500);
  };
  env.visible = (id) => { const e = env.byId.get(id); return !!e && !e.classList.contains('hidden'); };
  env.toastText = () => { const t = env.byId.get('alpha-dynamic-toast'); return t && t.children[1] ? t.children[1].textContent : null; };
  return env;
}

// ====================================================================== A) Telegram Mini App
async function scenarioTMA() {
  const L = 'TMA';
  let level = 0, orderPolls = 0;
  const env = createEnv({
    telegram: 'tma', three: true,
    fetch: (p, init, e) => {
      if (p === '/v2/auth/telegram') return e.json(200, { access_token: 'AT', access_expires_at: Math.floor(Date.now() / 1000) + 3600 });
      if (p === '/v2/auth/login') return e.json(200, { access_token: 'AT2', access_expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token: 'RT' });
      if (p === '/v2/auth/me') return e.json(200, { id: 42, display_name: 'Tester', role: 'fan', access_level: level, kyc_status: 'unverified', referral_code: 'ref_abc', age_confirmed: true });
      if (p === '/v2/wallet/me') return e.json(200, { alpha_balance: 150 });
      if (p.startsWith('/v2/posts/feed')) return e.json(200, { posts: [
        { id: 1, creator_id: 9, author: '"><img src=x onerror=alert(1)>', content: '<script>alert(2)</script>', media_url: "https://cdn.x/a.jpg'),alert(3)//", likes_count: 2 },
        { id: 2, creator_id: 9, author: 'c', is_locked: true, price_alpha: 30, media_url: 'https://cdn.x/SECRET.jpg', preview_url: 'https://cdn.x/blur.jpg' },
      ] });
      if (p === '/v2/auth/ws-ticket') return e.json(200, { ticket: 'tk' });
      if (p === '/v2/payments/stars/invoice') return e.json(200, { invoice_link: 'https://t.me/$inv', order_id: 'o1' });
      if (p === '/v2/payments/orders/o1') { orderPolls++; level = 2; return e.json(200, { status: 'paid' }); }
      if (p === '/v2/wallet/tip') return e.json(402, { detail: 'Saldo insuficiente' });
      return null;
    },
  });
  env.load(L);
  const W = env.win, app = W.app;
  await env.boot();

  ok(env.gl.renderers === 1 && env.gl.frames > 0, L + ': splash 3D crea un único WebGLRenderer y anima');
  await sleep(500);
  ok(env.gl.contextLost === 1 && env.gl.disposed >= 5, L + ': al ocultar el splash se liberan geometrías, materiales y el contexto WebGL');
  const framesAfter = env.gl.frames; await sleep(120);
  ok(env.gl.frames === framesAfter, L + ': sin bucle requestAnimationFrame tras ocultar el splash');
  ok(app.userId === '42', L + ': identidad tomada del servidor (userId=42) — sin IDs 99xxxxxx');
  ok(env.visible('view-feed'), L + ': enruta al feed tras AppBridge.init');
  ok(env.net.some((l) => l.startsWith('POST /v2/auth/telegram')), L + ': se autentica con initData firmado');
  ok(W.AppBridge.isTMA() && W.AppBridge.platform() === 'telegram:android', L + ': entorno detectado como Telegram Mini App');
  ok(!env.net.some((l) => /"user_id"|"sender_id"|"follower_id"/.test(l)), L + ': ningún request lleva user_id/sender_id del cliente');
  ok(env.tgCalls.includes('ready') && env.tgCalls.includes('noswipe'), L + ': ready/expand/disableVerticalSwipes aplicados');
  ok(!app.isAdminUser(), L + ': no hay admin por ID fijo en cliente');
  ok(app.getTrans('toast_invoice_gen').includes('Stars'), L + ': clave i18n antes ausente ahora resuelve');
  ok(app.getTrans('clave_inexistente') === '', L + ': getTrans devuelve "" (no la clave) si falta → fallbacks funcionan');

  const feedHtml = env.byId.get('feed-container').innerHTML;
  ok(!/<img src=x onerror/.test(feedHtml) && !/<script>/.test(feedHtml), L + ': autor/contenido maliciosos escapados');
  ok(!/onclick=/.test(feedHtml), L + ': feed sin onclick interpolados (usa data-act)');
  ok(!feedHtml.includes('SECRET.jpg') && feedHtml.includes('blur.jpg'), L + ': post bloqueado usa preview_url, nunca media_url');
  ok(!feedHtml.includes("a.jpg'),alert(3)"), L + ': URL con comilla no rompe atributos (escapada)');

  let blocked = false;
  try { await W.fetch(API + '/wallet/transfer', { method: 'POST' }); } catch (e) { blocked = e.status === 410; }
  ok(blocked, L + ': fetch a endpoint legacy /wallet/transfer bloqueado (410)');

  app.currentRoomId = 'slam';
  W.BunkerChat.initGlobal(null, null, 'slam');
  await sleep(20);
  W.BunkerChat.sendGlobal(JSON.stringify({ type: 'webrtc_offer', target_id: 5, sdp: 'x', room_id: 'otra' }));
  W.BunkerChat.sendGlobal(JSON.stringify({ text: 'hola', media_url: null }));
  await sleep(20);
  const textSock = env.sockets.find((s) => s.url.includes('/rooms/slam/text'));
  const sigSock = env.sockets.find((s) => s.url.includes('/video/rooms/slam/signal'));
  ok(textSock && textSock.url.startsWith('wss://alpha-bunker-backend.onrender.com/v2/chat/rooms/slam/text?ticket='), L + ': WebSocket usa wsBaseUrl de config.js + ticket de un solo uso');
  ok(textSock && textSock.sent.some((m) => m.type === 'chat' && m.text === 'hola'), L + ': texto llega al socket de sala como chat');
  ok(textSock && !textSock.sent.some((m) => String(m.text || '').includes('webrtc_offer')), L + ': oferta WebRTC no se publica como mensaje de chat');
  ok(sigSock && sigSock.sent.some((m) => m.type === 'webrtc_offer' && !('room_id' in m)), L + ': oferta enrutada al socket de señalización sin room_id del cliente');
  ok(W.BunkerChat.globalSocket && W.BunkerChat.globalSocket.readyState === 1, L + ': getter de compatibilidad globalSocket operativo');

  await app.buyPackageStars('veteran');
  ok(env.tgCalls.some((c) => c.startsWith('invoice:')), L + ': Telegram.WebApp.openInvoice usado');
  ok(orderPolls > 0 && app.userData.access_tier === 2, L + ': rango actualizado tras confirmación del servidor (pollOrder)');
  ok(env.tgCalls.includes('closeConfirm:on') && env.tgCalls.includes('closeConfirm:off'), L + ': enableClosingConfirmation durante el pago');

  const tipOk = await app.sendTipFromPost('9', 50, 1);
  ok(tipOk === false && env.net.some((l) => l.startsWith('POST /v2/wallet/tip')), L + ': propina vía /v2/wallet/tip y 402 gestionado');

  app.setLanguage('de');
  ok(env.byId.get('nav-catalog').textContent === 'KATALOG' && env.byId.get('fab-lang-text').textContent === 'DE', L + ': idioma en caliente también dentro de Telegram');
  app.setLanguage('es');

  (env.winListeners.blur || []).forEach((f) => f({}));
  await sleep(20);
  ok(!env.win.document.body.classList.contains('privacy-blur'), L + ': abrir openInvoice/TonConnect (window blur) ya no deja la pantalla negra');
  const sb = env.byId.get('sidebar-name');
  app.updateProfileUI();
  ok(sb && sb.textContent === 'Tester', L + ': cabecera del menú lateral muestra el alias del servidor');

  const nav = W.AppBridge.navigation; let closed = 0;
  nav.push('a', () => closed++); nav.push('b', () => closed++);
  (env.winListeners.popstate || []).forEach((f) => f({ state: null }));
  ok(nav.depth() === 0 && closed === 2, L + ': popstate a profundidad 0 desapila 2 niveles (fix go(-n))');
}

// ====================================================================== B) APK Capacitor sin Telegram
async function scenarioAPK() {
  const L = 'APK';
  const mode = { login: 'timeout', intent: 'ok', poll: 'pending' };
  const token = () => ({ access_token: 'AT', access_expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token: 'RT-APK' });
  const env = createEnv({
    telegram: 'absent', capacitor: true, timeoutMs: 300,
    fetch: (p, init, e) => {
      if (p === '/v2/auth/login') {
        if (mode.login === 'timeout') return e.hang(init);
        if (mode.login === '401') return e.json(401, { detail: 'invalid' });
        return e.json(200, token());
      }
      if (p === '/v2/auth/register') return e.json(201, token());
      if (p === '/v2/auth/telegram/login-intent') {
        if (mode.intent === '404') return e.json(404, { detail: 'Not Found' });
        return e.json(200, { intent_id: 'i1', poll_secret: 's1', deep_link: 'https://t.me/Alpha_store_botbot?start=login_n1' });
      }
      if (p === '/v2/auth/telegram/login-intent/poll') return mode.poll === 'ok' ? e.json(200, token()) : e.json(200, {});
      if (p === '/v2/auth/me') return e.json(200, { id: 77, display_name: 'ApkUser', role: 'fan', access_level: 0, kyc_status: 'unverified', age_confirmed: true });
      if (p === '/v2/wallet/me') return e.json(200, { alpha_balance: 0 });
      if (p.startsWith('/v2/posts/feed')) return e.json(200, { posts: [] });
      if (p === '/v2/auth/ws-ticket') return e.json(200, { ticket: 'tk' });
      return null;
    },
  });

  env.load(L);
  const W = env.win, app = W.app;
  const B = W.AppBridge;
  ok(typeof W.Telegram === 'undefined', L + ': window.Telegram no existe (peor caso: script de Telegram no cargado)');
  ok(B.isTMA() === false && B.isNative() === true && B.platform() === 'capacitor:android', L + ': isTMA()=false, isNative()=true, plataforma capacitor:android');
  ok(B.tgCall('6.1', () => { throw new Error('no debe ejecutarse'); }, 'fallback') === 'fallback', L + ': tgCall devuelve fallback fuera de Telegram (sin excepción)');
  let safe = true;
  try { B.haptic('heavy'); B.setClosingConfirmation(true); B.mainButton.show({ text: 'X', onClick() {} }); B.mainButton.hide(); B.startParam(); }
  catch (_) { safe = false; }
  ok(safe && env.native.includes('vibrate'), L + ': háptica/MainButton/ClosingConfirmation no lanzan; háptica cae a navigator.vibrate');

  await env.boot();
  ok(env.visible('view-consent') && !env.visible('view-splash'), L + ': arranque sin sesión → pantalla de advertencia +18');
  ok(env.toastText() === null, L + ': sin toast "sesión expirada" en el primer arranque');
  ok(env.tgCalls.length === 0, L + ': ninguna llamada a Telegram en el APK');

  // ---- idioma en caliente sobre la advertencia +18
  const title = env.byId.get('txt-warn-title');
  ok(title.textContent === 'ADVERTENCIA', L + ': advertencia pintada en español al arrancar');
  app.openLanguagePicker();
  ok(!!env.byId.get('modal-language'), L + ': selector de 6 idiomas abierto');
  app.setLanguage('en');
  ok(title.textContent === 'WARNING' && env.byId.get('btn-accept-text').textContent === 'I ACCEPT', L + ': cambio a inglés repinta la advertencia sin recargar');
  ok(env.ls.alpha_lang === 'en' && env.reloads === 0, L + ': preferencia guardada en localStorage y sin location.reload');
  W.setAppLanguage('fr');
  ok(title.textContent === 'AVERTISSEMENT' && env.byId.get('login-email').placeholder === 'vous@email.com' && env.byId.get('fab-lang-text').textContent === 'FR', L + ': francés → textos, placeholders y botón de idioma');
  const missing = [];
  i18nKeys.forEach((k) => LANGS.forEach((l) => { if (!W.tr(k, l)) missing.push(l + ':' + k); }));
  ok(missing.length === 0, L + ': todas las claves data-i18n de index.html resuelven en los 6 idiomas' + (missing.length ? ' (faltan ' + missing.slice(0, 5).join(', ') + ')' : ''));
  W.setAppLanguage('es');

  app.acceptConsent();
  ok(env.visible('view-login'), L + ': aceptar advertencia → pantalla de login (sin esperar a Telegram)');

  // ---- login email: servidor colgado → timeout, botón liberado
  const btnLogin = env.byId.get('btn-phone-text');
  env.byId.get('login-email').value = 'user@mail.com';
  env.byId.get('login-password').value = 'clave-segura-1';
  const t0 = Date.now();
  await app.loginWithEmail();
  ok(Date.now() - t0 < 2000 && !btnLogin.disabled && btnLogin.getAttribute('data-busy') === null, L + ': login con servidor colgado termina por timeout y libera el botón');
  ok(env.toastText() === W.tr('toast_server_slow'), L + ': mensaje "servidor tardó demasiado" (no congelamiento)');

  mode.login = '401';
  await app.loginWithEmail();
  ok(env.toastText() === W.tr('toast_invalid_credentials'), L + ': 401 en login → "email o contraseña incorrectos"');

  env.byId.get('login-email').value = 'no-es-email';
  const before = env.net.length;
  await app.loginWithEmail();
  ok(env.net.length === before && env.toastText() === W.tr('toast_invalid_email'), L + ': email inválido se valida en cliente sin llamar al servidor');

  // ---- registro: validación
  env.byId.get('reg-name-input').value = 'Nuevo';
  env.byId.get('reg-email-input').value = 'nuevo@mail.com';
  env.byId.get('reg-password-input').value = 'corta';
  await app.registerWithData();
  ok(!env.net.some((l) => l.startsWith('POST /v2/auth/register')) && env.toastText() === W.tr('toast_pwd_min8'), L + ': contraseña < 8 bloqueada en cliente');

  // ---- login con Telegram (APK): cancelar
  mode.poll = 'pending';
  const btnTg = env.byId.get('btn-login-telegram');
  const pCancel = app.loginWithTelegram();
  await sleep(80);
  ok(env.native.includes('AppLauncher.openUrl:https://t.me/Alpha_store_botbot?start=login_n1'), L + ': deep link del bot abierto con AppLauncher (app nativa de Telegram), no dentro de la WebView');
  const wait = env.byId.get('modal-ab-wait');
  ok(!!wait, L + ': diálogo "esperando a Telegram" visible con Cancelar');
  const tc = Date.now();
  wait._abClose();
  await pCancel;
  ok(Date.now() - tc < 1000 && !btnTg.disabled && !env.byId.get('modal-ab-wait'), L + ': Cancelar aborta al instante y libera el botón');

  // ---- registro correcto (sin Telegram)
  env.byId.get('reg-password-input').value = 'clave-segura-1';
  await app.registerWithData();
  ok(env.net.some((l) => l.startsWith('POST /v2/auth/register') && l.includes('nuevo@mail.com')) && env.visible('view-feed'), L + ': registro por email crea sesión y entra al feed');
  ok(env.prefs.alpha_v2_refresh === 'RT-APK', L + ': refresh token guardado en @capacitor/preferences');
  ok(!env.net.some((l) => /"user_id"/.test(l)), L + ': ninguna petición del APK envía user_id');

  // ---- login con Telegram (APK): éxito acelerado por deep link alphabunker://login
  mode.poll = 'ok';
  const ts = Date.now();
  const pOk = app.loginWithTelegram();
  await sleep(80);
  if (env.capListeners.appUrlOpen) env.capListeners.appUrlOpen({ url: 'alphabunker://login?intent=i1' });
  await pOk;
  ok(Date.now() - ts < 1500 && env.net.some((l) => l.startsWith('POST /v2/auth/telegram/login-intent/poll')), L + ': deep link alphabunker://login despierta el sondeo y completa el login');

  // ---- login con Telegram (APK): backend sin el endpoint → degradación elegante
  mode.intent = '404';
  await app.loginWithTelegram();
  ok(btnTg.disabled === true && env.toastText() === W.tr('tg_login_unavailable'), L + ': sin /login-intent en el backend → botón desactivado y aviso, sin congelar');

  // ---- enlaces y botón atrás nativos
  await B.openLink('https://example.com/ayuda');
  ok(env.native.includes('Browser.open:https://example.com/ayuda'), L + ': enlaces web externos con @capacitor/browser');
  ok(!env.native.some((n) => n.startsWith('window.open:')), L + ': nunca window.open en el APK');
  env.capListeners.backButton();
  ok(env.native.includes('minimizeApp'), L + ': botón atrás en la raíz minimiza la app (no la cierra)');
}

// ====================================================================== C) APK sin red con sesión guardada
async function scenarioOffline() {
  const L = 'APK-offline';
  const env = createEnv({
    telegram: 'loaded', capacitor: true, timeoutMs: 300, prefs: { alpha_v2_refresh: 'RT-OLD' },
    fetch: () => Promise.reject(new TypeError('Failed to fetch')),
  });
  env.load(L);
  ok(env.win.AppBridge.isTMA() === false, L + ': Telegram.WebApp presente con initData vacío → NO es TMA');
  await env.boot();
  ok(env.visible('view-offline'), L + ': backend inalcanzable → pantalla "sin conexión" con reintento');
  ok(env.reloads === 0, L + ': sin bucle de location.reload()');
  ok(env.prefs.alpha_v2_refresh === 'RT-OLD', L + ': un fallo de red no borra la sesión guardada');
}

// ====================================================================== D) WebSocket caído: tope de reintentos
async function scenarioReconnect() {
  const L = 'WS-reintentos';
  const env = createEnv({
    telegram: 'tma', wsFail: true, fastTimers: true,
    fetch: (p, init, e) => {
      if (p === '/v2/auth/telegram') return e.json(200, { access_token: 'AT', access_expires_at: Math.floor(Date.now() / 1000) + 3600 });
      if (p === '/v2/auth/me') return e.json(200, { id: 42, display_name: 'Tester', role: 'fan', access_level: 1, age_confirmed: true });
      if (p === '/v2/auth/ws-ticket') return e.json(200, { ticket: 'tk' });
      if (p === '/v2/wallet/me') return e.json(200, { alpha_balance: 0 });
      if (p.startsWith('/v2/posts/feed')) return e.json(200, { posts: [] });
      return null;
    },
  });
  env.load(L);
  const W = env.win;
  await env.boot();
  const dmCount = () => env.sockets.filter((s) => s.url.includes('/v2/chat/dm')).length;
  await sleep(400);
  ok(W.BunkerChat.maxReconnectAttempts === 10, L + ': maxReconnectAttempts = 10');
  ok(dmCount() === 11, L + ': 1 conexión + 10 reintentos y se detiene (' + dmCount() + ' intentos)');
  ok(W.BunkerChat.dm.isPaused(), L + ': socket en pausa, sin bucle infinito');
  await sleep(200);
  ok(dmCount() === 11, L + ': no hay más intentos mientras está en pausa');
  (env.winListeners.online || []).forEach((f) => f({}));
  await sleep(50);
  ok(dmCount() > 11, L + ': evento "online" del navegador reanuda la conexión');
}

// ====================================================================== ejecución
(async () => {
  try { await scenarioTMA(); } catch (e) { ok(false, 'TMA: excepción no controlada → ' + (e && e.stack || e)); }
  try { await scenarioAPK(); } catch (e) { ok(false, 'APK: excepción no controlada → ' + (e && e.stack || e)); }
  try { await scenarioOffline(); } catch (e) { ok(false, 'APK-offline: excepción no controlada → ' + (e && e.stack || e)); }
  try { await scenarioReconnect(); } catch (e) { ok(false, 'WS-reintentos: excepción no controlada → ' + (e && e.stack || e)); }
  const pass = results.filter((r) => r.startsWith('PASS')).length;
  const fail = results.filter((r) => r.startsWith('FAIL')).length;
  console.log(results.join('\n'));
  console.log('\nResultado: ' + pass + ' PASS, ' + fail + ' FAIL');
  process.exit(fail ? 1 : 0);
})();
