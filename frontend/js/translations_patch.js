/**
 * js/translations_patch.js — Completa translations.js sin reescribirlo.
 * Cargar justo DESPUÉS de translations.js.
 *
 * Motivo: app.js usa 24 claves que no existían; como el getTrans original devolvía la
 * propia clave (truthy), el patrón `getTrans(k) || 'texto'` nunca caía al texto por
 * defecto y el usuario veía literales como "toast_invoice_gen".
 * Idiomas it/pt/de/fr sin la clave → caen a inglés (ver app_secure.js → getTrans).
 */
(function () {
  'use strict';
  const T = window.t;
  if (!T) return;

  const extra = {
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
    fr: {
      // Estaban en inglés en translations.js
      no_contacts: 'Aucun contact enregistré pour le moment.',
      no_recent_tx: 'Aucune transaction enregistrée pour le moment.',
    },
  };

  Object.keys(extra).forEach((lang) => {
    T[lang] = T[lang] || {};
    Object.keys(extra[lang]).forEach((k) => {
      if (lang === 'fr' || !T[lang][k]) T[lang][k] = extra[lang][k];
    });
  });

  // applyTranslations con fallback en → es para claves no traducidas.
  window.applyTranslations = function (lang) {
    let active = lang;
    try { active = lang || localStorage.getItem('alpha_lang') || 'es'; } catch (_) { active = lang || 'es'; }
    const dict = T[active] || T.es;
    document.querySelectorAll('[data-i18n]').forEach((el) => {
      const key = el.getAttribute('data-i18n');
      const val = dict[key] || (T.en && T.en[key]) || T.es[key];
      if (!val) return;
      if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') el.placeholder = val;
      else el.textContent = val;
    });
    const btn = document.getElementById('fab-lang-text');
    if (btn) btn.textContent = String(active).toUpperCase();
  };
})();
