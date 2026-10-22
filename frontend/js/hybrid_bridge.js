/**
 * js/hybrid_bridge.js (v2.2) — Interfaz única para Telegram Mini App (TMA) y Standalone (APK Capacitor / Web).
 *
 * Cargar DESPUÉS de config.js y telegram-web-app.js, y ANTES de media_manager.js / api_v2.js / chat_v2.js / app.js.
 *
 *   await AppBridge.init({ apiBaseUrl, wsBaseUrl, onStandalonePayment, onAuthRequired });
 *   const me = await AppBridge.getUser();
 *
 * Reglas de esta versión:
 *   1. Detección de entorno: isTMA() solo es verdadero si Telegram.WebApp.initData NO está vacío.
 *      telegram-web-app.js se carga también en el APK, así que la mera existencia del objeto no basta.
 *   2. Ninguna llamada a Telegram puede romper el hilo principal: todas pasan por tgCall(), que
 *      comprueba entorno + versión dentro de try/catch y devuelve un fallback.
 *   3. Toda petición HTTP tiene timeout (AbortController). Sin esto, un backend dormido o una
 *      petición bloqueada por CORS en el APK dejaba la promesa colgada y la UI "congelada".
 *   4. En el APK los enlaces externos se abren con @capacitor/browser / @capacitor/app-launcher;
 *      nunca se navega la WebView fuera de la app.
 *   5. El cliente NUNCA envía su user_id: la identidad viaja como initData firmado (TMA) o JWT.
 */
(function (global) {
  'use strict';

  const REFRESH_KEY = 'alpha_v2_refresh';
  const LEGACY_KEYS = ['alpha_user_id', 'alpha_user_pass', 'alpha_session_auth', 'alpha_user_role', 'alpha_secure_token'];
  const DEFAULT_TIMEOUT_MS = 15000;
  const LOG = '[AppBridge]';

  const state = {
    apiBaseUrl: '',
    wsBaseUrl: '',
    timeoutMs: DEFAULT_TIMEOUT_MS,
    accessToken: null,
    accessExp: 0,
    refreshing: null,
    me: null,
    hooks: { onStandalonePayment: null, onAuthRequired: null },
    listeners: {},
    lastDeepLink: null,
    initialized: false,
  };

  // ================================================================== entorno
  /** Objeto WebApp de Telegram o null. Se resuelve en cada llamada (nunca se cachea un undefined). */
  function getTG() {
    try {
      return (typeof global !== 'undefined' && global.Telegram && global.Telegram.WebApp) ? global.Telegram.WebApp : null;
    } catch (_) { return null; }
  }

  /** true solo dentro de Telegram: initData firmado y no vacío. */
  const isTMA = () => {
    try {
      const tg = getTG();
      return !!(tg && typeof tg.initData === 'string' && tg.initData.length > 0);
    } catch (_) { return false; }
  };

  // Alias histórico usado por el resto de módulos.
  function isTelegram() { return isTMA(); }

  function tgAtLeast(version) {
    try {
      const tg = getTG();
      return isTMA() && typeof tg.isVersionAtLeast === 'function' && tg.isVersionAtLeast(version);
    } catch (_) { return false; }
  }

  /**
   * Ejecuta fn(tg) solo dentro de Telegram y con la versión mínima indicada.
   * Fuera de Telegram, con versión insuficiente o si lanza, devuelve fallback.
   */
  function tgCall(minVersion, fn, fallback, label) {
    if (!isTMA()) return fallback;
    if (minVersion && !tgAtLeast(minVersion)) return fallback;
    try { return fn(getTG()); }
    catch (e) { console.warn(LOG, 'Telegram.' + (label || 'call') + ' falló:', e); return fallback; }
  }

  function capacitor() {
    try { return global.Capacitor || null; } catch (_) { return null; }
  }

  function isNative() {
    try {
      const cap = capacitor();
      return !!(cap && typeof cap.isNativePlatform === 'function' && cap.isNativePlatform());
    } catch (_) { return false; }
  }

  /** Plugin nativo de Capacitor por nombre (App, Preferences, Browser, AppLauncher…) o null. */
  function plugin(name) {
    try {
      const cap = capacitor();
      return (cap && cap.Plugins && cap.Plugins[name]) || null;
    } catch (_) { return null; }
  }

  function platform() {
    if (isTMA()) { const tg = getTG(); return 'telegram:' + ((tg && tg.platform) || 'unknown'); }
    if (isNative()) { try { return 'capacitor:' + capacitor().getPlatform(); } catch (_) { return 'capacitor:unknown'; } }
    return 'web';
  }

  // ================================================================== almacenamiento del refresh token
  // En APK usa @capacitor/preferences; en web, localStorage. Nunca lanza.
  const store = {
    async get(key) {
      try {
        const prefs = plugin('Preferences');
        if (prefs) return (await prefs.get({ key })).value || null;
        return global.localStorage.getItem(key);
      } catch (e) { console.warn(LOG, 'store.get', e); return null; }
    },
    async set(key, value) {
      try {
        const prefs = plugin('Preferences');
        if (prefs) { await prefs.set({ key, value }); return; }
        global.localStorage.setItem(key, value);
      } catch (e) { console.warn(LOG, 'store.set', e); }
    },
    async remove(key) {
      try {
        const prefs = plugin('Preferences');
        if (prefs) { await prefs.remove({ key }); return; }
        global.localStorage.removeItem(key);
      } catch (e) { console.warn(LOG, 'store.remove', e); }
    },
  };

  // ================================================================== eventos internos
  function on(evt, fn) { (state.listeners[evt] = state.listeners[evt] || []).push(fn); return () => off(evt, fn); }
  function off(evt, fn) { state.listeners[evt] = (state.listeners[evt] || []).filter((f) => f !== fn); }
  function emit(evt, data) {
    (state.listeners[evt] || []).slice().forEach((fn) => {
      try { fn(data); } catch (e) { console.error(LOG, 'listener "' + evt + '" falló:', e); }
    });
  }

  // ================================================================== red con timeout
  function makeError(message, status, code, data) {
    const err = new Error(message);
    err.status = status;
    err.code = code;
    if (data) err.data = data;
    return err;
  }

  /**
   * fetch con timeout y errores normalizados:
   *   status 0 + code 'TIMEOUT'  → el servidor no respondió a tiempo
   *   status 0 + code 'NETWORK'  → sin red, DNS o CORS (en el APK: Origin https://localhost no permitido)
   *   status 0 + code 'ABORTED'  → cancelada por el llamador (signal)
   */
  async function fetchWithTimeout(url, init, timeoutMs, externalSignal) {
    const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    let timedOut = false;
    const timer = ctrl ? setTimeout(() => { timedOut = true; ctrl.abort(); }, timeoutMs || state.timeoutMs) : null;
    const onExternalAbort = () => { if (ctrl) ctrl.abort(); };
    if (externalSignal) {
      if (externalSignal.aborted) { clearTimeout(timer); throw makeError('ABORTED', 0, 'ABORTED'); }
      externalSignal.addEventListener('abort', onExternalAbort);
    }
    try {
      return await fetch(url, Object.assign({}, init, ctrl ? { signal: ctrl.signal } : {}));
    } catch (e) {
      if (timedOut) throw makeError('TIMEOUT', 0, 'TIMEOUT');
      if (externalSignal && externalSignal.aborted) throw makeError('ABORTED', 0, 'ABORTED');
      console.error(LOG, 'Fallo de red en', url, '— revisa conexión y CORS (Origin del APK: https://localhost).', e);
      throw makeError('NETWORK', 0, 'NETWORK');
    } finally {
      clearTimeout(timer);
      if (externalSignal) externalSignal.removeEventListener('abort', onExternalAbort);
    }
  }

  async function readJson(res) {
    if (res.status === 204) return {};
    try { return await res.json(); } catch (_) { return {}; }
  }

  async function rawPost(path, body, extraHeaders, opts) {
    const res = await fetchWithTimeout(state.apiBaseUrl + path, {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, extraHeaders || {}),
      body: body ? JSON.stringify(body) : undefined,
    }, opts && opts.timeoutMs, opts && opts.signal);
    const data = await readJson(res);
    if (!res.ok) throw makeError(data.detail || ('HTTP ' + res.status), res.status, data.code || 'HTTP', data);
    return data;
  }

  // ================================================================== sesión
  function setSession(payload) {
    if (!payload || !payload.access_token) throw makeError('Respuesta de sesión inválida', 500, 'BAD_SESSION');
    state.accessToken = payload.access_token;
    state.accessExp = (payload.access_expires_at || 0) * 1000;
    if (payload.refresh_token) store.set(REFRESH_KEY, payload.refresh_token);
  }

  async function obtainSession() {
    if (isTMA()) {
      // TMA: initData firmado → JWT. Si initData caducó, el usuario debe reabrir la Mini App.
      const initData = tgCall(null, (tg) => tg.initData, '', 'initData');
      setSession(await rawPost('/v2/auth/telegram', null, { 'X-Telegram-Init-Data': initData }));
      return true;
    }
    const refresh = await store.get(REFRESH_KEY);
    if (!refresh) return false;
    try {
      setSession(await rawPost('/v2/auth/refresh', { refresh_token: refresh }));
      return true;
    } catch (e) {
      if (e.status === 401) await store.remove(REFRESH_KEY);
      if (e.status === 0) throw e;            // sin red: no es "sesión inválida"
      return false;
    }
  }

  async function ensureAccessToken() {
    if (state.accessToken && Date.now() < state.accessExp - 30000) return state.accessToken;
    if (!state.refreshing) {
      state.refreshing = obtainSession().finally(() => { state.refreshing = null; });
    }
    const ok = await state.refreshing;
    if (!ok) {
      state.accessToken = null;
      emit('auth:required');
      try { if (state.hooks.onAuthRequired) state.hooks.onAuthRequired(); } catch (e) { console.error(LOG, 'onAuthRequired', e); }
      throw makeError('AUTH_REQUIRED', 401, 'AUTH_REQUIRED');
    }
    return state.accessToken;
  }

  async function authFetch(path, options) {
    const opts = Object.assign({ method: 'GET', headers: {} }, options || {});
    const send = async () => {
      const token = await ensureAccessToken();
      const headers = Object.assign({}, opts.headers, { Authorization: 'Bearer ' + token });
      let body = opts.body;
      if (opts.json !== undefined) {
        headers['Content-Type'] = 'application/json';
        body = JSON.stringify(opts.json);
      }
      return fetchWithTimeout(state.apiBaseUrl + path, { method: opts.method, headers, body }, opts.timeoutMs, opts.signal);
    };
    let res = await send();
    if (res.status === 401) {             // token revocado/caducado: un único reintento
      state.accessToken = null;
      res = await send();
    }
    const data = await readJson(res);
    if (!res.ok) throw makeError(data.detail || ('HTTP ' + res.status), res.status, data.code || 'HTTP', data);
    return data;
  }

  async function getUser(force) {
    if (state.me && !force) return state.me;
    state.me = await authFetch('/v2/auth/me');
    emit('user', state.me);
    return state.me;
  }

  /** Login email/contraseña. 100 % independiente de Telegram. */
  async function login(email, password) {
    setSession(await rawPost('/v2/auth/login', { email, password }));
    return getUser(true);
  }

  /** Registro email/contraseña. 100 % independiente de Telegram. */
  async function register(email, password, displayName, extra) {
    const body = Object.assign({ email, password, display_name: displayName }, extra || {});
    setSession(await rawPost('/v2/auth/register', body));
    return getUser(true);
  }

  /**
   * Standalone (APK/Web): "Login con Telegram" sin initData.
   *  1. El backend crea un intent y devuelve el deep link del bot (t.me/<bot>?start=login_<nonce>).
   *  2. Se abre Telegram (app nativa). El usuario confirma en el bot.
   *  3. El bot responde con un botón a alphabunker://login?intent=<id> que reabre el APK;
   *     ese deep link adelanta el sondeo. Si el usuario vuelve a mano, el sondeo lo detecta igual.
   * opts: { signal, timeoutMs }. Errores con code: TG_LOGIN_UNAVAILABLE | TG_LOGIN_TIMEOUT | ABORTED.
   */
  async function loginViaTelegramBot(opts) {
    const o = opts || {};
    let intent;
    try {
      intent = await rawPost('/v2/auth/telegram/login-intent', { platform: platform() }, null, { signal: o.signal });
    } catch (e) {
      if ([404, 405, 501].indexOf(e.status) >= 0) throw makeError('TG_LOGIN_UNAVAILABLE', e.status, 'TG_LOGIN_UNAVAILABLE');
      throw e;
    }
    if (!intent || !intent.deep_link || !intent.intent_id) throw makeError('TG_LOGIN_UNAVAILABLE', 501, 'TG_LOGIN_UNAVAILABLE');
    await openLink(intent.deep_link);

    let wake = null;
    const offDeep = on('deeplink', (url) => {
      if (typeof url === 'string' && /^[a-z]+:\/\/login\b/i.test(url) && wake) wake();
    });
    const offActive = on('app:active', () => { if (wake) wake(); });
    const onAbort = () => { if (wake) wake(); };
    if (o.signal) o.signal.addEventListener('abort', onAbort);
    const deadline = Date.now() + (o.timeoutMs || 120000);
    try {
      while (Date.now() < deadline) {
        if (o.signal && o.signal.aborted) throw makeError('ABORTED', 0, 'ABORTED');
        await new Promise((resolve) => {
          const t = setTimeout(resolve, 2500);
          wake = () => { clearTimeout(t); resolve(); };
        });
        wake = null;
        let res = null;
        try {
          res = await rawPost('/v2/auth/telegram/login-intent/poll', { intent_id: intent.intent_id, poll_secret: intent.poll_secret }, null, { signal: o.signal, timeoutMs: 10000 });
        } catch (e) {
          if (e.code === 'ABORTED') throw e;
          if (e.status === 410) break;               // intent caducado o rechazado
          continue;                                   // fallo puntual de red: seguir sondeando
        }
        if (res && res.access_token) { setSession(res); return await getUser(true); }
      }
    } finally {
      offDeep();
      offActive();
      if (o.signal) o.signal.removeEventListener('abort', onAbort);
      wake = null;
    }
    throw makeError('TELEGRAM_LOGIN_TIMEOUT', 408, 'TG_LOGIN_TIMEOUT');
  }

  async function logout() {
    try {
      const refresh = await store.get(REFRESH_KEY);
      if (refresh) { try { await rawPost('/v2/auth/logout', { refresh_token: refresh }); } catch (_) { /* noop */ } }
    } finally {
      await store.remove(REFRESH_KEY);
      state.accessToken = null;
      state.me = null;
      emit('auth:logout');
    }
  }

  /** URL de WebSocket con ticket de un solo uso (el navegador no permite cabeceras en WS). */
  async function wsUrl(path) {
    const { ticket } = await authFetch('/v2/auth/ws-ticket', { method: 'POST' });
    const base = state.wsBaseUrl || state.apiBaseUrl.replace(/^http/, 'ws');
    const sep = path.indexOf('?') >= 0 ? '&' : '?';
    return base + path + sep + 'ticket=' + encodeURIComponent(ticket);
  }

  async function linkTelegram() {
    const { deep_link } = await authFetch('/v2/auth/link/telegram', { method: 'POST' });
    await openLink(deep_link);
    return deep_link;
  }

  // ================================================================== pagos
  async function pollOrder(orderId, timeoutMs) {
    const deadline = Date.now() + (timeoutMs || 90000);
    while (Date.now() < deadline) {
      let o = null;
      try { o = await authFetch('/v2/payments/orders/' + encodeURIComponent(orderId)); }
      catch (e) { if (e.status === 401 || e.status === 404) throw e; }
      if (o && (o.status === 'paid' || o.status === 'failed' || o.status === 'refunded')) return o.status;
      await new Promise((r) => setTimeout(r, 2000));
    }
    return 'pending';
  }

  /**
   * Compra un paquete con Telegram Stars.
   * Resuelve con { status: 'paid' | 'cancelled' | 'failed' | 'pending' | 'standalone_alternative', order_id }.
   * 'paid' solo se devuelve cuando el BACKEND confirma (no basta el callback del cliente).
   */
  async function payStars(packageSlug) {
    if (!isTMA()) {
      const me = await getUser();
      if (!me.telegram_linked) {
        try { if (state.hooks.onStandalonePayment) state.hooks.onStandalonePayment(packageSlug); } catch (e) { console.error(LOG, 'onStandalonePayment', e); }
        return { status: 'standalone_alternative', order_id: null };
      }
    }

    const inv = await authFetch('/v2/payments/stars/invoice', { method: 'POST', json: { package_slug: packageSlug } });

    if (tgAtLeast('6.1')) {
      const clientStatus = await new Promise((resolve) => {
        const opened = tgCall('6.1', (tg) => { tg.openInvoice(inv.invoice_link, resolve); return true; }, false, 'openInvoice');
        if (!opened) resolve('failed');
      });
      if (clientStatus !== 'paid') {
        haptic(clientStatus === 'failed' ? 'error' : 'warning');
        return { status: clientStatus, order_id: inv.order_id };
      }
    } else {
      // Standalone con Telegram vinculado: la factura se paga dentro de la app de Telegram.
      await openLink(inv.invoice_link);
    }
    const status = await pollOrder(inv.order_id);
    haptic(status === 'paid' ? 'success' : 'warning');
    emit('payment', { status, order_id: inv.order_id, package_slug: packageSlug });
    if (status === 'paid') getUser(true).catch(() => {});
    return { status, order_id: inv.order_id };
  }

  /** Pago TON vía TonConnect UI (pasa tu instancia de TonConnectUI). */
  async function payTon(packageSlug, tonConnectUI) {
    if (!tonConnectUI || !tonConnectUI.connected) throw makeError('TON_WALLET_NOT_CONNECTED', 0, 'TON_WALLET_NOT_CONNECTED');
    const o = await authFetch('/v2/payments/ton/order', { method: 'POST', json: { package_slug: packageSlug } });
    await tonConnectUI.sendTransaction({
      validUntil: o.valid_until,
      messages: [{ address: o.address, amount: o.amount_nano, payload: o.payload }],
    });
    // La confirmación real la hace el backend leyendo la blockchain (~10-60 s).
    const status = await pollOrder(o.order_id, 180000);
    emit('payment', { status, order_id: o.order_id, package_slug: packageSlug });
    return { status, order_id: o.order_id };
  }

  // ================================================================== háptica
  const IMPACT = ['light', 'medium', 'heavy', 'rigid', 'soft'];
  const NOTIFY = ['success', 'warning', 'error'];
  const VIBRATE_MS = { light: 10, soft: 10, selection: 8, medium: 20, rigid: 25, heavy: 35, success: [15, 40, 15], warning: [30, 50, 30], error: [50, 40, 50] };

  function haptic(type) {
    const t = type || 'light';
    const done = tgCall('6.1', (tg) => {
      if (!tg.HapticFeedback) return false;
      if (t === 'selection') tg.HapticFeedback.selectionChanged();
      else if (NOTIFY.indexOf(t) >= 0) tg.HapticFeedback.notificationOccurred(t);
      else tg.HapticFeedback.impactOccurred(IMPACT.indexOf(t) >= 0 ? t : 'light');
      return true;
    }, false, 'HapticFeedback');
    if (done) return;
    try {
      if (global.navigator && typeof global.navigator.vibrate === 'function') global.navigator.vibrate(VIBRATE_MS[t] || 10);
    } catch (_) { /* la háptica nunca debe romper un flujo */ }
  }

  // ================================================================== navegación unificada
  // Pila única: el BackButton de Telegram, el botón atrás de Android y el del navegador
  // pasan TODOS por history.back() → popstate → handler de la vista superior.
  const navigation = (function () {
    const stack = [];
    let bound = false;
    let tgHandlerBound = false;

    function syncBackButton() {
      tgCall('6.1', (tg) => {
        if (!tg.BackButton) return;
        if (stack.length > 0) tg.BackButton.show(); else tg.BackButton.hide();
      }, null, 'BackButton');
    }

    function onTgBack() { haptic('light'); try { global.history.back(); } catch (_) {} }

    function bind() {
      if (bound) return;
      bound = true;
      // history.go(-n) dispara UN solo popstate: se desapila hasta la profundidad destino.
      global.addEventListener('popstate', (ev) => {
        const target = (ev.state && ev.state.abNav && ev.state.depth) || 0;
        while (stack.length > target) {
          const top = stack.pop();
          if (top && typeof top.onBack === 'function') { try { top.onBack(); } catch (e) { console.error(LOG, 'onBack', e); } }
        }
        syncBackButton();
      });
      if (!tgHandlerBound) {
        tgHandlerBound = !!tgCall('6.1', (tg) => { if (!tg.BackButton) return false; tg.BackButton.onClick(onTgBack); return true; }, false, 'BackButton.onClick');
      }
    }

    return {
      bind,
      /** Abre una vista "apilada" (modal, detalle…). onBack la cierra. */
      push(viewId, onBack) {
        stack.push({ viewId, onBack });
        try { global.history.pushState({ abNav: viewId, depth: stack.length }, ''); } catch (e) { console.warn(LOG, 'pushState', e); }
        syncBackButton();
      },
      /** Cerrar programáticamente (p. ej. botón X) manteniendo historial coherente. */
      back() { if (stack.length) { try { global.history.back(); } catch (_) {} } },
      depth() { return stack.length; },
      current() { return stack.length ? stack[stack.length - 1].viewId : null; },
    };
  })();

  // ================================================================== MainButton (con fallback)
  const mainButton = (function () {
    let handler = null;
    return {
      /** Fuera de Telegram devuelve false y la UI debe mostrar su propio botón. */
      show({ text, onClick, color, textColor, progress }) {
        return !!tgCall('6.1', (tg) => {
          if (!tg.MainButton) return false;
          if (handler) tg.MainButton.offClick(handler);
          handler = onClick;
          const params = { text, is_active: true, is_visible: true };
          if (color) params.color = color;
          if (textColor) params.text_color = textColor;
          tg.MainButton.setParams(params);
          tg.MainButton.onClick(handler);
          if (progress) tg.MainButton.showProgress(true); else tg.MainButton.hideProgress();
          return true;
        }, false, 'MainButton.show');
      },
      hide() {
        tgCall('6.1', (tg) => {
          if (!tg.MainButton) return;
          if (handler) tg.MainButton.offClick(handler);
          handler = null;
          tg.MainButton.hide();
        }, null, 'MainButton.hide');
      },
    };
  })();

  // ================================================================== enlaces
  /**
   * Abre un enlace externo sin sacar la WebView de la app.
   *  - TMA: openTelegramLink (t.me) / openLink.
   *  - APK: AppLauncher (tg://, tc://, t.me → abre la app nativa) o Browser (Custom Tab);
   *         último recurso location.href, que Capacitor envía al sistema porque el host
   *         no está en server.allowNavigation.
   *  - Web: window.open.
   */
  async function openLink(url) {
    if (!url || typeof url !== 'string') { console.error(LOG, 'openLink: URL inválida', url); return false; }

    if (isTMA()) {
      const done = tgCall(null, (tg) => {
        if (/^https:\/\/t\.me\//i.test(url) && typeof tg.openTelegramLink === 'function') { tg.openTelegramLink(url); return true; }
        if (typeof tg.openLink === 'function') { tg.openLink(url); return true; }
        return false;
      }, false, 'openLink');
      if (done) return true;
    }

    if (isNative()) {
      const isWeb = /^https?:\/\//i.test(url);
      const preferApp = !isWeb || /^https:\/\/(t\.me|telegram\.me|app\.tonkeeper\.com)\//i.test(url);
      const launcher = plugin('AppLauncher');
      if (preferApp && launcher) {
        try { const r = await launcher.openUrl({ url }); if (!r || r.completed !== false) return true; }
        catch (e) { console.warn(LOG, 'AppLauncher.openUrl', e); }
      }
      const browser = plugin('Browser');
      if (isWeb && browser) {
        try { await browser.open({ url, presentationStyle: 'popover' }); return true; }
        catch (e) { console.warn(LOG, 'Browser.open', e); }
      }
      try { global.location.href = url; return true; } catch (e) { console.error(LOG, 'openLink nativo', e); return false; }
    }

    try {
      const w = global.open(url, '_blank', 'noopener');
      if (!w) global.location.href = url;
      return true;
    } catch (e) { console.error(LOG, 'window.open', e); return false; }
  }

  // ================================================================== tema y ciclo de vida TMA
  function applyTelegramChrome(colors) {
    if (!isTMA()) return;
    tgCall(null, (tg) => tg.ready(), null, 'ready');
    tgCall(null, (tg) => tg.expand(), null, 'expand');
    tgCall('6.1', (tg) => tg.setHeaderColor(colors.header || '#000000'), null, 'setHeaderColor');
    tgCall('6.1', (tg) => tg.setBackgroundColor(colors.background || '#000000'), null, 'setBackgroundColor');
    tgCall('7.10', (tg) => { if (typeof tg.setBottomBarColor === 'function') tg.setBottomBarColor(colors.bottomBar || colors.background || '#000000'); }, null, 'setBottomBarColor');
    tgCall('7.7', (tg) => { if (typeof tg.disableVerticalSwipes === 'function') tg.disableVerticalSwipes(); }, null, 'disableVerticalSwipes');
    tgCall(null, (tg) => {
      if (typeof tg.onEvent !== 'function') return;
      tg.onEvent('themeChanged', () => emit('theme', tg.themeParams));
      if (tgAtLeast('8.0')) {
        tg.onEvent('activated', () => emit('app:active'));
        tg.onEvent('deactivated', () => emit('app:inactive'));
      }
    }, null, 'onEvent');
  }

  /** Pide confirmación al cerrar (p. ej. durante una videollamada o un pago). No-op fuera de Telegram. */
  function setClosingConfirmation(enabled) {
    tgCall('6.2', (tg) => { if (enabled) tg.enableClosingConfirmation(); else tg.disableClosingConfirmation(); }, null, 'closingConfirmation');
  }

  function startParam() {
    if (isTMA()) return tgCall(null, (tg) => (tg.initDataUnsafe && tg.initDataUnsafe.start_param) || null, null, 'start_param');
    try {
      const p = new URLSearchParams(global.location.search);
      return p.get('startapp') || p.get('ref') || null;
    } catch (_) { return null; }
  }

  // Eventos de visibilidad unificados (TMA 8.0 + navegador / WebView).
  try {
    global.document.addEventListener('visibilitychange', () => {
      emit(global.document.visibilityState === 'hidden' ? 'app:inactive' : 'app:active');
    });
    global.addEventListener('pagehide', () => emit('app:terminate'));
  } catch (e) { console.warn(LOG, 'eventos de visibilidad', e); }

  // ================================================================== Capacitor (APK / iOS)
  // La WebView de Android no garantiza visibilitychange al pausar la Activity, y el botón
  // atrás físico debe pasar por la misma pila que el BackButton de Telegram.
  let capacitorBound = false;
  function bindCapacitor() {
    if (capacitorBound) return;
    const CapApp = plugin('App');
    if (!CapApp || typeof CapApp.addListener !== 'function') return;
    capacitorBound = true;
    try {
      CapApp.addListener('appStateChange', (s) => emit(s && s.isActive ? 'app:active' : 'app:inactive'));
      CapApp.addListener('backButton', () => {
        if (navigation.depth() > 0) { haptic('light'); try { global.history.back(); } catch (_) {} return; }
        emit('nav:root-back');
        if (typeof CapApp.minimizeApp === 'function') Promise.resolve(CapApp.minimizeApp()).catch(() => {});
      });
      CapApp.addListener('appUrlOpen', (ev) => {
        const url = ev && ev.url;
        state.lastDeepLink = url || null;
        emit('deeplink', url);
      });
      // Deep link que arrancó la app en frío.
      if (typeof CapApp.getLaunchUrl === 'function') {
        Promise.resolve(CapApp.getLaunchUrl()).then((r) => { if (r && r.url) { state.lastDeepLink = r.url; emit('deeplink', r.url); } }).catch(() => {});
      }
    } catch (e) { console.error(LOG, 'bindCapacitor', e); }
  }

  function exitApp() {
    if (isTMA()) { tgCall(null, (tg) => tg.close(), null, 'close'); return; }
    const CapApp = plugin('App');
    if (CapApp && typeof CapApp.exitApp === 'function') { try { CapApp.exitApp(); return; } catch (e) { console.warn(LOG, 'exitApp', e); } }
    try { global.close(); } catch (_) {}
  }

  // ================================================================== init
  /**
   * Inicializa el puente. Devuelve el usuario o null (Standalone sin sesión → pantalla de login).
   * Solo lanza si el backend no es alcanzable (err.status 0) o responde con error ≠ 401.
   */
  async function init(config) {
    const cfg = config || {};
    if (!cfg.apiBaseUrl) throw makeError('AppBridge.init: apiBaseUrl requerido', 0, 'CONFIG');
    state.apiBaseUrl = cfg.apiBaseUrl.replace(/\/+$/, '');
    state.wsBaseUrl = (cfg.wsBaseUrl || '').replace(/\/+$/, '');
    state.timeoutMs = Number(cfg.timeoutMs) > 0 ? Number(cfg.timeoutMs) : DEFAULT_TIMEOUT_MS;
    state.hooks.onStandalonePayment = cfg.onStandalonePayment || null;
    state.hooks.onAuthRequired = cfg.onAuthRequired || null;

    // Limpia artefactos inseguros de v1 (contraseña en claro, IDs falsos, "sesión" base64).
    LEGACY_KEYS.forEach((k) => { try { global.localStorage.removeItem(k); } catch (_) {} });

    applyTelegramChrome(cfg.colors || {});
    navigation.bind();
    bindCapacitor();
    state.initialized = true;
    console.info(LOG, 'entorno:', platform());

    try {
      return await getUser(true);
    } catch (e) {
      if (e.status === 401 || e.code === 'AUTH_REQUIRED') return null;
      throw e;
    }
  }

  global.AppBridge = Object.freeze({
    init, isTMA, isTelegram, isNative, platform, tgAtLeast, tgCall, plugin,
    getUser, login, register, logout, authFetch, wsUrl, linkTelegram, loginViaTelegramBot,
    payStars, payTon, pollOrder,
    haptic, navigation, mainButton, openLink, setClosingConfirmation, startParam, exitApp,
    on, off,
    get telegram() { return isTMA() ? getTG() : null; },
    get lastDeepLink() { return state.lastDeepLink; },
  });
})(window);
