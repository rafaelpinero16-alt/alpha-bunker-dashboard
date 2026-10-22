/**
 * js/api_v2.js (v2.1) — Capa de red. Reglas:
 *   - ninguna función acepta ni envía el user_id del usuario actual;
 *   - todo pasa por AppBridge.authFetch (initData/JWT verificados en servidor);
 *   - ninguna función acredita saldo: las recargas van por AppBridge.payStars/payTon;
 *   - los ficheros NO viajan como data:URL en JSON/WebSocket: se suben con URL prefirmada.
 *
 * v2.1: fetchUserProfile apuntaba a '/users/profile/' (ruta legacy sin /v2); se añaden
 * los endpoints que app.js usaba vía fetch directo con user_id en el body.
 * Contrato completo: docs/BACKEND_CONTRACT_V2.md
 */
(function (global) {
  'use strict';
  const B = () => global.AppBridge;
  const enc = encodeURIComponent;

  function uuid() {
    if (global.crypto && global.crypto.randomUUID) return global.crypto.randomUUID();
    return 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 12);
  }

  function dataUrlToBlob(dataUrl) {
    const m = /^data:([^;,]+)(;base64)?,(.*)$/.exec(dataUrl || '');
    if (!m) throw new Error('BAD_DATA_URL');
    const bin = m[2] ? atob(m[3]) : decodeURIComponent(m[3]);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type: m[1] });
  }

  const Api = {
    uuid,

    // ------------------------------------------------------------ sesión / perfil
    me: (force) => B().getUser(force),
    updateMyProfile: (fields) => B().authFetch('/v2/users/me', { method: 'PUT', json: fields }),
    changePassword: (current, next) => B().authFetch('/v2/auth/change-password', { method: 'POST', json: { current_password: current, new_password: next } }),
    userProfile: (id) => B().authFetch('/v2/users/' + Number(id) + '/profile'),
    userPosts: (id) => B().authFetch('/v2/users/' + Number(id) + '/posts').then((r) => r.posts || []),
    toggleFollow: (id) => B().authFetch('/v2/users/' + Number(id) + '/follow', { method: 'POST' }),
    blockUser: (id) => B().authFetch('/v2/users/' + Number(id) + '/block', { method: 'POST' }),
    kycSession: () => B().authFetch('/v2/kyc/session', { method: 'POST' }),

    // ------------------------------------------------------------ media
    /** Sube un Blob o data:URL. Devuelve { media_id, url, preview_url }. */
    async uploadMedia(fileOrDataUrl, purpose) {
      const blob = typeof fileOrDataUrl === 'string' ? dataUrlToBlob(fileOrDataUrl) : fileOrDataUrl;
      const slot = await B().authFetch('/v2/media/upload-url', {
        method: 'POST', json: { content_type: blob.type, size: blob.size, purpose: purpose || 'chat' },
      });
      const put = await fetch(slot.upload_url, { method: 'PUT', headers: Object.assign({ 'Content-Type': blob.type }, slot.headers || {}), body: blob });
      if (!put.ok) throw new Error('UPLOAD_FAILED');
      return B().authFetch('/v2/media/' + enc(slot.media_id) + '/complete', { method: 'POST' });
    },

    // ------------------------------------------------------------ wallet
    async walletBalance() {
      try {
        const w = await B().authFetch('/v2/wallet/me');
        return { alpha_balance: w.alpha_balance, total_earned: w.total_earned, total_spent: w.total_spent };
      } catch (_) { return null; }
    },
    walletHistory: (limit) => B().authFetch('/v2/wallet/me/transactions?limit=' + Number(limit || 50)).then((r) => r.transactions || []),
    tip: (creatorId, amount, postId, message) => B().authFetch('/v2/wallet/tip', {
      method: 'POST',
      json: { creator_id: Number(creatorId), amount: Number(amount), post_id: postId ? Number(postId) : null, message: message || null, client_ref: uuid() },
    }),
    requestPayout: (amount, method, destination) => B().authFetch('/v2/wallet/payouts', {
      method: 'POST', json: { amount_alpha: Number(amount), payout_method: method, destination_account: destination, client_ref: uuid() },
    }),
    tonProofPayload: () => B().authFetch('/v2/wallet/ton/proof-payload', { method: 'POST' }),
    linkTonWallet: (body) => B().authFetch('/v2/wallet/ton/link', { method: 'POST', json: body }),
    unlinkTonWallet: () => B().authFetch('/v2/wallet/ton/link', { method: 'DELETE' }),

    // ------------------------------------------------------------ pagos (solo lectura de catálogo;
    // la compra va por AppBridge.payStars / payTon, que confirman en servidor)
    packages: () => B().authFetch('/v2/payments/packages').then((r) => r.packages || []),

    // ------------------------------------------------------------ posts
    feed: (beforeId) => B().authFetch('/v2/posts/feed' + (beforeId ? '?before_id=' + Number(beforeId) : '')).then((r) => r.posts || []),
    createPost: (body) => B().authFetch('/v2/posts', { method: 'POST', json: body }),
    deletePost: (id) => B().authFetch('/v2/posts/' + Number(id), { method: 'DELETE' }),
    unlockPost: (id) => B().authFetch('/v2/posts/' + Number(id) + '/unlock', { method: 'POST', json: { client_ref: uuid() } }),
    likePost: (id, like) => B().authFetch('/v2/posts/' + Number(id) + '/like', { method: like ? 'POST' : 'DELETE' }),

    // ------------------------------------------------------------ creadores
    tipMenu: (creatorId) => B().authFetch('/v2/creators/' + Number(creatorId) + '/tip-menu').then((r) => r.slots || []),
    saveTipMenu: (slots) => B().authFetch('/v2/creators/me/tip-menu', { method: 'PUT', json: { slots } }),

    // ------------------------------------------------------------ chat
    conversations: () => B().authFetch('/v2/chat/conversations').then((r) => r.conversations || []),
    dmHistory: (otherId) => B().authFetch('/v2/chat/dm/' + Number(otherId) + '/history?limit=50').then((r) => r.messages || []),
    deleteMessage: (id) => B().authFetch('/v2/chat/messages/' + Number(id), { method: 'DELETE' }),
    reportMessage: (id, reason) => B().authFetch('/v2/chat/messages/' + Number(id) + '/report', { method: 'POST', json: { reason: reason || 'other' } }),

    // ------------------------------------------------------------ video
    iceServers: () => B().authFetch('/v2/video/ice-servers').then((r) => r.ice_servers || []),
    requestVideoCall: (creatorId) => B().authFetch('/v2/videocalls', { method: 'POST', json: { creator_id: Number(creatorId), client_ref: uuid() } }),
    respondVideoCall: (sessionId, action) => B().authFetch('/v2/videocalls/' + Number(sessionId) + '/respond', { method: 'POST', json: { action } }),
  };

  global.AlphaApi = Object.freeze(Api);

  // ---------------------------------------------------------------- alias v2.0 (compat)
  global.syncUserSession = async () => { try { return { status: 'success', user: await B().getUser(true) }; } catch (_) { return null; } };
  global.fetchUserProfile = async (userId) => { try { return await Api.userProfile(userId); } catch (_) { return null; } };
  global.fetchWalletBalance = async () => (await Api.walletBalance()) || { alpha_balance: 0, total_earned: 0, total_spent: 0 };
  global.sendAlphaTip = (_ignored, creatorId, amount, postId, message) => Api.tip(creatorId, amount, postId, message);
  global.unlockPost = (postId) => Api.unlockPost(postId);
  global.fetchGlobalFeed = async (_ignored, beforeId) => { try { return await Api.feed(beforeId); } catch (_) { return []; } };
  global.buyStarsInvoice = (_ignored, slug) => B().payStars(slug);
  global.toggleUserFollow = (_ignored, followingId) => Api.toggleFollow(followingId);
  global.updateMyProfile = (fields) => Api.updateMyProfile(fields);
  global.requestVideoCall = (creatorId) => Api.requestVideoCall(creatorId);
  global.respondVideoCall = (sessionId, action) => Api.respondVideoCall(sessionId, action);
  global.fetchPackages = () => B().authFetch('/v2/payments/packages');

  // Eliminada intencionadamente: cualquier recarga pasa por payStars/payTon.
  global.depositAlphaCoins = function () {
    throw new Error('depositAlphaCoins eliminado: usa AppBridge.payStars() o AppBridge.payTon()');
  };
})(window);
