/**
 * js/translations_patch.js (v2.2) — Completa translations.js y gestiona el cambio de idioma EN CALIENTE.
 * Cargar justo DESPUÉS de translations.js. No depende de Telegram ni de Capacitor.
 *
 * API global:
 *   setAppLanguage('en')   → cambia idioma, lo guarda y repinta el DOM al instante (sin recargar).
 *   getAppLanguage()       → idioma activo ('es' | 'en' | 'it' | 'pt' | 'de' | 'fr').
 *   applyTranslations(l)   → repinta el DOM con el idioma indicado (o el activo).
 *   tr('clave')            → texto traducido con fallback idioma → en → es → ''.
 *
 * Atributos que se repintan:
 *   data-i18n="clave"              → textContent (seguro: nunca interpreta HTML)
 *   data-i18n-placeholder="clave"  → placeholder de <input>/<textarea>
 *   data-i18n-title="clave"        → atributo title
 *   data-i18n-aria="clave"         → aria-label
 *   data-i18n-html="clave"         → innerHTML SOLO para textos estáticos de este diccionario
 *                                    (nunca con datos de usuarios o del servidor)
 * Emite el evento DOM 'alpha:language' ({ detail: { lang } }) para que la app repinte lo dinámico.
 */
(function () {
  'use strict';
  const LANG_KEY = 'alpha_lang';
  const SUPPORTED = ['es', 'en', 'it', 'pt', 'de', 'fr'];
  const T = window.t || (window.t = {});
  SUPPORTED.forEach((l) => { T[l] = T[l] || {}; });

  // ------------------------------------------------------------------ claves que app.js usaba y no existían (es/en)
  const appKeys = {
    es: {
      cat_title: 'RANGOS BÚNKER', cat_desc: 'Adquiere tu rango oficial.',
      cam_obs: 'OBS Virtual', cam_front: 'Frontal', cam_back: 'Trasera', cam_force_obs: 'Forzar OBS',
      mic_none: 'Silenciar', txt_mic: 'Micrófono', txt_photo: 'Foto', txt_video: 'Video', txt_audio: 'Audio',
      prof_kyc_desc: 'Verifica tu identidad para publicar y retirar ganancias.',
      prof_kyc_verified_desc: 'Identidad verificada. Retiros habilitados.',
      status_kyc_fan_desc: 'Billetera vinculada a tu cuenta.',
      status_unlinked_desc: 'Vincula un método de pago para desbloquear contenido.',
      toast_invoice_gen: 'Generando factura con Telegram Stars... ⭐',
      toast_connect_ton_req: 'Conecta tu TON Wallet primero.',
      toast_max_video_size: '⚠️ El video supera el tamaño máximo permitido.',
      toast_max_audio_size: '⚠️ El audio supera el tamaño máximo permitido.',
      toast_video_attached: 'Video adjunto 🎬', toast_audio_attached: 'Audio adjunto 🎙️', toast_photo_attached: 'Foto adjunta 📷',
      toast_profile_saved: '¡Perfil actualizado con éxito!',
      toast_screenshots_blocked: 'Capturas bloqueadas',
      toast_uploading: 'Subiendo archivo… ⏳', toast_upload_error: '⚠️ No se pudo subir el archivo.',
      toast_payment_confirmed: '✅ Pago confirmado', toast_payment_pending: 'Pago en verificación. Te avisaremos al confirmarse.',
      toast_insufficient_balance: '⚠️ Saldo insuficiente.', toast_network_error: '⚠️ Error de red. Inténtalo de nuevo.',
      toast_session_expired: 'Tu sesión expiró. Vuelve a iniciar sesión.',
      toast_wallet_linked: 'Billetera TON vinculada ✅', toast_wallet_proof_failed: '⚠️ No se pudo verificar la propiedad de la billetera.',
      payout_title: 'SOLICITAR RETIRO', payout_amount: 'Cantidad $ALPHA', payout_method: 'Método', payout_destination: 'Cuenta destino',
      login_title: 'INICIAR SESIÓN', register_title: 'CREAR CUENTA', field_email: 'Email', field_password: 'Contraseña', field_name: 'Alias',
      pwd_current: 'Contraseña actual', pwd_new: 'Nueva contraseña', pwd_confirm: 'Confirmar contraseña',
      kyc_opening: 'Abriendo verificación de identidad…',
      tma_external_disabled: 'Dentro de Telegram los pagos se realizan con Telegram Stars o TON.',
    },
    en: {
      cat_title: 'BUNKER RANKS', cat_desc: 'Get your official rank.',
      cam_obs: 'OBS Virtual', cam_front: 'Front', cam_back: 'Back', cam_force_obs: 'Force OBS',
      mic_none: 'Mute', txt_mic: 'Microphone', txt_photo: 'Photo', txt_video: 'Video', txt_audio: 'Audio',
      prof_kyc_desc: 'Verify your identity to publish and withdraw earnings.',
      prof_kyc_verified_desc: 'Identity verified. Payouts enabled.',
      status_kyc_fan_desc: 'Wallet linked to your account.',
      status_unlinked_desc: 'Link a payment method to unlock content.',
      toast_invoice_gen: 'Generating Telegram Stars invoice... ⭐',
      toast_connect_ton_req: 'Connect your TON Wallet first.',
      toast_max_video_size: '⚠️ Video exceeds the maximum size.',
      toast_max_audio_size: '⚠️ Audio exceeds the maximum size.',
      toast_video_attached: 'Video attached 🎬', toast_audio_attached: 'Audio attached 🎙️', toast_photo_attached: 'Photo attached 📷',
      toast_profile_saved: 'Profile updated!',
      toast_screenshots_blocked: 'Screenshots blocked',
      toast_uploading: 'Uploading… ⏳', toast_upload_error: '⚠️ Upload failed.',
      toast_payment_confirmed: '✅ Payment confirmed', toast_payment_pending: 'Payment being verified. We will notify you.',
      toast_insufficient_balance: '⚠️ Insufficient balance.', toast_network_error: '⚠️ Network error. Try again.',
      toast_session_expired: 'Your session expired. Please sign in again.',
      toast_wallet_linked: 'TON wallet linked ✅', toast_wallet_proof_failed: '⚠️ Wallet ownership could not be verified.',
      payout_title: 'REQUEST PAYOUT', payout_amount: '$ALPHA amount', payout_method: 'Method', payout_destination: 'Destination account',
      login_title: 'SIGN IN', register_title: 'CREATE ACCOUNT', field_email: 'Email', field_password: 'Password', field_name: 'Alias',
      pwd_current: 'Current password', pwd_new: 'New password', pwd_confirm: 'Confirm password',
      kyc_opening: 'Opening identity verification…',
      tma_external_disabled: 'Inside Telegram, payments use Telegram Stars or TON.',
    },
  };

  // ------------------------------------------------------------------ textos estáticos de index.html y autenticación (6 idiomas)
  // Orden de cada fila: [es, en, it, pt, de, fr]
  const uiRows = {
    lang_title: ['IDIOMA', 'LANGUAGE', 'LINGUA', 'IDIOMA', 'SPRACHE', 'LANGUE'],
    // Advertencia +18
    warn_title: ['ADVERTENCIA', 'WARNING', 'ATTENZIONE', 'AVISO', 'WARNUNG', 'AVERTISSEMENT'],
    warn_sub: ['+18 CONTENIDO ADULTO', '+18 ADULT CONTENT', '+18 CONTENUTI PER ADULTI', '+18 CONTEÚDO ADULTO', '+18 INHALTE FÜR ERWACHSENE', '+18 CONTENU ADULTE'],
    warn_p1: ['Este espacio contiene material explícito y sexual.', 'This space contains explicit sexual material.', 'Questo spazio contiene materiale esplicito e sessuale.', 'Este espaço contém material explícito e sexual.', 'Dieser Bereich enthält explizites sexuelles Material.', 'Cet espace contient du contenu sexuel explicite.'],
    warn_p2: [
      'Al ingresar, confirmas bajo tu responsabilidad que eres mayor de edad (18+) y consientes visualizar este contenido.',
      'By entering, you confirm under your own responsibility that you are of legal age (18+) and consent to viewing this content.',
      'Entrando, confermi sotto la tua responsabilità di essere maggiorenne (18+) e acconsenti a visualizzare questi contenuti.',
      'Ao entrar, você confirma sob sua responsabilidade que é maior de idade (18+) e consente em visualizar este conteúdo.',
      'Mit dem Betreten bestätigst du in eigener Verantwortung, volljährig (18+) zu sein, und stimmst der Anzeige dieser Inhalte zu.',
      'En entrant, vous confirmez sous votre responsabilité être majeur (18+) et consentez à voir ce contenu.',
    ],
    btn_accept: ['ACEPTO', 'I ACCEPT', 'ACCETTO', 'ACEITO', 'ICH AKZEPTIERE', "J'ACCEPTE"],
    btn_exit: ['SALIR', 'EXIT', 'ESCI', 'SAIR', 'VERLASSEN', 'QUITTER'],
    // Captcha
    cap_title: ['VERIFICACIÓN HUMANA', 'HUMAN VERIFICATION', 'VERIFICA UMANA', 'VERIFICAÇÃO HUMANA', 'MENSCHLICHE ÜBERPRÜFUNG', 'VÉRIFICATION HUMAINE'],
    cap_desc: ['Resuelve el código de seguridad para ingresar.', 'Solve the security code to enter.', 'Risolvi il codice di sicurezza per entrare.', 'Resolva o código de segurança para entrar.', 'Gib den Sicherheitscode ein, um fortzufahren.', 'Saisissez le code de sécurité pour entrer.'],
    cap_new: ['Generar otro código', 'Generate another code', 'Genera un altro codice', 'Gerar outro código', 'Neuen Code erzeugen', 'Générer un autre code'],
    cap_verify: ['VERIFICAR ACCESO', 'VERIFY ACCESS', 'VERIFICA ACCESSO', 'VERIFICAR ACESSO', 'ZUGANG PRÜFEN', "VÉRIFIER L'ACCÈS"],
    cap_placeholder: ['Ingresa el código...', 'Enter the code...', 'Inserisci il codice...', 'Digite o código...', 'Code eingeben...', 'Saisissez le code...'],
    // Login
    btn_back_upper: ['VOLVER', 'BACK', 'INDIETRO', 'VOLTAR', 'ZURÜCK', 'RETOUR'],
    login_hdr: ['ACCESO AL VAULT', 'VAULT ACCESS', 'ACCESSO AL VAULT', 'ACESSO AO VAULT', 'VAULT-ZUGANG', 'ACCÈS AU VAULT'],
    login_desc: ['Inicia sesión con tu email y contraseña, o con Telegram.', 'Sign in with your email and password, or with Telegram.', 'Accedi con email e password, oppure con Telegram.', 'Entre com seu e-mail e senha, ou com o Telegram.', 'Melde dich mit E-Mail und Passwort oder mit Telegram an.', 'Connectez-vous avec votre e-mail et mot de passe, ou avec Telegram.'],
    lbl_email: ['CORREO ELECTRÓNICO', 'EMAIL', 'EMAIL', 'E-MAIL', 'E-MAIL', 'E-MAIL'],
    lbl_password: ['CONTRASEÑA', 'PASSWORD', 'PASSWORD', 'SENHA', 'PASSWORT', 'MOT DE PASSE'],
    ph_email: ['tucorreo@email.com', 'you@email.com', 'tua@email.com', 'seu@email.com', 'du@email.com', 'vous@email.com'],
    btn_login: ['ACCEDER AL VAULT', 'ENTER THE VAULT', 'ENTRA NEL VAULT', 'ENTRAR NO VAULT', 'VAULT BETRETEN', 'ENTRER DANS LE VAULT'],
    txt_or: ['Ó DIRECTAMENTE CON', 'OR DIRECTLY WITH', 'O DIRETTAMENTE CON', 'OU DIRETAMENTE COM', 'ODER DIREKT MIT', 'OU DIRECTEMENT AVEC'],
    btn_tg_login: ['LOGIN CON TELEGRAM', 'LOG IN WITH TELEGRAM', 'ACCEDI CON TELEGRAM', 'ENTRAR COM TELEGRAM', 'MIT TELEGRAM ANMELDEN', 'CONNEXION AVEC TELEGRAM'],
    txt_no_account: ['¿No tienes cuenta aún?', "Don't have an account yet?", 'Non hai ancora un account?', 'Ainda não tem conta?', 'Noch kein Konto?', 'Pas encore de compte ?'],
    btn_create_account: ['CREAR CUENTA NUEVA', 'CREATE NEW ACCOUNT', 'CREA NUOVO ACCOUNT', 'CRIAR NOVA CONTA', 'NEUES KONTO ERSTELLEN', 'CRÉER UN COMPTE'],
    // Registro
    reg_hdr: ['NUEVA CUENTA', 'NEW ACCOUNT', 'NUOVO ACCOUNT', 'NOVA CONTA', 'NEUES KONTO', 'NOUVEAU COMPTE'],
    reg_desc: ['Elige tu rol e ingresa tus credenciales de acceso.', 'Choose your role and enter your credentials.', 'Scegli il tuo ruolo e inserisci le credenziali.', 'Escolha seu papel e insira suas credenciais.', 'Wähle deine Rolle und gib deine Zugangsdaten ein.', 'Choisissez votre rôle et saisissez vos identifiants.'],
    lbl_account_type: ['TIPO DE CUENTA', 'ACCOUNT TYPE', 'TIPO DI ACCOUNT', 'TIPO DE CONTA', 'KONTOTYP', 'TYPE DE COMPTE'],
    role_fan: ['SOY FAN', "I'M A FAN", 'SONO UN FAN', 'SOU FÃ', 'ICH BIN FAN', 'JE SUIS FAN'],
    role_creator: ['SOY CREADOR', "I'M A CREATOR", 'SONO UN CREATOR', 'SOU CRIADOR', 'ICH BIN CREATOR', 'JE SUIS CRÉATEUR'],
    lbl_alias: ['ALIAS', 'ALIAS', 'ALIAS', 'ALIAS', 'ALIAS', 'ALIAS'],
    ph_alias: ['Tu alias VIP', 'Your VIP alias', 'Il tuo alias VIP', 'Seu alias VIP', 'Dein VIP-Alias', 'Votre alias VIP'],
    ph_password_min: ['Mínimo 8 caracteres', 'At least 8 characters', 'Almeno 8 caratteri', 'Mínimo 8 caracteres', 'Mindestens 8 Zeichen', '8 caractères minimum'],
    btn_register: ['REGISTRARSE', 'SIGN UP', 'REGISTRATI', 'CADASTRAR-SE', 'REGISTRIEREN', "S'INSCRIRE"],
    // Navegación inferior
    nav_catalog: ['CATÁLOGO', 'CATALOG', 'CATALOGO', 'CATÁLOGO', 'KATALOG', 'CATALOGUE'],
    nav_community: ['COMUNIDAD', 'COMMUNITY', 'COMUNITÀ', 'COMUNIDADE', 'COMMUNITY', 'COMMUNAUTÉ'],
    nav_post: ['PUBLICAR', 'POST', 'PUBBLICA', 'PUBLICAR', 'POSTEN', 'PUBLIER'],
    nav_profile: ['MI PERFIL', 'MY PROFILE', 'IL MIO PROFILO', 'MEU PERFIL', 'MEIN PROFIL', 'MON PROFIL'],
    nav_dms: ['DMs', 'DMs', 'DM', 'DMs', 'DMs', 'DM'],
    // Menú lateral
    sb_profile: ['Mi Perfil y Cuenta', 'My Profile & Account', 'Profilo e Account', 'Meu Perfil e Conta', 'Profil & Konto', 'Mon profil et compte'],
    sb_settings: ['Ajustes Generales', 'General Settings', 'Impostazioni Generali', 'Configurações Gerais', 'Allgemeine Einstellungen', 'Paramètres généraux'],
    sb_slots: ['Gestionar 10 Slots', 'Manage 10 Slots', 'Gestisci 10 Slot', 'Gerenciar 10 Slots', '10 Slots verwalten', 'Gérer les 10 slots'],
    sb_video_rooms: ['Salas de Videochat', 'Videochat Rooms', 'Stanze Videochat', 'Salas de Vídeo', 'Videochat-Räume', 'Salons vidéo'],
    sb_global_chat: ['Chat Global del Búnker', 'Global Bunker Chat', 'Chat Globale del Bunker', 'Chat Global do Bunker', 'Globaler Bunker-Chat', 'Chat global du Bunker'],
    sb_av: ['Hardware A/V', 'A/V Hardware', 'Hardware A/V', 'Hardware A/V', 'A/V-Hardware', 'Matériel A/V'],
    sb_contacts: ['Contactos y DMs', 'Contacts & DMs', 'Contatti e DM', 'Contatos e DMs', 'Kontakte & DMs', 'Contacts et DM'],
    sb_ask: ['Hacer una pregunta', 'Ask a question', 'Fai una domanda', 'Fazer uma pergunta', 'Frage stellen', 'Poser une question'],
    sb_faq: ['Preguntas Frecuentes (FAQ)', 'FAQ', 'Domande frequenti (FAQ)', 'Perguntas frequentes (FAQ)', 'Häufige Fragen (FAQ)', 'Questions fréquentes (FAQ)'],
    sb_learn: ['Aprende sobre Alpha App', 'Learn about Alpha App', 'Scopri Alpha App', 'Conheça o Alpha App', 'Mehr über Alpha App', 'Découvrir Alpha App'],
    sb_privacy: ['Política de Privacidad', 'Privacy Policy', 'Informativa sulla privacy', 'Política de Privacidade', 'Datenschutzerklärung', 'Politique de confidentialité'],
    sb_terms: ['Términos de Servicio', 'Terms of Service', 'Termini di servizio', 'Termos de Serviço', 'Nutzungsbedingungen', "Conditions d'utilisation"],
    sb_logout: ['Cerrar Sesión', 'Log Out', 'Esci', 'Sair', 'Abmelden', 'Se déconnecter'],
    // Autenticación en APK / errores
    tg_login_waiting: [
      'Confirma el acceso en Telegram y vuelve a la app…',
      'Confirm access in Telegram and come back to the app…',
      "Conferma l'accesso su Telegram e torna all'app…",
      'Confirme o acesso no Telegram e volte ao app…',
      'Bestätige den Zugang in Telegram und kehre zur App zurück…',
      "Confirmez l'accès dans Telegram puis revenez à l'app…",
    ],
    tg_login_unavailable: [
      'El login con Telegram no está disponible en esta versión. Usa email y contraseña.',
      "Telegram login isn't available in this version. Use email and password.",
      "L'accesso con Telegram non è disponibile in questa versione. Usa email e password.",
      'O login com Telegram não está disponível nesta versão. Use e-mail e senha.',
      'Die Telegram-Anmeldung ist in dieser Version nicht verfügbar. Nutze E-Mail und Passwort.',
      "La connexion Telegram n'est pas disponible dans cette version. Utilisez e-mail et mot de passe.",
    ],
    tg_login_timeout: ['No recibimos la confirmación de Telegram. Inténtalo de nuevo.', "We didn't receive Telegram's confirmation. Try again.", 'Nessuna conferma da Telegram. Riprova.', 'Não recebemos a confirmação do Telegram. Tente novamente.', 'Keine Bestätigung von Telegram erhalten. Versuche es erneut.', "Aucune confirmation de Telegram reçue. Réessayez."],
    toast_fill_login: ['Ingresa tu email y contraseña', 'Enter your email and password', 'Inserisci email e password', 'Digite seu e-mail e senha', 'E-Mail und Passwort eingeben', 'Saisissez votre e-mail et mot de passe'],
    toast_fill_register: ['Completa alias, email y contraseña', 'Fill in alias, email and password', 'Compila alias, email e password', 'Preencha alias, e-mail e senha', 'Alias, E-Mail und Passwort ausfüllen', 'Remplissez alias, e-mail et mot de passe'],
    toast_invalid_email: ['Email no válido', 'Invalid email', 'Email non valida', 'E-mail inválido', 'Ungültige E-Mail', 'E-mail invalide'],
    toast_pwd_min8: ['La contraseña debe tener al menos 8 caracteres', 'Password must be at least 8 characters', 'La password deve avere almeno 8 caratteri', 'A senha deve ter pelo menos 8 caracteres', 'Das Passwort muss mindestens 8 Zeichen haben', 'Le mot de passe doit contenir au moins 8 caractères'],
    toast_invalid_credentials: ['Email o contraseña incorrectos', 'Wrong email or password', 'Email o password errati', 'E-mail ou senha incorretos', 'E-Mail oder Passwort falsch', 'E-mail ou mot de passe incorrect'],
    toast_account_exists: ['Ya existe una cuenta con ese email', 'An account with that email already exists', 'Esiste già un account con questa email', 'Já existe uma conta com esse e-mail', 'Mit dieser E-Mail existiert bereits ein Konto', 'Un compte existe déjà avec cet e-mail'],
    toast_server_unreachable: ['No se pudo conectar con el servidor. Revisa tu conexión.', "Couldn't reach the server. Check your connection.", 'Impossibile raggiungere il server. Controlla la connessione.', 'Não foi possível conectar ao servidor. Verifique sua conexão.', 'Server nicht erreichbar. Prüfe deine Verbindung.', 'Impossible de joindre le serveur. Vérifiez votre connexion.'],
    toast_server_slow: ['El servidor tardó demasiado en responder. Inténtalo de nuevo.', 'The server took too long to respond. Try again.', 'Il server ha impiegato troppo a rispondere. Riprova.', 'O servidor demorou demais para responder. Tente novamente.', 'Der Server hat zu lange gebraucht. Versuche es erneut.', 'Le serveur a mis trop de temps à répondre. Réessayez.'],
    boot_offline_title: ['SIN CONEXIÓN', 'OFFLINE', 'OFFLINE', 'SEM CONEXÃO', 'OFFLINE', 'HORS LIGNE'],
    boot_offline_desc: ['No pudimos contactar con el servidor del Búnker.', "We couldn't reach the Bunker server.", 'Impossibile contattare il server del Bunker.', 'Não conseguimos contatar o servidor do Bunker.', 'Der Bunker-Server ist nicht erreichbar.', 'Impossible de contacter le serveur du Bunker.'],
    btn_retry: ['REINTENTAR', 'RETRY', 'RIPROVA', 'TENTAR NOVAMENTE', 'ERNEUT VERSUCHEN', 'RÉESSAYER'],
    btn_cancel: ['Cancelar', 'Cancel', 'Annulla', 'Cancelar', 'Abbrechen', 'Annuler'],
  };

  // ------------------------------------------------------------------ fusión en window.t
  Object.keys(appKeys).forEach((lang) => {
    Object.keys(appKeys[lang]).forEach((k) => { if (!T[lang][k]) T[lang][k] = appKeys[lang][k]; });
  });
  Object.keys(uiRows).forEach((key) => {
    uiRows[key].forEach((val, i) => { T[SUPPORTED[i]][key] = val; });
  });
  // Estaban en inglés dentro de translations.js
  T.fr.no_contacts = 'Aucun contact enregistré pour le moment.';
  T.fr.no_recent_tx = 'Aucune transaction enregistrée pour le moment.';

  // ------------------------------------------------------------------ idioma activo
  function readStoredLang() {
    try { return window.localStorage.getItem(LANG_KEY); } catch (_) { return null; }
  }

  function normalize(lang) {
    const l = String(lang || '').toLowerCase().slice(0, 2);
    return SUPPORTED.indexOf(l) >= 0 ? l : null;
  }

  let current = normalize(readStoredLang()) || 'es';

  function getAppLanguage() { return current; }

  function tr(key, lang) {
    const l = normalize(lang) || current;
    return (T[l] && T[l][key]) || (T.en && T.en[key]) || (T.es && T.es[key]) || '';
  }

  // ------------------------------------------------------------------ repintado del DOM
  function eachAttr(root, attr, fn) {
    try {
      root.querySelectorAll('[' + attr + ']').forEach((el) => {
        const val = tr(el.getAttribute(attr));
        if (val) { try { fn(el, val); } catch (e) { console.error('[i18n] no se pudo traducir', el, e); } }
      });
    } catch (e) { console.error('[i18n] selector ' + attr, e); }
  }

  function applyTranslations(lang, root) {
    const l = normalize(lang) || current;
    current = l;
    const scope = root || document;
    eachAttr(scope, 'data-i18n', (el, v) => {
      if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') el.placeholder = v;
      else el.textContent = v;
    });
    eachAttr(scope, 'data-i18n-placeholder', (el, v) => { el.placeholder = v; });
    eachAttr(scope, 'data-i18n-title', (el, v) => { el.title = v; });
    eachAttr(scope, 'data-i18n-aria', (el, v) => { el.setAttribute('aria-label', v); });
    eachAttr(scope, 'data-i18n-html', (el, v) => { el.innerHTML = v; });   // solo textos estáticos del diccionario
    try { document.documentElement.lang = l; } catch (_) {}
    const btn = document.getElementById('fab-lang-text');
    if (btn) btn.textContent = l.toUpperCase();
    return l;
  }

  /**
   * Función a vincular al selector de idiomas.
   * 1. Actualiza la variable global de idioma (y app.currentLang si app.js ya cargó).
   * 2. Guarda la preferencia en localStorage (si está disponible).
   * 3. Repinta inmediatamente todo [data-i18n] sin recargar.
   * 4. Emite 'alpha:language' para repintar contenido dinámico (modales, catálogo, feed).
   */
  function setAppLanguage(lang) {
    const l = normalize(lang);
    if (!l) { console.error('[i18n] idioma no soportado:', lang); return current; }
    current = l;
    try { window.localStorage.setItem(LANG_KEY, l); } catch (e) { console.warn('[i18n] localStorage no disponible; el idioma no persistirá', e); }
    if (window.app) { try { window.app.currentLang = l; } catch (_) {} }
    applyTranslations(l);
    try { document.dispatchEvent(new CustomEvent('alpha:language', { detail: { lang: l } })); }
    catch (e) { console.error('[i18n] evento alpha:language', e); }
    return l;
  }

  window.ALPHA_LANGS = Object.freeze(SUPPORTED.slice());
  window.getAppLanguage = getAppLanguage;
  window.setAppLanguage = setAppLanguage;
  window.applyTranslations = applyTranslations;
  window.tr = tr;

  // Primer pintado en cuanto exista el DOM (independiente de Telegram y del backend).
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => applyTranslations(current));
  else applyTranslations(current);
})();
