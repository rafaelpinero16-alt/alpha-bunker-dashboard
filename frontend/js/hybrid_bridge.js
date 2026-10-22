/**
 * js/hybrid_bridge.js — Interfaz única para Telegram Mini App y Standalone (Web/APK).
 *
 * Cárgalo DESPUÉS de telegram-web-app.js y ANTES de media_manager.js / api_v2.js / chat_v2.js / app.js.
 *
 *   await AppBridge.init({ apiBaseUrl: 'https://api…', wsBaseUrl: 'wss://api…', onStandalonePayment, onAuthRequired });
 *   const me = await AppBridge.getUser();
 *
 * Detalle clave de detección: index.html carga telegram-web-app.js SIEMPRE, así que
 * window.Telegram.WebApp existe también en un navegador normal. Lo único fiable es
 * que initData no esté vacío. (v1 caía al fallback "99xxxxxx" en algunos flujos y en
 * otros asumía Telegram.)
 *
 * Seguridad: el cliente NUNCA envía su user_id. La identidad viaja como initData
 * firmado (TMA) o JWT (Standalone), y el backend la verifica.
 */
(function (global) {
  'use strict';

  const TG = global.Telegram && global.Telegram.WebApp ? global.Telegram.WebApp : null;
  const REFRESH_KEY = 'alpha_v2_refresh';
  const LEGACY_KEYS = ['alpha_user_id', 'alpha_user_pass', 'alpha_session_auth', 'alpha_user_role', 'alpha_secure_token'];

  const state = {
    apiBaseUrl: '',
    wsBaseUrl: '',
    accessToken: null,
    accessExp: 0,
    refreshing: null,
    me: null,
    hooks: { onStandalonePayment: null, onAuthRequired: null },
    listeners: {},
  };

  // ------------------------------------------------------------------ entorno
  function isTelegram() {
    return !!(TG && typeof TG.initData === 'string' && TG.initData.length > 0);
  }

  function tgAtLeast(version) {
    return isTelegram() && typeof TG.isVersionAtLeast === 'function' && TG.isVersionAtLeast(version);
  }

  function platform() {
    if (isTelegram()) return 'telegram:' + (TG.platform || 'unknown');
    if (global.Capacitor && typeof global.Capacitor.isNativePlatform === 'function' && global.Capacitor.isNativePlatform()) {
      return 'capacitor:' + global.Capacitor.getPlatform();
    }
    return 'web';
  }

  // ------------------------------------------------------------------ almacenamiento del refresh token
  // En APK usa @capacitor/preferences (o un plugin de almacenamiento seguro si lo añades).
  const store = {
    async get(key) {
      const prefs = global.Capacitor && global.Capacitor.Plugins && global.Capacitor.Plugins.Preferences;
      if (prefs) return (await prefs.get({ key })).value;
      try { return global.localStorage.getItem(key); } catch (_) { return null; }
    },
    async set(key, value) {
      const prefs = global.Capacitor && global.Capacitor.Plugins && global.Capacitor.Plugins.Preferences;
      if (prefs) return prefs.set({ key, value });
      try { global.localStorage.setItem(key, value); } catch (_) { /* modo privado */ }
    },
    async remove(key) {
      const prefs = global.Capacitor && global.Capacitor.Plugins && global.Capacitor.Plugins.Preferences;
      if (prefs) return prefs.remove({ key });
      try { global.localStorage.removeItem(key); } catch (_) { /* noop */ }
    },
  };

  // ------------------------------------------------------------------ eventos internos
  function on(evt, fn) { (state.listeners[evt] = state.listeners[evt] || []).push(fn); return () => off(evt, fn); }
  function off(evt, fn) { state.listeners[evt] = (state.listeners[evt] || []).filter((f) => f !== fn); }
  function emit(evt, data) { (state.listeners[evt] || []).forEach((fn) => { try { fn(data); } catch (e) { console.error(e); } }); }

  // ------------------------------------------------------------------ sesión
  function setSession(payload) {
    state.accessToken = payload.access_token;
    state.accessExp = (payload.access_expires_at || 0) * 1000;
    if (payload.refresh_token) store.set(REFRESH_KEY, payload.refresh_token);
  }

  async function rawPost(path, body, extraHeaders) {
    const res = await fetch(state.apiBaseUrl + path, {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, extraHeaders || {}),
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.detail || ('HTTP ' + res.status));
      err.status = res.status;
      throw err;
    }
    return data;
  }

  async function obtainSession() {
    if (isTelegram()) {
      // TMA: initData firmado → JWT. Si initData caducó, el usuario debe reabrir la Mini App.
      setSession(await rawPost('/v2/auth/telegram', null, { 'X-Telegram-Init-Data': TG.initData }));
      return true;
    }
    const refresh = await store.get(REFRESH_KEY);
    if (!refresh) return false;
    try {
      setSession(await rawPost('/v2/auth/refresh', { refresh_token: refresh }));
      return true;
    } catch (e) {
      if (e.status === 401) await store.remove(REFRESH_KEY);
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
      if (state.hooks.onAuthRequired) state.hooks.onAuthRequired();
      const err = new Error('AUTH_REQUIRED');
      err.status = 401;
      throw err;
    }
    return state.accessToken;
  }

  async function authFetch(path, options) {
    const opts = Object.assign({ method: 'GET', headers: {} }, options || {});
    const send = async () => {
      const token = await ensureAccessToken();
      const headers = Object.assign({}, opts.headers, { Authorization: 'Bearer ' + token });
      if (opts.json !== undefined) {
        headers['Content-Type'] = 'application/json';
        opts.body = JSON.stringify(opts.json);
      }
      return fetch(state.apiBaseUrl + path, { method: opts.method, headers, body: opts.body });
    };
    let res = await send();
    if (res.status === 401) {           // token revocado/caducado: un único reintento
      state.accessToken = null;
      res = await send();
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.detail || ('HTTP ' + res.status));
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  }

  async function getUser(force) {
    if (state.me && !force) return state.me;
    state.me = await authFetch('/v2/auth/me');
    emit('user', state.me);
    return state.me;
  }

  async function login(email, password) {
    setSession(await rawPost('/v2/auth/login', { email, password }));
    return getUser(true);
  }

  async function register(email, password, displayName, extra) {
    const body = Object.assign({ email, password, display_name: displayName }, extra || {});
    setSession(await rawPost('/v2/auth/register', body));
    return getUser(true);
  }

  /**
   * Standalone (Web/APK): login "con Telegram" sin initData. El backend crea un intent,
   * el usuario lo confirma en el bot (deep link /start login_<nonce>) y aquí se sondea.
   */
  async function loginViaTelegramBot(timeoutMs) {
    const intent = await rawPost('/v2/auth/telegram/login-intent', {});
    openLink(intent.deep_link);
    const deadline = Date.now() + (timeoutMs || 120000);
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 2500));
      let res;
      try { res = await rawPost('/v2/auth/telegram/login-intent/poll', { intent_id: intent.intent_id, poll_secret: intent.poll_secret }); }
      catch (e) { if (e.status === 410) break; continue; }
      if (res && res.access_token) { setSession(res); return getUser(true); }
    }
    const err = new Error('TELEGRAM_LOGIN_TIMEOUT');
    err.status = 408;
    throw err;
  }

  async function logout() {
    const refresh = await store.get(REFRESH_KEY);
    if (refresh) { try { await rawPost('/v2/auth/logout', { refresh_token: refresh }); } catch (_) { /* noop */ } }
    await store.remove(REFRESH_KEY);
    state.accessToken = null;
    state.me = null;
    emit('auth:logout');
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
    openLink(deep_link);
    return deep_link;
  }

  // ------------------------------------------------------------------ pagos
  async function pollOrder(orderId, timeoutMs) {
    const deadline = Date.now() + (timeoutMs || 90000);
    while (Date.now() < deadline) {
      let o = null;
      // FIX v2.1: un fallo de red puntual ya no aborta el sondeo de un pago en curso.
      try { o = await authFetch('/v2/payments/orders/' + encodeURIComponent(orderId)); }
      catch (e) { if (e.status === 401 || e.status === 404) throw e; }
      if (o && (o.status === 'paid' || o.status === 'failed' || o.status === 'refunded')) return o.status;
      await new Promise((r) => setTimeout(r, 2000));
    }
    return 'pending';
  }

  /**
   * Compra un paquete con Telegram Stars.
   * Resuelve con { status: 'paid' | 'cancelled' | 'failed' | 'pending' | 'standalone_alternative', order_id }
   * 'paid' solo se devuelve cuando el BACKEND confirma (no basta el callback del cliente).
   */
  async function payStars(packageSlug) {
    if (!isTelegram()) {
      const me = await getUser();
      if (!me.telegram_linked) {
        // Sin Telegram vinculado no hay Stars: delegamos al modal alternativo (TON / vincular).
        if (state.hooks.onStandalonePayment) state.hooks.onStandalonePayment(packageSlug);
        return { status: 'standalone_alternative', order_id: null };
      }
    }

    const inv = await authFetch('/v2/payments/stars/invoice', { method: 'POST', json: { package_slug: packageSlug } });

    if (isTelegram() && tgAtLeast('6.1')) {
      const clientStatus = await new Promise((resolve) => TG.openInvoice(inv.invoice_link, resolve));
      if (clientStatus !== 'paid') {
        haptic(clientStatus === 'failed' ? 'error' : 'warning');
        return { status: clientStatus, order_id: inv.order_id };
      }
    } else {
      // Standalone con Telegram vinculado: la factura se paga dentro de la app de Telegram.
      openLink(inv.invoice_link);
    }
    const status = await pollOrder(inv.order_id);
    haptic(status === 'paid' ? 'success' : 'warning');
    emit('payment', { status, order_id: inv.order_id, package_slug: packageSlug });
    if (status === 'paid') getUser(true).catch(() => {});
    return { status, order_id: inv.order_id };
  }

  /** Pago TON vía TonConnect UI (pasa tu instancia de TonConnectUI). */
  async function payTon(packageSlug, tonConnectUI) {
    if (!tonConnectUI || !tonConnectUI.connected) throw new Error('TON_WALLET_NOT_CONNECTED');
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

  // ------------------------------------------------------------------ háptica
  const IMPACT = ['light', 'medium', 'heavy', 'rigid', 'soft'];
  const NOTIFY = ['success', 'warning', 'error'];
  const VIBRATE_MS = { light: 10, soft: 10, selection: 8, medium: 20, rigid: 25, heavy: 35, success: [15, 40, 15], warning: [30, 50, 30], error: [50, 40, 50] };

  function haptic(type) {
    const t = type || 'light';
    try {
      if (tgAtLeast('6.1') && TG.HapticFeedback) {
        if (t === 'selection') return TG.HapticFeedback.selectionChanged();
        if (NOTIFY.indexOf(t) >= 0) return TG.HapticFeedback.notificationOccurred(t);
        return TG.HapticFeedback.impactOccurred(IMPACT.indexOf(t) >= 0 ? t : 'light');
      }
      if (global.navigator && typeof global.navigator.vibrate === 'function') {
        global.navigator.vibrate(VIBRATE_MS[t] || 10);
      }
    } catch (_) { /* la háptica nunca debe romper un flujo */ }
  }

  // ------------------------------------------------------------------ navegación unificada
  // Pila única: el BackButton de Telegram, el botón atrás de Android y el del navegador
  // pasan TODOS por history.back() → popstate → handler de la vista superior.
  const navigation = (function () {
    const stack = [];
    let tgHandlerBound = false;

    function syncBackButton() {
      if (!tgAtLeast('6.1') || !TG.BackButton) return;
      if (stack.length > 0) TG.BackButton.show(); else TG.BackButton.hide();
    }

    function onTgBack() { haptic('light'); global.history.back(); }

    function bind() {
      // FIX v2.1: history.go(-n) dispara UN solo popstate; antes solo se desapilaba
      // un nivel y la pila quedaba desincronizada con el historial real.
      global.addEventListener('popstate', (ev) => {
        const target = (ev.state && ev.state.abNav && ev.state.depth) || 0;
        while (stack.length > target) {
          const top = stack.pop();
          if (top && typeof top.onBack === 'function') { try { top.onBack(); } catch (e) { console.error(e); } }
        }
        syncBackButton();
      });
      if (tgAtLeast('6.1') && TG.BackButton && !tgHandlerBound) {
        TG.BackButton.onClick(onTgBack);
        tgHandlerBound = true;
      }
    }

    return {
      bind,
      /** Abre una vista "apilada" (modal, detalle…). onBack la cierra. */
      push(viewId, onBack) {
        stack.push({ viewId, onBack });
        global.history.pushState({ abNav: viewId, depth: stack.length }, '');
        syncBackButton();
      },
      /** Cerrar programáticamente (p. ej. botón X) manteniendo historial coherente. */
      back() { if (stack.length) global.history.back(); },
      depth() { return stack.length; },
      current() { return stack.length ? stack[stack.length - 1].viewId : null; },
    };
  })();

  // ------------------------------------------------------------------ MainButton (con fallback)
  const mainButton = (function () {
    let handler = null;
    return {
      /** En Standalone devuelve false y tu UI debe mostrar su propio botón. */
      show({ text, onClick, color, textColor, progress }) {
        if (!tgAtLeast('6.1') || !TG.MainButton) return false;
        if (handler) TG.MainButton.offClick(handler);
        handler = onClick;
        TG.MainButton.setParams({ text, color, text_color: textColor, is_active: true, is_visible: true });
        TG.MainButton.onClick(handler);
        if (progress) TG.MainButton.showProgress(true); else TG.MainButton.hideProgress();
        return true;
      },
      hide() {
        if (!tgAtLeast('6.1') || !TG.MainButton) return;
        if (handler) TG.MainButton.offClick(handler);
        handler = null;
        TG.MainButton.hide();
      },
    };
  })();

  // ------------------------------------------------------------------ enlaces
  function openLink(url) {
    if (isTelegram()) {
      if (/^https:\/\/t\.me\//i.test(url) && typeof TG.openTelegramLink === 'function') return TG.openTelegramLink(url);
      if (typeof TG.openLink === 'function') return TG.openLink(url);
    }
    global.open(url, '_blank', 'noopener');
  }

  // ------------------------------------------------------------------ tema y ciclo de vida TMA
  function applyTelegramChrome(colors) {
    if (!isTelegram()) return;
    TG.ready();
    TG.expand();
    if (tgAtLeast('6.1')) {
      try { TG.setHeaderColor(colors.header || '#000000'); } catch (_) {}
      try { TG.setBackgroundColor(colors.background || '#000000'); } catch (_) {}
    }
    if (tgAtLeast('7.10') && typeof TG.setBottomBarColor === 'function') {
      try { TG.setBottomBarColor(colors.bottomBar || colors.background || '#000000'); } catch (_) {}
    }
    if (tgAtLeast('7.7') && typeof TG.disableVerticalSwipes === 'function') TG.disableVerticalSwipes();
    if (typeof TG.onEvent === 'function') {
      TG.onEvent('themeChanged', () => emit('theme', TG.themeParams));
      if (tgAtLeast('8.0')) {
        TG.onEvent('activated', () => emit('app:active'));
        TG.onEvent('deactivated', () => emit('app:inactive'));
      }
    }
  }

  /** Pide confirmación al cerrar (p. ej. durante una videollamada o un pago). */
  function setClosingConfirmation(enabled) {
    if (!tgAtLeast('6.2')) return;
    if (enabled) TG.enableClosingConfirmation(); else TG.disableClosingConfirmation();
  }

  function startParam() {
    if (isTelegram()) return (TG.initDataUnsafe && TG.initDataUnsafe.start_param) || null;
    const p = new URLSearchParams(global.location.search);
    return p.get('startapp') || p.get('ref') || null;
  }

  // Eventos de visibilidad unificados (TMA 8.0 + navegador / WebView).
  global.document.addEventListener('visibilitychange', () => {
    emit(global.document.visibilityState === 'hidden' ? 'app:inactive' : 'app:active');
  });
  global.addEventListener('pagehide', () => emit('app:terminate'));

  // ------------------------------------------------------------------ Capacitor (APK / iOS)
  // La WebView de Android no garantiza visibilitychange al pausar la Activity, y el botón
  // atrás físico debe pasar por la misma pila que BackButton de Telegram.
  function bindCapacitor() {
    const CapApp = global.Capacitor && global.Capacitor.Plugins && global.Capacitor.Plugins.App;
    if (!CapApp || typeof CapApp.addListener !== 'function') return;
    CapApp.addListener('appStateChange', (s) => emit(s && s.isActive ? 'app:active' : 'app:inactive'));
    CapApp.addListener('backButton', () => {
      if (navigation.depth() > 0) { haptic('light'); global.history.back(); return; }
      // En la raíz: minimizar (Android) en lugar de matar la app; la vista decide vía evento.
      emit('nav:root-back');
      if (typeof CapApp.minimizeApp === 'function') CapApp.minimizeApp().catch(() => {});
    });
    CapApp.addListener('appUrlOpen', (ev) => emit('deeplink', ev && ev.url));
  }

  function exitApp() {
    if (isTelegram()) return TG.close();
    const CapApp = global.Capacitor && global.Capacitor.Plugins && global.Capacitor.Plugins.App;
    if (CapApp && typeof CapApp.exitApp === 'function') return CapApp.exitApp();
    global.close();
  }

  // ------------------------------------------------------------------ init
  async function init(config) {
    const cfg = config || {};
    if (!cfg.apiBaseUrl) throw new Error('AppBridge.init: apiBaseUrl requerido');
    state.apiBaseUrl = cfg.apiBaseUrl.replace(/\/+$/, '');
    state.wsBaseUrl = (cfg.wsBaseUrl || '').replace(/\/+$/, '');
    state.hooks.onStandalonePayment = cfg.onStandalonePayment || null;
    state.hooks.onAuthRequired = cfg.onAuthRequired || null;

    // Limpia artefactos inseguros de v1 (contraseña en claro, IDs falsos, "sesión" base64).
    LEGACY_KEYS.forEach((k) => { try { global.localStorage.removeItem(k); } catch (_) {} });

    applyTelegramChrome(cfg.colors || {});
    navigation.bind();
    bindCapacitor();

    try {
      return await getUser(true);
    } catch (e) {
      if (e.status === 401 || e.message === 'AUTH_REQUIRED') return null; // Standalone sin sesión → pantalla login
      throw e;
    }
  }

  global.AppBridge = Object.freeze({
    init, isTelegram, platform, tgAtLeast,
    getUser, login, register, logout, authFetch, wsUrl, linkTelegram, loginViaTelegramBot,
    payStars, payTon, pollOrder,
    haptic, navigation, mainButton, openLink, setClosingConfirmation, startParam, exitApp,
    on, off,
    get telegram() { return isTelegram() ? TG : null; },
  });
})(window);
