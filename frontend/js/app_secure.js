/**
 * js/app_secure.js (v2.3) — Capa de integración segura sobre app.js (app_5.js).
 *
 * Se carga DESPUÉS de app.js y sustituye en runtime los métodos que:
 *   1. enviaban user_id/sender_id/follower_id desde el cliente (27 fetch directos),
 *   2. decidían precio/nivel/rol en el cliente (TON create-transaction, admin por ID fijo),
 *   3. usaban BunkerChat.globalSocket (inexistente en chat_v2 → mensajes que nunca salían),
 *   4. pedían la cámara fuera de MediaManager,
 *   5. interpolaban datos de otros usuarios dentro de onclick="…" (XSS).
 *
 * app.js NO se edita: todos sus onclick llaman a app.metodo() en tiempo de clic, así que
 * la versión sustituida es la que se ejecuta. Los renders nuevos usan data-act + delegación.
 *
 * Orden de carga (index.html): config → telegram-web-app + tonconnect-ui → translations + translations_patch
 *   → hybrid_bridge → media_manager → api_v2 → chat_v2 → ui_bridge → webrtc_room → app → app_secure
 */
(function (global) {
  'use strict';
  const app = global.app;
  if (!app) throw new Error('app_secure.js debe cargarse después de app.js');
  const CFG = global.ALPHA_CONFIG;
  const B = () => global.AppBridge;
  const Api = () => global.AlphaApi;
  const UI = () => global.UI;
  const Chat = () => global.BunkerChat;
  const RV = () => global.RoomVideo;
  const doc = global.document;
  const $ = (id) => doc.getElementById(id);

  const esc = (s) => app.escapeHtml(s);
  const T = (k, d) => app.getTrans(k) || d || '';
  const getLS = (k) => { try { return global.localStorage.getItem(k); } catch (_) { return null; } };
  const setLS = (k, v) => { try { if (v === null || v === undefined || v === '') global.localStorage.removeItem(k); else global.localStorage.setItem(k, String(v)); } catch (_) {} };
  const SUPPORTED_LANGS = ['es', 'en', 'it', 'pt', 'de', 'fr'];
  const LEVEL_BY_SLUG = { spy: 0, soldier: 1, veteran: 2, legend: 3, 'icon-legend': 4, icon_legend: 4 };
  const SLUG_BY_LEVEL = ['spy', 'soldier', 'veteran', 'legend', 'icon-legend'];

  let ME = null;
  let payInFlight = false;
  const orig = {};
  ['updateProfileUI', 'loadConversation', 'openDirectChat', 'closeModals', 'openExternalCheckout', 'subscribeCreatorTier'].forEach((k) => { orig[k] = app[k]; });

  function toast(m) { try { app.showToast(m); } catch (e) { console.error('[AlphaSecure] toast', e, m); } }
  function errMsg(e) {
    if (!e) return T('toast_network_error', 'Error');
    if (e.code === 'TIMEOUT') return T('toast_server_slow', 'Servidor lento');
    if (e.code === 'NETWORK' || e.status === 0) return T('toast_server_unreachable', 'Sin conexión');
    if (e.status === 401) return T('toast_session_expired', 'Sesión expirada');
    if (e.status === 402) return T('toast_insufficient_balance', 'Saldo insuficiente');
    return e.message ? '⚠️ ' + e.message : T('toast_network_error', 'Error de red');
  }
  function syncClosingConfirmation() { B().setClosingConfirmation(payInFlight || !!(RV() && RV().isActive())); }

  // ==================================================================== 0. red de seguridad
  // Cualquier fetch al backend fuera de /v2 queda bloqueado (código legacy olvidado).
  if (CFG.features.blockLegacyEndpoints && typeof global.fetch === 'function') {
    const nativeFetch = global.fetch.bind(global);
    const base = CFG.apiBaseUrl.replace(/\/+$/, '');
    global.fetch = function (input, init) {
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      if (url.indexOf(base) === 0) {
        const path = url.slice(base.length);
        if (!/^\/v2\//.test(path) && path.indexOf('/tonconnect-manifest.json') !== 0) {
          console.error('[AlphaSecure] Endpoint legacy bloqueado:', path);
          const err = new Error('LEGACY_ENDPOINT_BLOCKED'); err.status = 410;
          return Promise.reject(err);
        }
      }
      return nativeFetch(input, init);
    };
  }

  // ==================================================================== 1. i18n
  // Una sola fuente de verdad: translations_patch.js (tr). Fallback idioma → en → es → ''.
  app.getTrans = function (key) {
    try {
      if (typeof global.tr === 'function') return global.tr(key, this.currentLang);
      const lang = this.currentLang || getLS('alpha_lang') || 'es';
      const t = global.t || {};
      return (t[lang] && t[lang][key]) || (t.en && t.en[key]) || (t.es && t.es[key]) || '';
    } catch (_) { return ''; }
  };

  // ==================================================================== 2. identidad (solo servidor)
  app.initUserId = function () { this.userId = ME ? String(ME.id) : null; };
  app.isAdminUser = function () { return !!(ME && ME.role === 'admin'); };
  app.toggleAdminSecret = function () { this.isAdmin = this.isAdminUser(); };

  function applyMe(me) {
    if (!me) return;
    ME = me;
    app.userId = String(me.id);
    app.userData = Object.assign(app.userData || {}, {
      name: me.display_name || me.name || 'USER',
      access_tier: Number(me.access_level || 0),
      role: me.role || 'fan',
      warnings: Number(me.warnings_count || 0),
      isOnline: !me.is_invisible,
      kyc_status: me.kyc_status || 'unverified',
    });
    // Caché SOLO de presentación (updateProfileUI la lee). El servidor revalida todo.
    setLS('alpha_user_name', app.userData.name);
    setLS('alpha_user_role', app.userData.role);
    setLS('alpha_kyc_status', app.userData.kyc_status);
    setLS('alpha_user_avatar', me.avatar_url || '');
    setLS('alpha_user_bio', me.bio || '');
    setLS('alpha_ton_connected', me.ton_address ? 'true' : '');
  }
  B().on('user', applyMe);

  function clearAppStorage() {
    const keep = ['alpha_lang', 'alpha_theme', 'alpha_consent'];
    try {
      Object.keys(global.localStorage).forEach((k) => { if (k.indexOf('alpha_') === 0 && keep.indexOf(k) < 0) global.localStorage.removeItem(k); });
      global.sessionStorage.clear();
    } catch (_) {}
  }

  // ==================================================================== 3. arranque y sesión
  // Durante el arranque, "sin sesión" es el estado normal del APK: no se muestra
  // "sesión expirada" ni se cambia de vista desde onAuthRequired.
  let booting = true;

  // ---------------------------------------------------------------- Splash 3D gestionado
  /**
   * Sustituye a app.initSplash3D (que creaba un WebGLRenderer nuevo en cada arranque, lo
   * paraba a los 3 s aunque el splash siguiera visible y nunca liberaba el contexto WebGL).
   *  - Un único renderer; si ya existe, start() solo reanuda la animación.
   *  - Animación limitada a ~30 fps y en pausa cuando la app pasa a segundo plano.
   *  - stop() libera geometrías, materiales y el contexto WebGL (forceContextLoss), para que
   *    el vídeo WebRTC y el resto de la SPA no compitan con un contexto huérfano.
   *  - Sin WebGL, sin THREE o con prefers-reduced-motion: no hace nada (queda el logo estático).
   */
  const Splash3D = (function () {
    let ctx = null, rafId = 0, last = 0, running = false;
    const FRAME_MS = 1000 / 30;

    function reducedMotion() {
      try { return global.matchMedia && global.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (_) { return false; }
    }

    function build(canvas) {
      const THREE = global.THREE;
      const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: false, powerPreference: 'low-power' });
      renderer.setSize(canvas.clientWidth || 176, canvas.clientHeight || 176, false);
      renderer.setPixelRatio(Math.min(global.devicePixelRatio || 1, 1.5));
      const scene = new THREE.Scene();
      const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
      camera.position.z = 4.5;
      const sphereGeo = new THREE.IcosahedronGeometry(1.4, 1);
      const sphereMat = new THREE.MeshBasicMaterial({ color: 0x00f3ff, wireframe: true, transparent: true, opacity: 0.35 });
      const sphere = new THREE.Mesh(sphereGeo, sphereMat);
      scene.add(sphere);
      const count = 70;
      const positions = new Float32Array(count * 3);
      for (let i = 0; i < count * 3; i++) positions[i] = (Math.random() - 0.5) * 5;
      const pointsGeo = new THREE.BufferGeometry();
      pointsGeo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      const pointsMat = new THREE.PointsMaterial({ color: 0xff00ff, size: 0.06 });
      const points = new THREE.Points(pointsGeo, pointsMat);
      scene.add(points);
      return { renderer, scene, camera, sphere, points, disposables: [sphereGeo, sphereMat, pointsGeo, pointsMat] };
    }

    function frame(t) {
      if (!running || !ctx) return;
      rafId = global.requestAnimationFrame(frame);
      if (t - last < FRAME_MS) return;
      last = t;
      ctx.sphere.rotation.x += 0.016;
      ctx.sphere.rotation.y += 0.024;
      ctx.points.rotation.y -= 0.01;
      ctx.renderer.render(ctx.scene, ctx.camera);
    }

    function pause() { running = false; if (rafId) global.cancelAnimationFrame(rafId); rafId = 0; }

    function resume() {
      if (!ctx || running || doc.visibilityState === 'hidden') return;
      running = true; last = 0;
      rafId = global.requestAnimationFrame(frame);
    }

    function start() {
      if (ctx) { resume(); return true; }
      const canvas = $('splash-3d-canvas');
      if (!canvas || !global.THREE || reducedMotion()) return false;
      try { ctx = build(canvas); }
      catch (e) { console.warn('[Splash3D] WebGL no disponible; se mantiene el logo estático.', e); ctx = null; return false; }
      resume();
      return true;
    }

    function stop() {
      pause();
      if (!ctx) return;
      try {
        ctx.disposables.forEach((d) => { try { d.dispose(); } catch (_) {} });
        ctx.renderer.dispose();
        if (typeof ctx.renderer.forceContextLoss === 'function') ctx.renderer.forceContextLoss();
      } catch (e) { console.warn('[Splash3D] dispose', e); }
      ctx = null;
    }

    B().on('app:inactive', pause);
    B().on('app:active', resume);
    return { start, stop, isRunning: () => running, hasContext: () => !!ctx };
  })();

  app.initSplash3D = function () { return Splash3D.start(); };

  function hideSplash() {
    const splash = $('view-splash');
    if (!splash) { Splash3D.stop(); return; }
    splash.classList.add('opacity-0');
    setTimeout(() => { splash.classList.add('hidden'); Splash3D.stop(); }, 400);
  }

  /** Pantalla de error de red con botón de reintento (sustituye al alert + reload en bucle). */
  function showOfflineScreen(err) {
    let box = $('view-offline');
    if (!box) {
      box = doc.createElement('div');
      box.id = 'view-offline';
      box.className = 'ab-offline';
      box.innerHTML =
        '<i class="fa-solid fa-satellite-dish ab-offline-icon"></i>' +
        '<h2 class="ab-offline-title" data-i18n="boot_offline_title"></h2>' +
        '<p class="ab-offline-desc" data-i18n="boot_offline_desc"></p>' +
        '<p class="ab-offline-code"></p>' +
        '<button type="button" class="ab-btn ab-btn-primary ab-offline-retry" data-i18n="btn_retry"></button>';
      doc.body.appendChild(box);
      box.querySelector('.ab-offline-retry').addEventListener('click', () => {
        box.classList.add('hidden');
        const splash = $('view-splash');
        if (splash) splash.classList.remove('hidden', 'opacity-0');
        app.checkSession();
      });
    }
    if (typeof global.applyTranslations === 'function') global.applyTranslations(undefined, box);
    box.querySelector('.ab-offline-code').textContent = (err && (err.code || err.status)) ? 'Código: ' + (err.code || err.status) : '';
    box.classList.remove('hidden');
  }

  app.checkSession = async function () {
    booting = true;
    try { this.initTheme(); } catch (e) { console.error('[AlphaBoot] initTheme', e); }
    try { this.initSplash3D(); } catch (e) { console.warn('[AlphaBoot] initSplash3D', e); }

    // Idioma: preferencia guardada → idioma del usuario de Telegram (solo en TMA) → español.
    try {
      let lang = getLS('alpha_lang');
      if (!lang) {
        const tgLang = B().tgCall(null, (tg) => tg.initDataUnsafe && tg.initDataUnsafe.user && tg.initDataUnsafe.user.language_code, null, 'language_code');
        lang = tgLang ? String(tgLang).slice(0, 2) : 'es';
      }
      if (SUPPORTED_LANGS.indexOf(lang) < 0) lang = 'es';
      this.currentLang = lang;
      if (typeof global.setAppLanguage === 'function') global.setAppLanguage(lang);
      else if (typeof global.applyTranslations === 'function') global.applyTranslations(lang);
    } catch (e) { console.error('[AlphaBoot] idioma', e); }

    const splash = $('view-splash');
    doc.querySelectorAll('[id^="view-"]').forEach((el) => { if (el.id !== 'view-splash') el.classList.add('hidden'); });
    if (splash) splash.classList.remove('hidden', 'opacity-0');

    const minSplash = new Promise((r) => setTimeout(r, 1200));
    let me = null, bootErr = null;
    try {
      me = await B().init({
        apiBaseUrl: CFG.apiBaseUrl,
        wsBaseUrl: CFG.wsBaseUrl,
        timeoutMs: CFG.timeoutMs,
        colors: CFG.colors,
        onStandalonePayment: (slug) => app.openStandalonePayment(slug),
        onAuthRequired: onAuthLost,
      });
    } catch (e) {
      bootErr = e;
      console.error('[AlphaBoot] AppBridge.init falló (' + (e.code || e.status) + '). Entorno: ' + B().platform(), e);
    }
    await minSplash;
    hideSplash();
    booting = false;

    // Sin sesión en Standalone el backend no es imprescindible para mostrar consentimiento/login.
    if (bootErr && !B().isTelegram() && !(await hasStoredSession())) { routeAfterBoot(null); return; }
    if (bootErr) { showOfflineScreen(bootErr); return; }
    routeAfterBoot(me);
  };

  async function hasStoredSession() {
    try {
      const prefs = B().plugin('Preferences');
      if (prefs) return !!(await prefs.get({ key: 'alpha_v2_refresh' })).value;
      return !!getLS('alpha_v2_refresh');
    } catch (_) { return false; }
  }

  function routeAfterBoot(me) {
    const consent = getLS('alpha_consent') === 'true' || !!(me && me.age_confirmed);
    if (!consent) return app.switchView('consent');
    if (!me) return app.switchView('login');
    enterApp(me);
  }

  function enterApp(me) {
    try {
      applyMe(me);
      if (!me.age_confirmed && getLS('alpha_consent') === 'true') Api().updateMyProfile({ age_confirmed: true }).catch(() => {});
      app.switchView('feed');
      app.updateProfileUI();
      app.updateViewsCounter();
    } catch (e) { console.error('[AlphaBoot] enterApp (UI)', e); }
    // Cada servicio arranca de forma independiente: un fallo no bloquea a los demás.
    try { Chat().initCRM(); } catch (e) { console.error('[AlphaBoot] initCRM', e); }
    Promise.resolve().then(() => app.initTonConnect()).catch((e) => console.warn('[AlphaBoot] TonConnect', e));
    Promise.resolve().then(() => app.refreshUserData()).catch((e) => console.warn('[AlphaBoot] saldo', e));
    Promise.resolve().then(() => app.renderFeed()).catch((e) => console.warn('[AlphaBoot] feed', e));
  }

  let authLostShown = false;
  function onAuthLost() {
    if (booting || authLostShown) return;
    authLostShown = true;
    try {
      if (RV() && RV().isActive()) RV().leave({ silent: true });
      Chat().closeConnections();
    } catch (e) { console.error('[AlphaAuth] limpieza tras perder sesión', e); }
    if (B().isTelegram()) {
      UI().alert(T('toast_session_expired', 'Sesión expirada')).then(() => B().exitApp());
    } else {
      toast(T('toast_session_expired', 'Sesión expirada'));
      ME = null;
      app.switchView('login');
      setTimeout(() => { authLostShown = false; }, 3000);
    }
  }

  app.acceptConsent = function () {
    try {
      this.haptic('medium');
      setLS('alpha_consent', 'true');
      if (ME) return enterApp(ME);
      if (B().isTelegram()) {
        return B().getUser(true).then(enterApp).catch((e) => { console.error('[AlphaAuth] getUser tras consentimiento', e); toast(errMsg(e)); });
      }
      // El captcha cliente es solo UX; la protección anti-bots real debe ir en /v2/auth/* (Turnstile).
      this.switchView('login');
    } catch (e) {
      console.error('[AlphaAuth] acceptConsent', e);
      this.switchView('login');
    }
  };

  app.verifyCaptcha = function () {
    try {
      const input = $('captcha-input');
      const v = input ? input.value.trim().toUpperCase() : '';
      if (!v || v !== this.currentCaptcha) { if (input) input.value = ''; this.generateCaptcha(); B().haptic('error'); return; }
      if (ME) return enterApp(ME);
      this.switchView('login');
    } catch (e) { console.error('[AlphaAuth] verifyCaptcha', e); }
  };

  // ---------------------------------------------------------------- utilidades de autenticación
  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

  /**
   * Bloquea el botón mientras dura la operación y muestra un spinner (clase .ab-busy),
   * para que el usuario vea actividad y no pulse dos veces. Siempre se libera en finally.
   */
  async function withBusy(btn, fn) {
    if (btn && btn.getAttribute('data-busy') === '1') return undefined;
    if (btn) { btn.setAttribute('data-busy', '1'); btn.disabled = true; btn.classList.add('ab-busy'); btn.setAttribute('aria-busy', 'true'); }
    try { return await fn(); }
    finally {
      // data-locked="1" = desactivado de forma permanente (p. ej. login Telegram no disponible).
      if (btn) { btn.removeAttribute('data-busy'); btn.disabled = btn.getAttribute('data-locked') === '1'; btn.classList.remove('ab-busy'); btn.removeAttribute('aria-busy'); }
    }
  }

  function authErrMsg(e, kind) {
    if (!e) return T('toast_network_error');
    if (e.code === 'TIMEOUT') return T('toast_server_slow');
    if (e.code === 'NETWORK' || e.status === 0) return T('toast_server_unreachable');
    if (kind === 'login' && (e.status === 401 || e.status === 403)) return T('toast_invalid_credentials');
    if (kind === 'register' && e.status === 409) return T('toast_account_exists');
    if (e.status === 429) return '⚠️ ' + (e.message || 'Demasiados intentos. Espera un momento.');
    return e.message ? '⚠️ ' + e.message : T('toast_network_error');
  }

  function reportAuthError(where, e, kind) {
    console.error('[AlphaAuth] ' + where + ' falló — entorno=' + B().platform() + ' status=' + (e && e.status) + ' code=' + (e && e.code), e);
    try { B().haptic('error'); } catch (_) {}
    toast(authErrMsg(e, kind));
  }

  // ---------------------------------------------------------------- login email / contraseña (sin Telegram)
  // Lee el formulario de #view-login si existe; si no, abre un formulario modal.
  app.loginWithEmail = async function () {
    const btn = $('btn-phone-text');
    try {
      const e = $('login-email'), p = $('login-password');
      let v = null;
      if (e && p) {
        v = { email: e.value.trim(), password: p.value };
        if (!v.email || !v.password) { B().haptic('error'); toast(T('toast_fill_login')); (v.email ? p : e).focus(); return; }
      } else {
        v = await UI().form({
          title: T('login_title', 'INICIAR SESIÓN'),
          fields: [
            { name: 'email', label: T('field_email', 'Email'), type: 'email', required: true, autocomplete: 'username' },
            { name: 'password', label: T('field_password', 'Contraseña'), type: 'password', required: true, autocomplete: 'current-password' },
          ],
          submitText: T('login_title', 'Entrar'),
        });
        if (!v) return;
      }
      if (!EMAIL_RE.test(v.email)) { B().haptic('error'); toast(T('toast_invalid_email')); if (e) e.focus(); return; }

      await withBusy(btn, async () => {
        try {
          const me = await B().login(v.email, v.password);
          if (p) p.value = '';
          enterApp(me);
        } catch (err) { reportAuthError('loginWithEmail', err, 'login'); }
      });
    } catch (err) { reportAuthError('loginWithEmail (UI)', err, 'login'); }
  };
  // El login por teléfono de v1 no verificaba nada (solo cambiaba de vista). Hasta tener OTP
  // en el backend, se redirige a email/contraseña.
  app.loginWithPhone = app.loginWithEmail;

  // ---------------------------------------------------------------- registro email / contraseña (sin Telegram)
  app.registerWithData = async function () {
    const btn = $('btn-reg-text');
    try {
      const n = $('reg-name-input'), e = $('reg-email-input'), p = $('reg-password-input');
      let v = null;
      if (e && p) {
        v = { name: n ? n.value.trim() : '', email: e.value.trim(), password: p.value };
        if (!v.email || !v.password || (n && !v.name)) { B().haptic('error'); toast(T('toast_fill_register')); return; }
      } else {
        v = await UI().form({
          title: T('register_title', 'CREAR CUENTA'),
          fields: [
            { name: 'name', label: T('field_name', 'Alias'), required: true },
            { name: 'email', label: T('field_email', 'Email'), type: 'email', required: true, autocomplete: 'username' },
            { name: 'password', label: T('field_password', 'Contraseña'), type: 'password', required: true, autocomplete: 'new-password' },
          ],
          submitText: T('register_title', 'Crear'),
        });
        if (!v) return;
      }
      if (!EMAIL_RE.test(v.email)) { B().haptic('error'); toast(T('toast_invalid_email')); if (e) e.focus(); return; }
      if (v.password.length < 8) { B().haptic('error'); toast(T('toast_pwd_min8')); if (p) p.focus(); return; }
      if (v.name.length > 32) v.name = v.name.slice(0, 32);

      // startParam() en Standalone solo lee location.search: nunca espera a Telegram.
      let referral = null;
      try { referral = B().startParam() || getLS('alpha_referred_by') || null; } catch (_) { referral = null; }

      await withBusy(btn, async () => {
        try {
          const me = await B().register(v.email, v.password, v.name || v.email.split('@')[0], {
            requested_role: this.registerRoleSelected === 'creator' ? 'creator' : 'fan',  // el servidor decide
            referral_code: referral,
          });
          if (p) p.value = '';
          enterApp(me);
        } catch (err) { reportAuthError('registerWithData', err, 'register'); }
      });
    } catch (err) { reportAuthError('registerWithData (UI)', err, 'register'); }
  };

  // ---------------------------------------------------------------- login con Telegram
  /** Diálogo "esperando a Telegram" con botón Cancelar; el BackButton/atrás de Android también cancela. */
  function waitingDialog(message, onCancel) {
    const h = UI().h;
    let closed = false;
    const box = h('div', { class: 'ab-overlay', id: 'modal-ab-wait', role: 'dialog', 'aria-modal': 'true' }, [
      h('div', { class: 'ab-dialog' }, [
        h('div', { class: 'ab-spinner', 'aria-hidden': 'true' }),
        h('p', { class: 'ab-dialog-msg', text: message }),
        h('div', { class: 'ab-dialog-actions' }, [h('button', { class: 'ab-btn', type: 'button', text: T('btn_cancel', 'Cancelar'), onclick: () => close(true) })]),
      ]),
    ]);
    function close(cancelled) {
      if (closed) return;
      closed = true;
      box.remove();
      if (cancelled && onCancel) { try { onCancel(); } catch (e) { console.error('[AlphaAuth] cancelar espera', e); } }
    }
    box._abClose = () => close(true);
    doc.body.appendChild(box);
    return { close: () => close(false) };
  }

  function disableTelegramLoginButton() {
    const b = $('btn-login-telegram');
    if (b) { b.setAttribute('data-locked', '1'); b.disabled = true; b.classList.add('opacity-40'); b.classList.remove('levitate'); }
  }

  app.loginWithTelegram = async function () {
    const btn = $('btn-login-telegram');
    try {
      this.haptic('medium');
      // Dentro de Telegram la identidad ya viene firmada en initData.
      if (B().isTelegram()) {
        await withBusy(btn, async () => {
          try { enterApp(await B().getUser(true)); }
          catch (err) { reportAuthError('loginWithTelegram (TMA)', err, 'login'); }
        });
        return;
      }
      // APK / web: flujo externo vía bot + deep link alphabunker://login, o degradación elegante.
      if (!CFG.features.telegramLoginStandalone) {
        disableTelegramLoginButton();
        toast(T('tg_login_unavailable'));
        const e = $('login-email'); if (e) e.focus();
        return;
      }
      const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
      await withBusy(btn, async () => {
        const dlg = waitingDialog(T('tg_login_waiting'), () => { if (ctrl) ctrl.abort(); });
        try {
          const me = await B().loginViaTelegramBot({ signal: ctrl ? ctrl.signal : undefined, timeoutMs: 120000 });
          dlg.close();
          enterApp(me);
        } catch (err) {
          dlg.close();
          if (err && err.code === 'ABORTED') return;
          if (err && err.code === 'TG_LOGIN_UNAVAILABLE') {
            console.error('[AlphaAuth] loginViaTelegramBot: el backend no ofrece /v2/auth/telegram/login-intent (' + err.status + ')');
            disableTelegramLoginButton();
            toast(T('tg_login_unavailable'));
            return;
          }
          if (err && err.code === 'TG_LOGIN_TIMEOUT') { console.error('[AlphaAuth] loginViaTelegramBot: sin confirmación', err); toast(T('tg_login_timeout')); return; }
          reportAuthError('loginWithTelegram (APK)', err, 'login');
        }
      });
    } catch (err) { reportAuthError('loginWithTelegram (UI)', err, 'login'); }
  };

  app.logout = async function () {
    try {
      this.haptic('heavy');
      if (!(await UI().confirm('¿Cerrar sesión?'))) return;
      try { if (RV() && RV().isActive()) RV().leave({ silent: true }); } catch (e) { console.error('[AlphaAuth] logout video', e); }
      try { Chat().closeConnections(); } catch (e) { console.error('[AlphaAuth] logout chat', e); }
      try { global.MediaManager.releaseAll(true); } catch (e) { console.error('[AlphaAuth] logout media', e); }
      try { if (this.tonConnectUI && this.tonConnectUI.connected) await this.tonConnectUI.disconnect(); } catch (_) {}
      await B().logout();
    } catch (e) {
      console.error('[AlphaAuth] logout', e);
    } finally {
      clearAppStorage();
    }
    if (B().isTelegram()) return B().exitApp();
    global.location.reload();
  };

  app.exitApp = function () { B().exitApp(); };

  // ---------------------------------------------------------------- privacidad sin falsos positivos
  // app.js añade .privacy-blur en window 'blur'. Ese evento también salta al abrir openInvoice,
  // TonConnect, el selector de archivos o el permiso de cámara, y dejaba la pantalla negra en
  // pleno pago. Se mantiene el oscurecimiento real (app en segundo plano: visibilitychange) y se
  // anula solo el de 'blur' con la página visible. Se registra tras el DOMContentLoaded de app.js
  // para que este listener corra DESPUÉS del suyo.
  doc.addEventListener('DOMContentLoaded', () => {
    global.addEventListener('blur', () => {
      setTimeout(() => { if (doc.visibilityState === 'visible') doc.body.classList.remove('privacy-blur'); }, 0);
    });
  });

  // ---------------------------------------------------------------- selector de idiomas
  const LANG_LABELS = { es: '🇪🇸 Español', en: '🇬🇧 English', it: '🇮🇹 Italiano', pt: '🇧🇷 Português', de: '🇩🇪 Deutsch', fr: '🇫🇷 Français' };

  /** Vincular al botón de idioma: abre un selector con los 6 idiomas. */
  app.openLanguagePicker = function () {
    try {
      this.haptic('light');
      const h = UI().h;
      const old = $('modal-language'); if (old) old.remove();
      const current = (typeof global.getAppLanguage === 'function' && global.getAppLanguage()) || this.currentLang || 'es';
      let box;
      const close = () => { if (box) box.remove(); };
      const buttons = SUPPORTED_LANGS.map((l) => h('button', {
        type: 'button',
        class: 'ab-lang-btn' + (l === current ? ' is-active' : ''),
        'data-lang': l,
        text: LANG_LABELS[l],
        onclick: () => { app.setLanguage(l); close(); },
      }));
      box = h('div', { class: 'ab-overlay', id: 'modal-language', role: 'dialog', 'aria-modal': 'true' }, [
        h('div', { class: 'ab-dialog' }, [
          h('h3', { class: 'ab-dialog-title', 'data-i18n': 'lang_title', text: T('lang_title', 'IDIOMA') }),
          h('div', { class: 'ab-lang-grid' }, buttons),
          h('div', { class: 'ab-dialog-actions' }, [h('button', { class: 'ab-btn', type: 'button', 'data-i18n': 'btn_cancel', text: T('btn_cancel', 'Cancelar'), onclick: close })]),
        ]),
      ]);
      box._abClose = close;
      doc.body.appendChild(box);
    } catch (e) {
      console.error('[i18n] openLanguagePicker', e);
      this.toggleLanguage();
    }
  };

  /** Cambio de idioma en caliente (sin recargar). */
  app.setLanguage = function (lang) {
    try {
      this.haptic('light');
      const l = typeof global.setAppLanguage === 'function' ? global.setAppLanguage(lang) : lang;
      this.currentLang = l;
    } catch (e) { console.error('[i18n] setLanguage', e); }
  };

  /** Rotación ES→EN→IT→PT→DE→FR (compatibilidad con llamadas antiguas). */
  app.toggleLanguage = function () {
    const cur = (typeof global.getAppLanguage === 'function' && global.getAppLanguage()) || this.currentLang || 'es';
    this.setLanguage(SUPPORTED_LANGS[(SUPPORTED_LANGS.indexOf(cur) + 1) % SUPPORTED_LANGS.length]);
  };

  // Repinta lo que app.js genera dinámicamente con getTrans() al cambiar de idioma.
  doc.addEventListener('alpha:language', (ev) => {
    const l = ev && ev.detail && ev.detail.lang;
    if (l) app.currentLang = l;
    try { if (ME) app.updateProfileUI(); } catch (e) { console.error('[i18n] updateProfileUI', e); }
    try {
      const cat = $('modal-catalog');
      if (cat && !cat.classList.contains('hidden')) app.openCatalogPackages();
    } catch (e) { console.error('[i18n] catálogo', e); }
    try {
      const feed = $('feed-container');
      const cached = global.sessionStorage && global.sessionStorage.getItem('alpha_feed');
      if (ME && feed && cached) app.buildFeedHTML(JSON.parse(cached), feed);
    } catch (e) { console.error('[i18n] feed', e); }
  });

  // ==================================================================== 4. utilidades nativas
  app.haptic = function (style) { B().haptic(style); };
  /** Toast accesible: duración según longitud (2,5–6 s) y sin innerHTML con el mensaje. */
  app.showToast = function (msg) {
    try {
      const text = String(msg == null ? '' : msg);
      const prev = $('alpha-dynamic-toast'); if (prev) prev.remove();
      const el = doc.createElement('div');
      el.id = 'alpha-dynamic-toast';
      el.setAttribute('role', 'status');
      el.setAttribute('aria-live', 'polite');
      el.className = 'ab-toast';
      const icon = doc.createElement('i'); icon.className = 'fa-solid fa-triangle-exclamation';
      const span = doc.createElement('span'); span.textContent = text;
      el.appendChild(icon); el.appendChild(span);
      doc.body.appendChild(el);
      requestAnimationFrame(() => el.classList.add('is-visible'));
      const ms = Math.max(2500, Math.min(6000, 1200 + text.length * 45));
      setTimeout(() => { el.classList.remove('is-visible'); setTimeout(() => el.remove(), 300); }, ms);
    } catch (e) { console.error('[AlphaSecure] showToast', e, msg); }
  };
  app.openLink = function (url) { B().openLink(url); };
  app.copyText = function (text) { UI().copy(text).then((ok) => { if (ok) toast(T('toast_copied', 'Copiado')); }); };

  app.closeModals = function () {
    const room = $('modal-global-chat');
    const roomWasOpen = room && !room.classList.contains('hidden');
    orig.closeModals.call(this);
    if (roomWasOpen && !(RV() && RV().isActive())) Chat().leaveRoom();
  };

  // ==================================================================== 5. perfil y ajustes
  app.updateProfileUI = function () {
    orig.updateProfileUI.call(this);
    // Cabecera del menú lateral (app.js nunca la actualizaba).
    const sbName = $('sidebar-name'); if (sbName) sbName.textContent = this.userData.name || 'USER';
    const sbRank = $('sidebar-rank'); if (sbRank) sbRank.textContent = this.getRankBadge(Number(this.userData.access_tier || 0)).name;
    const sbAv = $('sidebar-avatar-img'); const av = ME && this.sanitizeUrl(ME.avatar_url); if (sbAv && av) sbAv.src = av;
    const ref = $('referral-link-input');
    if (ref && ME) {
      const code = ME.referral_code || ('ref_' + ME.id);
      ref.value = 'https://t.me/' + CFG.botUsername + '/' + CFG.miniAppShortName + '?startapp=' + encodeURIComponent(code);
    }
    // En Telegram la identidad es la cuenta de Telegram: sin contraseña ni logout.
    if (B().isTelegram()) {
      ['settings-old-pass', 'settings-new-pass', 'settings-confirm-pass'].forEach((id) => {
        const el = $(id); const box = el && el.closest('div'); if (box) box.classList.add('hidden');
      });
    }
  };

  app.updateUsernameSettings = async function () {
    this.haptic('medium');
    const input = $('settings-username-input');
    const name = input ? input.value.trim() : '';
    if (!name || name.length > 32) { toast(T('toast_invalid_alias', 'Alias inválido')); return; }
    try {
      await Api().updateMyProfile({ display_name: name });
      applyMe(await B().getUser(true));
      this.updateProfileUI();
      toast(T('toast_alias_updated', 'Alias actualizado'));
      this.closeSettingsModal();
    } catch (e) {
      if (e.status === 429 || e.status === 409) toast(T('toast_alias_wait').replace('{days}', (e.data && e.data.retry_after_days) || 30));
      else toast(errMsg(e));
    }
  };

  app.updatePasswordSettings = async function () {
    this.haptic('medium');
    if (B().isTelegram()) { toast('Tu cuenta usa Telegram: no tiene contraseña.'); return; }
    const o = $('settings-old-pass'), n = $('settings-new-pass'), c = $('settings-confirm-pass');
    const oldP = o ? o.value : '', newP = n ? n.value : '', conf = c ? c.value : '';
    if (!oldP || !newP || !conf) { toast(T('toast_pwd_empty')); return; }
    if (newP.length < 8) { toast('La nueva contraseña debe tener al menos 8 caracteres'); return; }
    if (newP !== conf) { toast(T('toast_pwd_not_match')); return; }
    try {
      await Api().changePassword(oldP, newP);
      [o, n, c].forEach((el) => { if (el) el.value = ''; });
      toast('🔒 ' + T('pwd_changed_success'));
      this.closeSettingsModal();
    } catch (e) { toast(e.status === 403 ? T('toast_pwd_mismatch') : errMsg(e)); }
  };

  app.saveProfile = async function () {
    this.haptic('medium');
    const fields = {};
    const bio = $('prof-bio'); if (bio) fields.bio = bio.value.trim().slice(0, 280);
    const alias = $('prof-alias');
    if (alias && ME && alias.value.trim() && alias.value.trim() !== ME.display_name) fields.display_name = alias.value.trim().slice(0, 32);
    try {
      await Api().updateMyProfile(fields);
      applyMe(await B().getUser(true));
      this.updateProfileUI();
      toast(T('toast_profile_saved', 'Perfil actualizado'));
    } catch (e) { toast(errMsg(e)); }
  };

  app.handleAvatarChange = async function (event) {
    const file = event && event.target && event.target.files && event.target.files[0];
    if (!file || !/^image\//.test(file.type)) return;
    try {
      toast(T('toast_uploading', 'Subiendo…'));
      const dataUrl = await this.compressImage(file, 512, 0.8);
      const m = await Api().uploadMedia(dataUrl, 'avatar');
      await Api().updateMyProfile({ avatar_media_id: m.media_id });
      applyMe(await B().getUser(true));
      this.updateProfileUI();
      toast(T('toast_profile_saved', 'Perfil actualizado'));
    } catch (e) { toast(T('toast_upload_error', 'Error al subir')); }
    finally { event.target.value = ''; }
  };

  app.toggleOnlineStatus = async function () {
    this.haptic('medium');
    if (this.userData.access_tier === 0 && !this.isAdminUser()) { toast(T('toast_offline_tier_req')); return; }
    const next = !this.userData.isOnline;
    this.userData.isOnline = next;
    this.updateOnlineStatusUI();
    try {
      await Api().updateMyProfile({ is_invisible: !next });   // el servidor difunde la presencia
      toast(next ? T('toast_status_online') : T('toast_status_offline'));
    } catch (e) { this.userData.isOnline = !next; this.updateOnlineStatusUI(); toast(errMsg(e)); }
  };
  app.updateOnlineUsersRadar = function () { /* la presencia la emite el servidor */ };

  app.refreshUserData = async function () {
    const w = await Api().walletBalance();
    if (!w) return;
    doc.querySelectorAll('#prof-alpha-balance, #wallet-balance, .wallet-balance-val').forEach((el) => { el.textContent = Number(w.alpha_balance || 0) + ' $ALPHA'; });
  };

  app.syncKYCStatus = async function () {
    try { applyMe(await B().getUser(true)); this.updateProfileUI(); } catch (_) {}
  };

  app.openKYCModal = async function () {
    toast(T('kyc_opening', 'Abriendo verificación…'));
    try {
      const s = await Api().kycSession();
      if (s && s.url) B().openLink(s.url);
    } catch (e) { toast(errMsg(e)); }
  };

  app.loadAlphaCoinsHistory = async function () {
    const box = $('settings-alphacoins-history');
    if (!box) return;
    try {
      const txs = await Api().walletHistory(50);
      if (!txs.length) { box.innerHTML = '<div class="text-center text-neutral-500 text-xs py-4">' + esc(T('no_recent_tx')) + '</div>'; return; }
      box.innerHTML = txs.map((tx) => {
        const amt = Number(tx.amount) || 0;
        return '<div class="bg-black border border-neutral-800 p-2 rounded-xl flex justify-between items-center text-xs">' +
          '<div><span class="font-bold text-white block">' + esc(tx.tx_type || 'Movimiento') + '</span>' +
          '<span class="text-[9px] text-neutral-400">' + esc(tx.created_at ? new Date(tx.created_at).toLocaleDateString() : '') + '</span></div>' +
          '<span class="font-black ' + (amt > 0 ? 'text-emerald-400' : 'text-red-400') + '">' + (amt > 0 ? '+' : '') + amt + ' $ALPHA</span></div>';
      }).join('');
    } catch (_) { box.innerHTML = '<div class="text-center text-neutral-500 text-xs py-4">No se pudo cargar el historial.</div>'; }
  };

  app.requestPayoutFromSettings = async function () {
    this.haptic('heavy');
    if (!this.isAdminUser() && (this.userData.role !== 'creator' || this.userData.kyc_status !== 'verified')) {
      toast('⚠️ Retiros exclusivos para Creadores con KYC verificado.');
      return this.openKYCModal();
    }
    const v = await UI().form({
      title: T('payout_title', 'SOLICITAR RETIRO'),
      fields: [
        { name: 'amount', label: T('payout_amount', 'Cantidad $ALPHA'), type: 'number', min: 1, required: true },
        { name: 'method', label: T('payout_method', 'Método'), type: 'select', value: 'dolarapp_ach', options: [
          { value: 'dolarapp_ach', label: 'ACH / DolarApp' }, { value: 'skrill', label: 'Skrill' }, { value: 'ton', label: 'TON' }, { value: 'binance', label: 'Binance' }] },
        { name: 'destination', label: T('payout_destination', 'Cuenta destino'), required: true },
      ],
      submitText: 'Solicitar',
    });
    if (!v) return;
    if (!Number.isInteger(v.amount) || v.amount <= 0) { toast('Monto de retiro inválido.'); return; }
    try {
      const r = await Api().requestPayout(v.amount, v.method, v.destination);
      toast((r && r.message) || 'Retiro registrado con éxito.');
      this.refreshUserData();
      this.loadAlphaCoinsHistory();
    } catch (e) {
      if (e.status === 403) this.openKYCModal();
      toast(errMsg(e));
    }
  };

  app.renderSettingsContacts = function () {
    const list = $('settings-contacts-list');
    if (!list) return;
    let contacts = [];
    try { contacts = JSON.parse(getLS('alpha_user_contacts') || '[]'); } catch (_) {}
    if (!contacts.length) { list.innerHTML = '<div class="text-center text-neutral-500 text-xs py-3">' + esc(T('no_contacts')) + '</div>'; return; }
    list.innerHTML = contacts.map((c) =>
      '<div class="bg-black border border-neutral-800 p-2.5 rounded-xl flex items-center justify-between">' +
      '<span class="text-xs font-bold text-[#00f3ff]">@' + esc(c) + '</span><div class="flex gap-1.5">' +
      '<button data-act="remove-contact" data-name="' + esc(c) + '" class="bg-red-900/50 text-red-300 px-2 py-1 rounded-lg text-[10px]"><i class="fa-solid fa-trash"></i></button>' +
      '</div></div>').join('');
  };

  app.renderSlotsList = function () {
    const box = $('slots-container-list');
    if (!box) return;
    let html = '';
    for (let i = 1; i <= 10; i++) {
      html += '<div class="bg-black/60 border border-neutral-800 p-3 rounded-xl space-y-1"><label class="text-[10px] text-[#ffb703] font-bold uppercase">Slot ' + i + '</label>' +
        '<input type="text" id="slot-input-' + i + '" value="' + esc(getLS('alpha_slot_' + i) || '') + '" class="cyber-input text-xs"></div>';
    }
    box.innerHTML = html;
  };

  // ==================================================================== 6. pagos
  function canUseExternalGateways() {
    return B().isTelegram() ? !!CFG.features.externalGatewaysInTelegram : !!CFG.features.externalGatewaysStandalone;
  }

  app.openCatalogPackages = async function () {
    this.closeModals();
    let modal = $('modal-catalog');
    if (!modal) {
      doc.body.insertAdjacentHTML('beforeend',
        '<div id="modal-catalog" class="fixed inset-0 z-[100] flex items-center justify-center bg-black bg-opacity-95 backdrop-blur-md hidden">' +
        '<div class="bg-neutral-900 border-2 border-[#00f3ff] rounded-3xl p-6 w-11/12 max-w-lg max-h-[85vh] flex flex-col shadow-[0_0_20px_rgba(0,243,255,0.3)] relative">' +
        '<button onclick="app.closeModals()" class="absolute top-4 right-4 text-neutral-400 hover:text-white font-bold p-1 z-10"><i class="fa-solid fa-times text-xl"></i></button>' +
        '<h3 id="catalog-title" class="text-2xl font-black text-[#00f3ff] mb-2 text-center tracking-widest uppercase"></h3>' +
        '<p id="catalog-desc" class="text-xs text-neutral-300 text-center mb-4"></p>' +
        '<div id="catalog-packages-list" class="overflow-y-auto pr-2 pb-6 space-y-4"></div></div></div>');
      modal = $('modal-catalog');
    }
    // index.html trae su propio #modal-catalog (con #cat-title y sin #catalog-desc): solo se
    // tocan los elementos que existan, para no romper con ninguno de los dos marcados.
    const titleEl = $('catalog-title'); if (titleEl) titleEl.textContent = T('cat_title', 'RANGOS BÚNKER');
    const descEl = $('catalog-desc'); if (descEl) descEl.textContent = T('cat_desc', 'Adquiere tu rango oficial.');
    modal.classList.remove('hidden');
    const box = $('catalog-packages-list');
    if (!box) { console.error('[AlphaPay] falta #catalog-packages-list en el modal del catálogo'); return; }
    box.innerHTML = '<div class="text-center text-neutral-400 mt-10 font-bold">' + esc(T('cat_loading')) + '</div>';
    try {
      const pkgs = await Api().packages();
      const ext = canUseExternalGateways();
      pkgs.sort((a, b) => (LEVEL_BY_SLUG[a.slug] || 0) - (LEVEL_BY_SLUG[b.slug] || 0));
      box.innerHTML = pkgs.map((p) => {
        const level = LEVEL_BY_SLUG[p.slug] !== undefined ? LEVEL_BY_SLUG[p.slug] : 0;
        const badge = this.getRankBadge(level);
        const border = level === 4 ? 'border-[#ffb703]' : level === 3 ? 'border-[#ff00ff]' : 'border-[#00f3ff]';
        const desc = T('pkg_' + String(p.slug).replace(/-/g, '_') + '_desc', 'Membresía oficial ' + badge.name + '.');
        return '<div class="bg-black border-2 ' + border + ' rounded-2xl p-5 relative mt-4">' +
          '<div class="absolute -top-4 right-4 bg-gradient-to-r from-amber-500 to-yellow-600 text-black px-4 py-1 rounded-full text-xs font-black uppercase tracking-widest">' + esc(T('cat_official_rank')) + '</div>' +
          '<div class="flex justify-between items-center mb-2 mt-2"><h3 class="text-xl font-black text-white flex items-center gap-3">' +
          '<img src="' + esc(badge.img) + '" class="w-10 h-10 object-contain rank-badge" alt=""><span>' + esc(badge.name) + '</span></h3>' +
          '<span class="text-xl font-black text-[#ffb703]">' + Number(p.alpha_total || 0) + ' $ALPHA</span></div>' +
          '<p class="text-sm text-gray-300 mb-4 font-medium">' + esc(desc) + '</p><div class="grid grid-cols-2 gap-2">' +
          '<button data-act="buy-stars" data-slug="' + esc(p.slug) + '" class="w-full bg-blue-600 hover:bg-blue-500 text-white py-3 rounded-xl font-black text-xs uppercase">⭐ ' + Number(p.price_stars || 0) + '</button>' +
          '<button data-act="buy-ton" data-slug="' + esc(p.slug) + '" class="w-full bg-neutral-800 text-cyan-400 border border-cyan-500/30 py-3 rounded-xl font-black text-xs uppercase">💎 ' + esc(p.price_ton) + ' TON</button>' +
          (ext ? '<button data-act="buy-external" data-slug="' + esc(p.slug) + '" class="w-full col-span-2 bg-neutral-800 text-white border border-neutral-600 py-3 rounded-xl font-black text-xs uppercase mt-1"><i class="fa-solid fa-money-bill-transfer"></i> ' + esc(T('btn_external_checkout')) + '</button>' : '') +
          '</div></div>';
      }).join('');
    } catch (e) { box.innerHTML = '<div class="text-center text-red-400 mt-10 font-bold">' + esc(T('cat_error')) + '</div>'; }
  };

  async function afterPayment(result) {
    if (result.status === 'paid') {
      const prev = Number(app.userData.access_tier || 0);
      const me = await B().getUser(true);
      applyMe(me);
      toast(T('toast_payment_confirmed', 'Pago confirmado'));
      if (Number(me.access_level || 0) > prev) app.showLevelUpAnimation(Number(me.access_level));
      app.refreshUserData();
      app.updateProfileUI();
      app.closeModals();
    } else if (result.status === 'pending') {
      toast(T('toast_payment_pending', 'Pago en verificación'));
    } else if (result.status === 'cancelled' || result.status === 'failed') {
      toast(T('toast_payment_cancelled', 'Pago cancelado'));
    }
  }

  app.buyPackageStars = async function (slug) {
    if (payInFlight || !slug) return;
    this.haptic('medium');
    payInFlight = true; syncClosingConfirmation();
    toast(T('toast_invoice_gen', 'Generando factura… ⭐'));
    try { await afterPayment(await B().payStars(String(slug))); }
    catch (e) { B().haptic('error'); toast(e.status ? errMsg(e) : T('toast_invoice_error')); }
    finally { payInFlight = false; syncClosingConfirmation(); }
  };

  app.buyPackageTon = async function (slug) {
    if (payInFlight || !slug) return;
    this.haptic('medium');
    await this.initTonConnect();
    if (!this.tonConnectUI || !this.tonConnectUI.connected || !(ME && ME.ton_address)) {
      toast(T('toast_connect_ton_req', 'Conecta tu TON Wallet primero.'));
      return this.openPaymentMethods();
    }
    payInFlight = true; syncClosingConfirmation();
    toast(T('toast_generating_tx'));
    try { await afterPayment(await B().payTon(String(slug), this.tonConnectUI)); }
    catch (e) { B().haptic('error'); toast(e.status ? errMsg(e) : T('toast_ton_tx_error')); }
    finally { payInFlight = false; syncClosingConfirmation(); }
  };

  // Firma legacy (precio/nivel venían del cliente): se ignoran y se usa el slug.
  app.rechargeAlphaCoins = function (_priceTon, _alphaTotal, level) { return this.buyPackageTon(SLUG_BY_LEVEL[Number(level)] || 'spy'); };

  // Hook de AppBridge.payStars en Standalone sin Telegram vinculado.
  app.openStandalonePayment = async function (slug) {
    const link = await UI().confirm('Para pagar con Telegram Stars vincula tu cuenta de Telegram. ¿Vincular ahora? (Cancelar = pagar con TON)');
    if (link) { try { await B().linkTelegram(); } catch (e) { toast(errMsg(e)); } return; }
    this.buyPackageTon(slug);
  };

  app.openExternalCheckout = function (slug) {
    if (!canUseExternalGateways()) { UI().alert(T('tma_external_disabled')); return; }
    return orig.openExternalCheckout.call(this, slug);
  };
  app.subscribeCreatorTier = function (tier) {
    if (!canUseExternalGateways()) { UI().alert(T('tma_external_disabled')); return; }
    return orig.subscribeCreatorTier.call(this, tier);
  };

  // ---------------------------------------------------------------- TON Connect con ton_proof
  async function refreshTonProof() {
    const ui = app.tonConnectUI;
    if (!ui || ui.connected || !ME || typeof ui.setConnectRequestParameters !== 'function') return;
    ui.setConnectRequestParameters({ state: 'loading' });
    try {
      const r = await Api().tonProofPayload();
      ui.setConnectRequestParameters({ state: 'ready', value: { tonProof: r.payload } });
    } catch (_) { ui.setConnectRequestParameters(null); }
  }

  app.initTonConnect = async function () {
    if (this.tonConnectUI) return this.tonConnectUI;
    const Cls = (global.TON_CONNECT_UI && global.TON_CONNECT_UI.TonConnectUI) || global.TonConnectUI;
    if (!Cls) return null;
    const actions = {};
    if (B().isTelegram()) actions.twaReturnUrl = 'https://t.me/' + CFG.botUsername + '/' + CFG.miniAppShortName;
    else if (B().platform().indexOf('capacitor') === 0) actions.returnStrategy = CFG.appScheme + '://tonconnect';
    else actions.returnStrategy = 'back';
    this.tonConnectUI = new Cls({ manifestUrl: CFG.tonManifestUrl, uiPreferences: { theme: 'DARK' }, actionsConfiguration: actions });
    try { if (this.tonConnectUI.connectionRestored) await this.tonConnectUI.connectionRestored; } catch (_) {}
    await refreshTonProof();

    this.tonConnectUI.onStatusChange(async (wallet) => {
      const hdr = $('btn-wallet-hdr');
      if (wallet && wallet.account) {
        const addr = wallet.account.address;
        if (hdr) hdr.textContent = addr.slice(0, 4) + '…' + addr.slice(-4);
        const tp = wallet.connectItems && wallet.connectItems.tonProof;
        if (tp && 'proof' in tp) {
          try {
            await Api().linkTonWallet({
              address: addr, network: wallet.account.chain, public_key: wallet.account.publicKey,
              wallet_state_init: wallet.account.walletStateInit, proof: tp.proof,
            });
            applyMe(await B().getUser(true));
            toast(T('toast_wallet_linked', 'Billetera vinculada'));
          } catch (e) {
            toast(T('toast_wallet_proof_failed', 'No se pudo verificar la billetera'));
            try { await app.tonConnectUI.disconnect(); } catch (_) {}
          }
        } else if (tp && 'error' in tp) {
          toast(T('toast_wallet_proof_failed', 'No se pudo verificar la billetera'));
        }
      } else {
        if (hdr) hdr.textContent = T('btn_wallet', 'WALLET');
        refreshTonProof();   // el payload es de un solo uso
      }
      app.updateProfileUI();
    });
    return this.tonConnectUI;
  };

  app.connectWallet = async function () {
    this.haptic('medium');
    await this.initTonConnect();
    if (!this.tonConnectUI) { toast(T('toast_ton_not_loaded')); return; }
    if (this.tonConnectUI.connected) {
      if (await UI().confirm(T('confirm_disconnect_wallet', '¿Desconectar billetera?'))) await this.tonConnectUI.disconnect();
    } else {
      await refreshTonProof();
      await this.tonConnectUI.openModal();
    }
  };

  // ==================================================================== 7. propinas
  app.loadTipMenu = async function (creatorId) {
    try { return await Api().tipMenu(creatorId || (ME && ME.id)); } catch (_) { return []; }
  };

  app.saveAllTipSlots = async function () {
    this.haptic('heavy');
    const slots = [];
    for (let i = 1; i <= 10; i++) {
      const title = ($('tip-title-' + i) || {}).value || '';
      const price = parseInt(($('tip-price-' + i) || {}).value || '0', 10);
      if (title.trim() && price > 0) slots.push({ slot_number: i, title: title.trim().slice(0, 80), price_alpha: price });
    }
    toast(T('toast_tip_saving'));
    try {
      await Api().saveTipMenu(slots);
      toast(T('toast_tip_saved').replace('{count}', slots.length));
      this.closeModals();
    } catch (e) { toast(errMsg(e)); }
  };

  app.openFanTipMenu = async function (creatorId, postId, creatorName) {
    this.closeModals();
    const cid = String(creatorId || '');
    if (!/^\d+$/.test(cid)) return;
    let modal = $('modal-fan-tip-menu');
    if (!modal) {
      doc.body.insertAdjacentHTML('beforeend',
        '<div id="modal-fan-tip-menu" class="fixed inset-0 z-[96] flex items-center justify-center bg-black bg-opacity-95 backdrop-blur-md hidden">' +
        '<div class="bg-neutral-900 border-2 border-[#ffb703] rounded-3xl p-6 w-11/12 max-w-lg max-h-[85vh] flex flex-col">' +
        '<div class="flex items-center justify-between mb-4 pb-3 border-b border-[#ffb703]/30"><h3 class="text-xl font-black text-[#ffb703] uppercase tracking-wider"><i class="fa-solid fa-coins mr-2"></i> TIP MENU</h3>' +
        '<button onclick="app.closeModals()" class="text-neutral-400 hover:text-white font-bold p-1"><i class="fa-solid fa-times text-xl"></i></button></div>' +
        '<p class="text-center font-bold text-white mb-4 uppercase tracking-widest text-sm"><span id="fan-tip-support-label"></span> <span id="fan-tip-creator-name" class="text-[#00f3ff]"></span></p>' +
        '<div id="fan-tip-slots-container" class="overflow-y-auto space-y-3 mb-4 max-h-40"></div>' +
        '<div class="bg-black/50 border border-[#ffb703]/40 rounded-2xl p-4 mb-2"><h4 class="text-[10px] text-[#ffb703] font-black uppercase mb-2" id="fan-tip-custom-title"></h4>' +
        '<textarea id="fan-tip-message" rows="2" maxlength="280" class="w-full bg-black border border-neutral-700 rounded-xl px-3 py-2 text-xs text-white outline-none mb-3 resize-none"></textarea>' +
        '<div class="flex gap-2"><input type="number" id="fan-tip-amount" min="1" class="flex-1 bg-black border border-neutral-700 rounded-xl px-3 py-2.5 text-sm font-black text-white outline-none">' +
        '<button id="btn-fan-tip-send" data-act="tip-custom" class="bg-gradient-to-r from-amber-500 to-yellow-600 text-black font-black px-4 py-2.5 rounded-xl uppercase text-xs"></button></div></div>' +
        '<button onclick="app.closeModals()" id="btn-fan-tip-back" class="w-full bg-neutral-800 border border-neutral-600 text-white py-3 rounded-xl text-sm font-black uppercase mt-3"></button>' +
        '</div></div>');
      modal = $('modal-fan-tip-menu');
    }
    $('fan-tip-support-label').textContent = T('txt_support_creator', 'Apoya a');
    $('fan-tip-creator-name').textContent = '@' + (creatorName || 'creator');
    $('fan-tip-custom-title').textContent = T('tip_custom_title');
    $('fan-tip-message').placeholder = T('tip_msg_placeholder');
    $('fan-tip-amount').placeholder = T('tip_amount_placeholder');
    $('btn-fan-tip-back').textContent = T('btn_back', 'Volver');
    const send = $('btn-fan-tip-send');
    send.textContent = T('btn_send_tip', 'Enviar');
    send.dataset.cid = cid;
    send.dataset.pid = postId ? String(Number(postId)) : '';
    modal.classList.remove('hidden');

    const box = $('fan-tip-slots-container');
    box.innerHTML = '<div class="text-center text-neutral-400 mt-4 font-bold text-xs">' + esc(T('msg_loading')) + '</div>';
    const slots = await this.loadTipMenu(cid);
    box.innerHTML = slots.map((s) =>
      '<button data-act="tip-slot" data-cid="' + esc(cid) + '" data-amount="' + Number(s.price_alpha) + '" data-pid="' + (postId ? Number(postId) : '') + '" data-msg="' + esc(s.title) + '" ' +
      'class="w-full bg-black border border-[#ffb703]/50 hover:bg-[#ffb703]/20 rounded-2xl p-3 flex justify-between items-center text-white">' +
      '<span class="font-bold text-xs text-left truncate pr-2">' + esc(s.title) + '</span>' +
      '<span class="bg-gradient-to-r from-amber-500 to-yellow-600 text-black text-xs font-black px-2 py-1 rounded-lg whitespace-nowrap">' + Number(s.price_alpha) + ' $ALPHA</span></button>').join('');
  };

  async function doTip(creatorId, amount, postId, message) {
    const amt = parseInt(amount, 10);
    if (!Number.isInteger(amt) || amt <= 0) { toast('⚠️ Ingresa una cantidad válida de $ALPHA.'); return false; }
    if (ME && String(creatorId) === String(ME.id)) { toast('⚠️ No puedes enviarte propinas a ti mismo.'); return false; }
    app.haptic('heavy');
    try {
      await Api().tip(creatorId, amt, postId, message);
      B().haptic('success');
      toast(T('toast_tip_sent', '¡Propina enviada!'));
      app.closeModals();
      app.refreshUserData();
      return true;
    } catch (e) {
      B().haptic('error');
      toast(errMsg(e));
      if (e.status === 402) app.openCatalogPackages();
      return false;
    }
  }

  app.sendCustomTip = function () {
    const btn = $('btn-fan-tip-send');
    const amount = ($('fan-tip-amount') || {}).value;
    const msg = (($('fan-tip-message') || {}).value || '').trim().slice(0, 280);
    return doTip(btn.dataset.cid, amount, btn.dataset.pid ? Number(btn.dataset.pid) : null, msg || null);
  };
  app.sendTipFromPost = function (creatorId, amount, postId, message) { return doTip(creatorId, amount, postId, message || null); };

  app.sendLiveTip = function (streamerId, amount) {
    const amt = parseInt(amount, 10);
    if (!streamerId || !(amt > 0)) return;
    this.haptic('heavy');
    if (Chat().sendGlobal({ type: 'live_tip', target_id: Number(streamerId), amount: amt, client_ref: Api().uuid() })) toast('¡Propina emitida en directo! 🪙');
    else toast('⚠️ Conexión de sala inactiva.');
  };

  // ==================================================================== 8. feed y posts
  function likedCache() { try { return JSON.parse(getLS('alpha_user_liked_posts') || '[]'); } catch (_) { return []; } }
  function blockedCache() { try { return JSON.parse(getLS('alpha_user_blocked') || '[]'); } catch (_) { return []; } }

  function mediaKind(p, url) {
    if (p.media_type) return p.media_type;
    if (/^data:video|\.(mp4|webm|mov)(\?|#|$)/i.test(url)) return 'video';
    if (/^data:audio|\.(mp3|wav|ogg|m4a)(\?|#|$)/i.test(url)) return 'audio';
    return 'image';
  }

  function postCardHTML(post, compact) {
    const pid = Number(post.id);
    const creatorId = String(post.creator_id || post.user_id || '');
    const author = post.author || post.author_name || 'creator';
    const locked = !!post.is_locked;
    const price = Number(post.price_alpha || 0);
    const isOwner = ME && (String(ME.id) === creatorId || ME.role === 'admin');
    const liked = !!post.liked_by_me || likedCache().indexOf(pid) >= 0;
    const rank = app.getRankBadge(Number(post.level_required != null ? post.level_required : (post.levelRequired || 0)));
    const maxH = compact ? 'max-h-48' : 'max-h-80';
    const avatar = app.sanitizeUrl(post.author_avatar);

    let media = '';
    if (locked) {
      // El servidor NUNCA debe enviar media_url de un post bloqueado: solo preview_url desenfocado.
      const prev = app.sanitizeUrl(post.preview_url);
      const action = price > 0
        ? '<button data-act="unlock" data-pid="' + pid + '" data-price="' + price + '" class="bg-amber-500 hover:bg-amber-400 text-black font-black py-2.5 px-5 rounded-xl text-xs uppercase tracking-wider"><i class="fa-solid fa-key mr-1"></i> ' + esc(T('btn_unlock', 'Desbloquear')) + ' (' + price + ' $ALPHA)</button>'
        : '<button data-act="catalog" class="bg-[#00f3ff] text-black font-black py-2.5 px-5 rounded-xl text-xs uppercase">' + esc(rank.name) + '</button>';
      media = '<div class="relative w-full flex justify-center mb-3">' +
        (prev ? '<img src="' + esc(prev) + '" alt="" class="rounded-xl w-full ' + maxH + ' object-cover blur-xl grayscale opacity-50 pointer-events-none select-none">' : '<div class="w-full h-40 rounded-xl bg-black/60 border border-amber-500/30"></div>') +
        '<div class="absolute inset-0 flex flex-col items-center justify-center z-10 p-4 text-center"><i class="fa-solid fa-lock text-4xl text-amber-400 mb-2"></i>' +
        '<span class="text-[10px] font-black text-white bg-black/80 px-3 py-1.5 rounded-full mb-3 border border-amber-500/50 uppercase tracking-widest">' + esc(T('txt_protected_content')) + '</span>' + action + '</div></div>';
    } else if (post.media_url) {
      const url = app.sanitizeUrl(post.media_url);
      const kind = url ? mediaKind(post, url) : null;
      if (kind === 'video') media = '<div class="mb-3 flex justify-center"><video src="' + esc(url) + '" class="rounded-xl w-full ' + maxH + ' object-cover" controls playsinline preload="metadata"></video></div>';
      else if (kind === 'audio') media = '<div class="mb-3"><audio src="' + esc(url) + '" controls class="w-full h-12" preload="none"></audio></div>';
      else if (kind === 'image') media = '<div class="relative cursor-pointer mb-3 flex justify-center" data-act="lightbox" data-url="' + esc(url) + '" data-kind="image"><img src="' + esc(url) + '" loading="lazy" alt="" class="rounded-xl ' + maxH + ' object-cover"></div>';
    }

    const text = locked ? (post.teaser || '') : (post.content || '');
    const textHTML = text ? '<p class="text-sm text-neutral-200 mb-3" style="word-break:break-word">' + esc(text) + '</p>' : '';

    const footer = locked
      ? '<div class="flex items-center justify-between pt-2 border-t border-neutral-800 opacity-40 pointer-events-none"><span class="text-xs"><i class="fa-solid fa-heart"></i> ' + Number(post.likes_count || 0) + '</span></div>'
      : '<div class="flex items-center justify-between pt-2 border-t border-neutral-800">' +
        '<button data-act="like" data-pid="' + pid + '" class="ab-like flex items-center gap-1 text-xs font-semibold py-1 px-2.5 rounded-lg border transition-all ' + (liked ? 'is-liked bg-[#ff00ff]/20 border-[#ff00ff] text-[#ff00ff]' : 'border-neutral-700 text-neutral-400') + '"><i class="fa-solid fa-heart"></i> <span class="ab-like-count">' + Number(post.likes_count || 0) + '</span></button>' +
        (creatorId && (!ME || String(ME.id) !== creatorId) ? '<button data-act="tip-menu" data-cid="' + esc(creatorId) + '" data-pid="' + pid + '" data-name="' + esc(author) + '" class="bg-amber-500 hover:bg-amber-400 text-black font-bold py-1.5 px-3 rounded-lg text-xs">🪙 Tip</button>' : '') +
        '</div>';

    if (compact) return '<div class="bg-black border border-neutral-800 rounded-xl p-3 text-white text-xs space-y-2" id="post-c-' + pid + '">' + textHTML + media + footer + '</div>';

    return '<div class="post-card bg-neutral-900 border border-neutral-800 rounded-2xl p-4 mb-4 shadow-lg text-white" id="post-' + pid + '">' +
      '<div class="flex items-center justify-between mb-2"><div class="flex items-center gap-2.5 cursor-pointer" data-act="profile" data-uid="' + esc(creatorId) + '" data-name="' + esc(author) + '">' +
      '<div class="relative w-10 h-10 rounded-full border border-[#00f3ff] overflow-hidden bg-black flex items-center justify-center">' +
      (avatar ? '<img src="' + esc(avatar) + '" alt="" class="w-full h-full object-cover">' : '<i class="fa-solid fa-user text-xs text-[#00f3ff]"></i>') +
      (post.is_online ? '<div class="absolute -bottom-0.5 -right-0.5 w-3 h-3 bg-emerald-500 rounded-full border-2 border-black"></div>' : '') + '</div>' +
      '<div class="flex flex-col"><span class="font-bold text-amber-400 text-sm">@' + esc(author) + '</span>' +
      '<span class="text-[9px] ' + (post.is_online ? 'text-emerald-400 font-bold' : 'text-neutral-500') + '">' + (post.is_online ? '● ONLINE' : '○ OFFLINE') + '</span></div></div>' +
      '<div class="flex items-center gap-2 bg-black/50 px-2 py-1 rounded-lg"><span class="text-[10px] font-black uppercase text-neutral-400">' + esc(rank.name) + '</span>' +
      (isOwner ? '<button data-act="delete-post" data-pid="' + pid + '" class="text-neutral-500 hover:text-red-400 p-1 ml-2"><i class="fa-solid fa-trash-can text-sm"></i></button>' : '') +
      '</div></div>' + textHTML + media + footer + '</div>';
  }

  app.buildFeedHTML = function (posts, container) {
    const blocked = blockedCache();
    const visible = (posts || []).filter((p) => blocked.indexOf(String(p.creator_id || p.user_id)) < 0);
    if (!visible.length) { container.innerHTML = '<div class="bg-neutral-900 border border-neutral-800 rounded-2xl p-6 text-center text-neutral-400 font-bold">' + esc(T('msg_no_posts')) + '</div>'; return; }
    container.innerHTML = visible.map((p) => postCardHTML(p, false)).join('');
  };

  app.renderFeed = async function () {
    const box = $('feed-container');
    if (!box) return;
    // Caché de sesión (no localStorage): no deja contenido de pago persistido en el dispositivo.
    try { const c = global.sessionStorage.getItem('alpha_feed'); if (c) this.buildFeedHTML(JSON.parse(c), box); } catch (_) {}
    try {
      const posts = await Api().feed();
      try { global.sessionStorage.setItem('alpha_feed', JSON.stringify(posts)); } catch (_) {}
      this.buildFeedHTML(posts, box);
    } catch (e) { if (e.status !== 401) toast(errMsg(e)); }
  };

  app.toggleLike = async function (postId) {
    this.haptic('light');
    const pid = Number(postId);
    const btns = doc.querySelectorAll('[data-act="like"][data-pid="' + pid + '"]');
    const liking = !(btns[0] && btns[0].classList.contains('is-liked'));
    const paint = (on) => btns.forEach((b) => {
      const c = b.querySelector('.ab-like-count');
      if (c) c.textContent = String(Math.max(0, (parseInt(c.textContent, 10) || 0) + (on ? 1 : -1)));
      b.classList.toggle('is-liked', on);
      ['bg-[#ff00ff]/20', 'border-[#ff00ff]', 'text-[#ff00ff]'].forEach((k) => b.classList.toggle(k, on));
      ['border-neutral-700', 'text-neutral-400'].forEach((k) => b.classList.toggle(k, !on));
    });
    paint(liking);
    let cache = likedCache().filter((x) => x !== pid);
    if (liking) cache.push(pid);
    setLS('alpha_user_liked_posts', JSON.stringify(cache.slice(-500)));
    try { await Api().likePost(pid, liking); }
    catch (e) { paint(!liking); toast(errMsg(e)); }
  };

  app.unlockPostContent = async function (postId, price) {
    if (!(await UI().confirm('¿Desbloquear por ' + Number(price) + ' $ALPHA?'))) return;
    try {
      await Api().unlockPost(postId);
      B().haptic('success');
      await this.refreshUserData();
      await this.renderFeed();
    } catch (e) {
      B().haptic('error');
      toast(errMsg(e));
      if (e.status === 402) this.openCatalogPackages();
    }
  };

  app.publishPost = async function () {
    this.haptic('medium');
    const content = (($('admin-text-es') || {}).value || '').trim();
    const level = parseInt(($('admin-level') || {}).value || '0', 10) || 0;
    const price = parseInt(($('admin-price') || {}).value || '0', 10) || 0;
    if (!content && !this.tempPostMedia) return;
    try {
      let mediaId = null;
      if (this.tempPostMedia) { toast(T('toast_uploading', 'Subiendo…')); mediaId = (await Api().uploadMedia(this.tempPostMedia, 'post')).media_id; }
      await Api().createPost({ text: content, media_id: mediaId, level_required: level, price_alpha: price });
      this.tempPostMedia = null;
      const ta = $('admin-text-es'); if (ta) ta.value = '';
      this.switchView('feed');
      await this.renderFeed();
    } catch (e) {
      if (e.status === 403) this.openKYCModal();
      toast(errMsg(e));
    }
  };

  app.deletePost = async function (postId) {
    if (!(await UI().confirm(T('confirm_delete_post', '¿Eliminar publicación?')))) return;
    try { await Api().deletePost(postId); this.renderFeed(); } catch (e) { toast(errMsg(e)); }
  };

  // ==================================================================== 9. perfiles de creador
  app.viewCreatorProfile = async function (userId, userName) {
    const uid = String(userId || '');
    if (!/^\d+$/.test(uid)) return;
    this.closeModals();
    this.haptic('light');
    let modal = $('modal-creator-profile');
    if (!modal || !modal.dataset.secure) {
      if (modal) modal.remove();
      doc.body.insertAdjacentHTML('beforeend',
        '<div id="modal-creator-profile" data-secure="1" class="hidden fixed inset-0 z-[250] flex items-center justify-center bg-black bg-opacity-95 backdrop-blur-md">' +
        '<div class="bg-neutral-900 border-2 border-[#00f3ff] rounded-3xl p-6 w-11/12 max-w-md h-[85vh] flex flex-col relative">' +
        '<button onclick="app.closeModals()" class="absolute top-4 right-4 text-neutral-400 hover:text-white font-bold p-1 z-10"><i class="fa-solid fa-times text-xl"></i></button>' +
        '<button id="cp-block" data-act="block" class="absolute top-4 left-4 text-red-400 text-xs font-black z-10"><i class="fa-solid fa-ban"></i></button>' +
        '<div class="flex flex-col items-center text-center mb-3 shrink-0 mt-2">' +
        '<div class="relative w-20 h-20 rounded-full border-2 border-[#00f3ff] overflow-hidden bg-black mb-2 flex items-center justify-center">' +
        '<img id="cp-avatar" alt="" class="w-full h-full object-cover hidden"><i id="cp-avatar-icon" class="fa-solid fa-user text-2xl text-[#00f3ff]"></i></div>' +
        '<h3 id="cp-name" class="text-xl font-black text-white uppercase tracking-wider truncate w-full px-4"></h3>' +
        '<span id="cp-status" class="text-[10px] font-bold mt-1 px-2.5 py-0.5 rounded-full border"></span></div>' +
        '<div id="cp-bio" class="text-xs text-neutral-300 bg-black/50 border border-neutral-800 rounded-xl p-3 mb-3 text-center shrink-0" style="word-break:break-word"></div>' +
        '<div class="flex gap-2 mb-3 shrink-0"><button id="cp-tip" data-act="tip-menu" class="flex-1 bg-amber-500 text-black font-black py-3 rounded-xl text-xs uppercase"><i class="fa-solid fa-coins"></i> Tip</button>' +
        '<button id="cp-chat" data-act="creator-chat" class="flex-1 bg-[#00f3ff] text-black font-black py-3 rounded-xl text-xs uppercase"><i class="fa-solid fa-comments"></i> Chat</button></div>' +
        '<button id="cp-follow" data-act="follow" class="w-full mb-3 font-black py-3 rounded-xl text-xs uppercase shrink-0"></button>' +
        '<h4 id="cp-posts-title" class="text-xs font-black text-[#00f3ff] uppercase tracking-widest mb-2 shrink-0"></h4>' +
        '<div id="cp-posts" class="flex-1 overflow-y-auto space-y-3 pr-2 pb-6"></div></div></div>');
      modal = $('modal-creator-profile');
    }
    const self = ME && String(ME.id) === uid;
    const name = String(userName || 'Usuario');
    ['cp-block', 'cp-tip', 'cp-chat', 'cp-follow'].forEach((id) => { const el = $(id); el.dataset.uid = uid; el.dataset.cid = uid; el.dataset.name = name; el.classList.toggle('hidden', !!self); });
    $('cp-name').textContent = '@' + name;
    $('cp-bio').textContent = T('loading_bio');
    $('cp-posts-title').textContent = T('creator_posts_title');
    $('cp-posts').innerHTML = '<div class="text-center text-neutral-500 text-xs py-4">' + esc(T('loading_posts')) + '</div>';
    $('cp-avatar').classList.add('hidden');
    $('cp-avatar-icon').style.display = '';
    setFollowBtn(false);
    setStatus(false);
    modal.classList.remove('hidden');

    try {
      const p = await Api().userProfile(uid);
      if (p.display_name) $('cp-name').textContent = '@' + p.display_name;
      $('cp-bio').textContent = p.bio || T('ecosystem_operative');
      const av = app.sanitizeUrl(p.avatar_url);
      if (av) { $('cp-avatar').src = av; $('cp-avatar').classList.remove('hidden'); $('cp-avatar-icon').style.display = 'none'; }
      setStatus(!!p.is_online);
      setFollowBtn(!!p.is_following);
    } catch (_) { $('cp-bio').textContent = T('ecosystem_operative'); }

    try {
      const posts = await Api().userPosts(uid);
      $('cp-posts').innerHTML = posts.length ? posts.map((x) => postCardHTML(x, true)).join('')
        : '<div class="text-center text-neutral-500 text-xs py-4 bg-black/40 rounded-xl">' + esc(T('msg_no_posts')) + '</div>';
    } catch (_) { $('cp-posts').innerHTML = '<div class="text-center text-red-400 text-xs py-4">' + esc(T('msg_no_posts')) + '</div>'; }
  };

  function setStatus(online) {
    const s = $('cp-status');
    if (!s) return;
    s.textContent = online ? '● ONLINE' : '○ OFFLINE';
    s.className = online ? 'text-[10px] font-bold mt-1 px-2.5 py-0.5 rounded-full border border-emerald-500/30 text-emerald-400 bg-emerald-500/10'
      : 'text-[10px] font-bold mt-1 px-2.5 py-0.5 rounded-full border border-neutral-700 text-neutral-400 bg-neutral-800';
  }

  function setFollowBtn(following) {
    const b = $('cp-follow') || $('btn-profile-follow');
    if (!b) return;
    b.dataset.following = following ? '1' : '';
    b.innerHTML = '<i class="fa-solid ' + (following ? 'fa-user-check' : 'fa-user-plus') + '"></i> ' + esc(following ? T('btn_following', 'Siguiendo') : T('btn_follow', 'Seguir'));
    b.className = (b.className.indexOf('hidden') >= 0 ? 'hidden ' : '') + 'w-full mb-3 font-black py-3 rounded-xl text-xs uppercase shrink-0 ' +
      (following ? 'bg-neutral-800 border border-neutral-600 text-white' : 'bg-[#ff00ff] text-black');
  }

  app.toggleFollow = async function (targetId) {
    this.haptic('medium');
    try {
      const r = await Api().toggleFollow(targetId);
      setFollowBtn(!!r.following);
      if (r.message) toast(r.message);
    } catch (e) { toast(errMsg(e)); }
  };

  app.blockUser = async function (targetId, targetName) {
    this.haptic('heavy');
    if (!(await UI().confirm(T('confirm_block').replace('{name}', targetName || '')))) return;
    try {
      await Api().blockUser(targetId);
      const list = blockedCache(); if (list.indexOf(String(targetId)) < 0) list.push(String(targetId));
      setLS('alpha_user_blocked', JSON.stringify(list));
      toast(T('user_blocked').replace('{name}', targetName || ''));
      this.closeModals();
      this.renderFeed();
    } catch (e) { toast(errMsg(e)); }
  };

  // ==================================================================== 10. chat (DM y salas)
  const SIGNAL_MSG_TYPES = ['radar_update', 'leave_video', 'join_video', 'online_count_update', 'presence', 'video_peers', 'go_live', 'stop_live'];

  function parseContent(msg) {
    let text = msg.text != null ? msg.text : '';
    let media = msg.media_url || null;
    const c = msg.content;
    if (c && typeof c === 'object') { text = c.text || text; media = c.media_url || media; }
    else if (typeof c === 'string' && !text) {
      const s = c.trim();
      if (s.charAt(0) === '{') { try { const o = JSON.parse(s); if (o && o.type) return null; text = o.text || ''; media = o.media_url || media; } catch (_) { text = c; } }
      else text = c;
    }
    return { text: String(text || ''), media };
  }

  app.appendChatMessage = function (msg, containerId) {
    const box = $(containerId);
    if (!box || !msg) return;
    if (msg.type && (msg.type.indexOf('webrtc_') === 0 || SIGNAL_MSG_TYPES.indexOf(msg.type) >= 0)) return;
    const parsed = parseContent(msg);
    if (!parsed) return;
    const mid = Number(msg.id) || 0;
    if (mid && box.querySelector('[data-msg-id="' + mid + '"]')) return;   // dedupe (historial + eco del socket)
    const isMe = ME && String(msg.user_id) === String(ME.id);
    const canDelete = isMe || this.isAdminUser();
    const rank = this.getRankBadge(Number(msg.access_level || 0));

    if (msg.is_system) {
      const sys = doc.createElement('div');
      sys.className = 'flex flex-col items-center my-2';
      sys.innerHTML = '<div class="bg-amber-500/20 border border-amber-500/50 text-amber-400 text-[10px] px-4 py-1.5 rounded-full font-black text-center"><i class="fa-solid fa-bolt mr-1"></i> <span></span></div>';
      sys.querySelector('span').textContent = parsed.text;
      box.appendChild(sys);
      setTimeout(() => sys.remove(), 5000);
      return;
    }

    let mediaHTML = '';
    const url = parsed.media ? this.sanitizeUrl(parsed.media) : '';
    if (url) {
      const kind = mediaKind(msg, url);
      if (kind === 'video') mediaHTML = '<video src="' + esc(url) + '" class="rounded-xl max-h-48 mt-2 mx-auto block" controls playsinline preload="metadata"></video>';
      else if (kind === 'audio') mediaHTML = '<audio src="' + esc(url) + '" controls class="w-full h-10 mt-2" preload="none"></audio>';
      else mediaHTML = '<img src="' + esc(url) + '" alt="" loading="lazy" data-act="lightbox" data-url="' + esc(url) + '" data-kind="image" class="rounded-xl max-h-48 mt-2 mx-auto block cursor-pointer">';
    }
    const menu = mid ? '<div class="ab-msg-menu"><button data-act="msg-menu" class="ab-msg-menu-btn"><i class="fa-solid fa-ellipsis-vertical"></i></button>' +
      '<div class="ab-msg-menu-list hidden">' +
      (canDelete ? '<button data-act="msg-delete" data-mid="' + mid + '" class="text-red-400">' + esc(T('btn_delete', 'Eliminar')) + '</button>' : '') +
      (!isMe ? '<button data-act="msg-report" data-mid="' + mid + '">Reportar</button>' : '') + '</div></div>' : '';
    const read = isMe ? (msg.is_read ? '<span class="text-[9px] text-cyan-400 font-bold ml-1.5 msg-status-indicator" title="Leído">R</span>' : '<span class="text-[9px] text-neutral-400 ml-1.5 msg-status-indicator" title="Enviado">✓</span>') : '';
    const body = '<span class="ab-msg-text"></span>' + mediaHTML + read;

    const wrap = doc.createElement('div');
    if (mid) wrap.setAttribute('data-msg-id', String(mid));
    if (isMe) {
      wrap.className = 'flex flex-col items-end my-2';
      wrap.innerHTML = '<span class="text-[9px] text-neutral-500 mb-1 font-bold mr-1">' + esc(T('txt_you', 'Tú')) + ' • ' + esc(rank.name) + '</span>' +
        '<div class="relative bg-[#00f3ff]/20 text-white text-sm p-3 rounded-2xl border border-[#00f3ff]/50 max-w-[85%]" style="word-break:break-word">' + menu + body + '</div>';
    } else {
      wrap.className = 'flex flex-col items-start my-2';
      wrap.innerHTML = '<span class="text-[9px] text-neutral-500 mb-1 font-bold ml-1"><span class="text-[#00f3ff] font-black cursor-pointer" data-act="profile" data-uid="' + esc(msg.user_id) + '" data-name="' + esc(msg.author_name || '') + '">@' + esc(msg.author_name || msg.user_id) + '</span> • ' + esc(rank.name) + '</span>' +
        '<div class="relative bg-neutral-800 text-white text-sm p-3 rounded-2xl border border-neutral-700 max-w-[85%]" style="word-break:break-word">' + menu + body + '</div>';
    }
    wrap.querySelector('.ab-msg-text').textContent = parsed.text;
    box.appendChild(wrap);
  };

  app.loadConversations = async function () {
    const inbox = $('dm-inbox-view'), chat = $('dm-chat-view'), back = $('dm-back-btn'), title = $('crm-chat-title');
    if (chat) chat.classList.add('hidden');
    if (inbox) inbox.classList.remove('hidden');
    if (back) back.classList.add('hidden');
    if (title) title.textContent = 'DMs (MENSAJES DIRECTOS)';
    if (!inbox) return;
    inbox.innerHTML = '<div class="text-center text-neutral-400 text-xs py-10 font-bold">' + esc(T('loading_conversations')) + '</div>';
    try {
      const list = await Api().conversations();
      if (!list.length) { inbox.innerHTML = '<div class="text-center text-neutral-500 text-xs py-12">' + esc(T('no_active_chats')) + '</div>'; return; }
      inbox.innerHTML = list.map((c) => {
        const av = this.sanitizeUrl(c.avatar_url);
        const prev = c.last_message_preview || (c.last_has_media ? '📎 Archivo adjunto' : '');
        return '<div data-act="open-dm" data-uid="' + esc(c.user_id) + '" data-name="' + esc(c.name) + '" class="bg-neutral-900 border border-neutral-800 hover:border-[#00f3ff]/50 rounded-2xl p-3.5 flex items-center justify-between cursor-pointer">' +
          '<div class="flex items-center gap-3 min-w-0"><div class="relative w-12 h-12 rounded-full border border-[#00f3ff] overflow-hidden bg-black flex items-center justify-center shrink-0">' +
          (av ? '<img src="' + esc(av) + '" alt="" class="w-full h-full object-cover">' : '<i class="fa-solid fa-user text-xs text-[#00f3ff]"></i>') +
          (c.is_online ? '<div class="absolute bottom-0 right-0 w-3 h-3 bg-emerald-500 rounded-full border-2 border-black"></div>' : '') + '</div>' +
          '<div class="flex flex-col min-w-0"><span class="font-black text-white text-sm truncate">@' + esc(c.name) + '</span>' +
          '<span class="text-xs text-neutral-400 truncate max-w-[180px]">' + esc(prev) + '</span></div></div>' +
          '<div class="flex flex-col items-end gap-1 shrink-0"><span class="text-[9px] text-neutral-500">' + esc(c.last_time ? new Date(c.last_time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '') + '</span>' +
          (Number(c.unread_count) > 0 ? '<span class="bg-[#ff00ff] text-black font-black text-[10px] px-2 py-0.5 rounded-full">' + Number(c.unread_count) + '</span>' : '') + '</div></div>';
      }).join('');
    } catch (_) { inbox.innerHTML = '<div class="text-center text-red-400 text-xs py-10">Error al cargar la bandeja de entrada.</div>'; }
  };

  app.loadConversation = async function (targetId, targetName) {
    await orig.loadConversation.call(this, targetId, targetName);
    const title = $('crm-chat-title'); if (title) title.textContent = 'CHAT CON @' + (targetName || '');
    this.loadDmHistory(targetId);
  };

  app.loadDmHistory = async function (otherId) {
    const box = $('chat-messages');
    if (!box || !/^\d+$/.test(String(otherId))) return;
    try {
      const msgs = await Api().dmHistory(otherId);
      box.textContent = '';
      msgs.forEach((m) => this.appendChatMessage(m, 'chat-messages'));
      this.scrollToBottom('chat-messages');
    } catch (_) {}
  };

  app.openDirectChat = function (targetId, targetName) {
    if (!targetId || !/^\d+$/.test(String(targetId))) { toast('Abre su perfil para escribirle.'); return; }
    return orig.openDirectChat.call(this, targetId, targetName);
  };

  async function mediaPayload() {
    if (!app.tempChatMediaData) return {};
    toast(T('toast_uploading', 'Subiendo…'));
    const m = await Api().uploadMedia(app.tempChatMediaData, 'chat');
    return { media_id: m.media_id, media_url: m.url };
  }

  let sending = false;
  app.sendChatMessage = async function () {
    if (sending) return;
    const input = $('chat-input');
    const text = input ? input.value.trim().slice(0, 2000) : '';
    if (!text && !this.tempChatMediaData) return;
    sending = true;
    try {
      const media = await mediaPayload();
      if (Chat().sendCRM(Object.assign({ text }, media))) { if (input) input.value = ''; this.clearChatMedia('crm'); this.haptic('light'); }
    } catch (_) { toast(T('toast_upload_error', 'Error al subir')); }
    finally { sending = false; }
  };

  app.sendGlobalChatMessage = async function () {
    if (sending) return;
    const input = $('global-chat-input');
    const text = input ? input.value.trim().slice(0, 2000) : '';
    if (!text && !this.tempChatMediaData) return;
    if (!Chat().text) Chat().initGlobal(null, null, this.currentRoomId || 'bunker_main');
    sending = true;
    try {
      const media = await mediaPayload();
      if (Chat().sendGlobal(Object.assign({ text }, media))) { if (input) input.value = ''; this.clearChatMedia('global'); this.haptic('light'); }
    } catch (_) { toast(T('toast_upload_error', 'Error al subir')); }
    finally { sending = false; }
  };

  app.deleteChatMessage = async function (_legacyId, btn, realId) {
    if (!realId) return;
    if (!(await UI().confirm(T('confirm_delete_chat', '¿Eliminar mensaje?')))) return;
    try {
      await Api().deleteMessage(realId);
      const row = doc.querySelector('[data-msg-id="' + Number(realId) + '"]');
      if (row) row.remove();
      toast(T('toast_chat_deleted'));
    } catch (e) { toast(errMsg(e)); }
  };

  app.reportChatMessage = async function (msgId) {
    try { await Api().reportMessage(msgId); toast(T('toast_chat_reported', 'Reportado')); } catch (e) { toast(errMsg(e)); }
  };

  function tierAllows(min) { return app.isAdminUser() || Number(app.userData.access_tier || 0) >= Number(min || 0); }

  function prepareRoomModal(title, subtitle) {
    const t = $('global-chat-title');
    if (t) {
      t.textContent = String(title || '').toUpperCase();
      const sub = t.nextElementSibling;
      if (sub && sub.tagName === 'P') { sub.innerHTML = '<i class="fa-solid fa-circle text-[4px] animate-pulse"></i> '; sub.appendChild(doc.createTextNode(subtitle)); }
    }
  }

  app.openRoomChat = function (roomId, roomName, minLevel) {
    this.haptic('medium');
    if (!tierAllows(minLevel)) { toast('⚠️ Esta sala requiere rango superior (Nivel ' + Number(minLevel) + ').'); return this.openCatalogPackages(); }
    this.closeModals();
    this.currentRoomId = roomId;
    prepareRoomModal(roomName, 'SALA PRIVADA AISLADA');
    const m = $('modal-global-chat'); if (m) m.classList.remove('hidden');
    this.setupSystemMessageObserver('global-chat-messages');
    Chat().initGlobal(null, null, roomId, roomName);
  };

  app.openGlobalChat = function () {
    this.closeModals();
    this.currentRoomId = 'bunker_main';
    prepareRoomModal(T('wall_chat_title', 'CHAT GLOBAL'), 'Búnker Live');
    const m = $('modal-global-chat'); if (m) m.classList.remove('hidden');
    this.setupSystemMessageObserver('global-chat-messages');
    Chat().initGlobal(null, null, 'bunker_main');
  };

  app.loadGlobalChatHistory = function () { return Promise.resolve(); };   // lo hace chat_v2 al conectar

  // ==================================================================== 11. video (delegado a RoomVideo)
  app.joinVideoRoom = async function (roomId, minLevel, roomName) {
    this.haptic('medium');
    if (!tierAllows(Math.max(1, Number(minLevel || 0)))) { toast(T('toast_tier_req_video')); return this.openCatalogPackages(); }
    this.closeModals();
    this.currentRoomId = roomId;
    prepareRoomModal(roomName || roomId, 'SALA DE VIDEO ACTIVA');
    await RV().join(roomId, roomName);
    syncClosingConfirmation();
  };

  app.joinVideoBunker = async function () {
    if (!tierAllows(1)) { toast(T('toast_tier_req_video')); return this.openCatalogPackages(); }
    await RV().join(this.currentRoomId || 'bunker_main');
    syncClosingConfirmation();
  };
  app.requestAndLoadMedia = function () { return this.joinVideoBunker(); };
  app.leaveVideoBunker = function () { RV().leave(); syncClosingConfirmation(); };
  app.toggleMic = function () { RV().toggleMic(); };
  app.toggleCam = function () { RV().toggleCam(); };
  app.startLiveTransmission = function () { RV().goLive(); };
  app.cancelLiveTransmission = function () { RV().stopLive(); };
  app.handleRadarUpdate = function (data) { RV().onPresence(data); };
  app.handleWebRTCMessage = function (data) { RV().onSignal(data); };
  app.sendWebRTCOffer = function () { /* la inicia RoomVideo al recibir video_peers */ };
  app.createPeerConnection = function () { throw new Error('createPeerConnection obsoleto: usa RoomVideo'); };
  app.closePeerConnection = function () {};

  app.applyAVSettings = async function () {
    this.haptic('heavy');
    const cam = ($('setting-cam-source') || {}).value, mic = ($('setting-mic-source') || {}).value;
    if (cam) setLS('alpha_preferred_cam', cam);
    if (mic) setLS('alpha_preferred_mic', mic);
    if (RV().isActive()) await RV().switchDevices();
    this.closeAVSettings();
  };

  app.applyGeneralAVSettings = async function () {
    this.haptic('heavy');
    const cam = ($('settings-av-cam-source') || {}).value, mic = ($('settings-av-mic-source') || {}).value;
    if (cam) setLS('alpha_preferred_cam', cam);
    if (mic) setLS('alpha_preferred_mic', mic);
    ['setting-cam-source', 'setting-mic-source'].forEach((id, i) => { const el = $(id); const v = i ? mic : cam; if (el && v) el.value = v; });
    if (RV().isActive()) await RV().switchDevices();
    toast('Configuración A/V guardada ✅');
  };

  // Sin getUserMedia "de sondeo": abrir Ajustes ya no enciende la cámara.
  app.populateMediaDevices = async function () {
    const md = global.navigator.mediaDevices;
    if (!md || !md.enumerateDevices) return;
    const devices = await md.enumerateDevices();
    const fill = (sel, list, kind) => {
      if (!sel) return;
      sel.textContent = '';
      if (kind === 'audio') sel.appendChild(new Option('🔇 ' + T('mic_none', 'Silenciar'), 'none'));
      list.forEach((d, i) => {
        const label = d.label || (kind === 'video' ? 'Cámara #' + (i + 1) : T('txt_mic', 'Micrófono') + ' #' + (i + 1));
        sel.appendChild(new Option(label, d.deviceId));
      });
      if (kind === 'video') sel.appendChild(new Option('🎥 ' + T('cam_force_obs', 'Forzar OBS'), 'obs-fallback'));
      const saved = getLS(kind === 'video' ? 'alpha_preferred_cam' : 'alpha_preferred_mic');
      if (saved) sel.value = saved;
    };
    fill($('setting-cam-source'), devices.filter((d) => d.kind === 'videoinput'), 'video');
    fill($('setting-mic-source'), devices.filter((d) => d.kind === 'audioinput'), 'audio');
  };

  // Selfie de video: cámara nativa vía <input capture>, sin stream huérfano.
  app.startGlobalSelfieCam = function () {
    const menu = $('global-media-menu'); if (menu) menu.classList.add('hidden');
    const input = $('global-media-upload');
    if (!input) return;
    input.accept = 'video/*';
    input.setAttribute('capture', 'user');
    input.click();
    setTimeout(() => input.removeAttribute('capture'), 1000);
  };

  // ==================================================================== 12. acciones delegadas (sin onclick interpolado)
  const ACTIONS = {
    profile: (d) => app.viewCreatorProfile(d.uid, d.name),
    'open-dm': (d) => app.loadConversation(d.uid, d.name),
    'creator-chat': (d) => app.openDirectChat(d.uid, d.name),
    'remove-contact': (d) => app.removeContactFromSettings(d.name),
    lightbox: (d) => app.openLightbox(app.sanitizeUrl(d.url), d.kind === 'video' ? 'video' : 'image'),
    like: (d) => app.toggleLike(Number(d.pid)),
    'tip-menu': (d) => app.openFanTipMenu(d.cid, d.pid ? Number(d.pid) : null, d.name),
    'tip-slot': (d) => app.sendTipFromPost(d.cid, Number(d.amount), d.pid ? Number(d.pid) : null, d.msg || null),
    'tip-custom': () => app.sendCustomTip(),
    unlock: (d) => app.unlockPostContent(Number(d.pid), Number(d.price)),
    catalog: () => app.openCatalogPackages(),
    'delete-post': (d) => app.deletePost(Number(d.pid)),
    'buy-stars': (d) => app.buyPackageStars(d.slug),
    'buy-ton': (d) => app.buyPackageTon(d.slug),
    'buy-external': (d) => app.openExternalCheckout(d.slug),
    follow: (d) => app.toggleFollow(d.uid, d.name),
    block: (d) => app.blockUser(d.uid, d.name),
    'msg-menu': (_d, el) => { const l = el.nextElementSibling; if (l) l.classList.toggle('hidden'); },
    'msg-delete': (d) => app.deleteChatMessage(null, null, Number(d.mid)),
    'msg-report': (d) => app.reportChatMessage(Number(d.mid)),
  };

  doc.addEventListener('click', (e) => {
    const el = e.target.closest && e.target.closest('[data-act]');
    if (!el) return;
    const fn = ACTIONS[el.getAttribute('data-act')];
    if (!fn) return;
    e.preventDefault();
    e.stopPropagation();
    try { fn(el.dataset, el); } catch (err) { console.error(err); }
  });

  global.AlphaSecure = Object.freeze({ version: '2.1.0', me: () => ME });
})(window);
