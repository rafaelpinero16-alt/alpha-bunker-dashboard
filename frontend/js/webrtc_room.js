/**
 * js/webrtc_room.js (v2.3) — Video de salas (mesh P2P) sobre MediaManager + BunkerChat.sendSignal.
 *
 * Sustituye a app.createPeerConnection / sendWebRTCOffer / handleWebRTCMessage /
 * requestAndLoadMedia de app.js, que:
 *   - pedían la cámara fuera de MediaManager (LED encendido al minimizar);
 *   - enviaban la señalización por el socket de TEXTO (se publicaba como mensaje de chat);
 *   - solo usaban STUN (sin TURN: falla en redes móviles con NAT simétrico);
 *   - aplicaban ICE antes de tener remoteDescription (excepción silenciada);
 *   - no reemplazaban pistas al cambiar de cámara (los demás veían video congelado).
 *
 * Protocolo (ver docs/BACKEND_CONTRACT_V2.md §6). El servidor SIEMPRE fija caller_id
 * a partir del ticket del socket; el cliente nunca declara su identidad.
 *
 * v2.3 — Malla adaptativa: en una malla P2P cada participante SUBE un flujo por cada peer.
 * rebalance() reparte un presupuesto total de subida (UPLINK_BUDGET) entre los peers y, a partir
 * de 3 peers, baja la captura a 480×270 @ 15 fps (menos CPU de codificación y memoria). Al
 * salir gente se vuelve a subir la calidad. Los <video> de peers que se van se liberan.
 *
 * Telegram NO expone API de videollamadas/grupos para Mini Apps: el video es WebRTC propio.
 * Lo que sí es nativo de Telegram aquí: HapticFeedback, BackButton (minimiza), y
 * enableClosingConfirmation mientras hay cámara activa.
 */
(function (global) {
  'use strict';
  const B = () => global.AppBridge;
  const cfg = () => global.ALPHA_CONFIG || { features: {} };
  const app = () => global.app;
  const $ = (id) => global.document.getElementById(id);

  const FALLBACK_ICE = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];
  const UPLINK_BUDGET = 1500000;     // bps totales de subida de vídeo repartidos entre peers
  const MAX_PER_PEER = 600000;       // techo por peer (1-2 peers)
  const MIN_PER_PEER = 150000;       // suelo por peer (malla grande)
  const PROFILES = {
    high: { width: 640, height: 360, frameRate: 24 },
    low: { width: 480, height: 270, frameRate: 15 },
  };

  const st = {
    active: false, suspended: false, roomId: null, owner: null, stream: null,
    live: false, micMuted: false, camOff: false, profile: 'high',
    iceServers: null, peers: new Map(),   // peerId -> { pc, pendingIce:[], name, polite, makingOffer, initiator }
  };

  function myId() { return app() && app().userId ? String(app().userId) : ''; }
  function toast(m) { if (app()) app().showToast(m); }

  // ---------------------------------------------------------------- media
  function constraints() {
    let cam = null, mic = null;
    try { cam = global.localStorage.getItem('alpha_preferred_cam'); mic = global.localStorage.getItem('alpha_preferred_mic'); } catch (_) {}
    const pr = PROFILES[st.profile] || PROFILES.high;
    const video = { width: { ideal: pr.width }, height: { ideal: pr.height }, frameRate: { ideal: pr.frameRate, max: 30 }, facingMode: 'user' };
    if (cam && cam !== 'obs-fallback') { video.deviceId = { exact: cam }; delete video.facingMode; }
    const audio = mic === 'none' ? false : (mic ? { deviceId: { exact: mic }, echoCancellation: true, noiseSuppression: true } : { echoCancellation: true, noiseSuppression: true });
    return { video, audio };
  }

  async function acquireLocal() {
    const persistent = !!cfg().features.videoPersistentInBackground;
    try {
      return await global.MediaManager.acquire(st.owner, constraints(), { persistent });
    } catch (e) {
      if (e && (e.name === 'OverconstrainedError' || e.name === 'NotFoundError')) {
        // Dispositivo guardado ya no existe → limpiar preferencia y reintentar genérico.
        try { global.localStorage.removeItem('alpha_preferred_cam'); global.localStorage.removeItem('alpha_preferred_mic'); } catch (_) {}
        return global.MediaManager.acquire(st.owner, { video: true, audio: true }, { persistent });
      }
      throw e;
    }
  }

  async function loadIce() {
    if (st.iceServers) return st.iceServers;
    try {
      const list = await global.AlphaApi.iceServers();
      st.iceServers = list && list.length ? list : FALLBACK_ICE;
    } catch (_) { st.iceServers = FALLBACK_ICE; }
    return st.iceServers;
  }

  // ---------------------------------------------------------------- UI del búnker
  function showBunker(roomName) {
    const bunker = $('floating-video-bunker');
    if (bunker) {
      bunker.classList.remove('hidden', 'video-hidden');
      bunker.className = 'fixed inset-0 z-[150] bg-[#050505] flex flex-col transition-all duration-300';
    }
    const bar = $('video-controls-bar'); if (bar) bar.classList.remove('hidden');
    const icon = $('icon-minimize'); if (icon) icon.className = 'fa-solid fa-compress';
    const tab = $('floating-video-tab'); if (tab) tab.style.display = 'none';
    if (app()) app().isVideoMinimized = false;
    setBadge(false, roomName);
    const goLive = $('btn-go-live'); if (goLive) goLive.classList.remove('hidden');
    const cancel = $('btn-cancel-stream'); if (cancel) cancel.classList.add('hidden');
    const ph = $('cam-loading-placeholder'); if (ph) ph.classList.remove('hidden');
  }

  function setBadge(live, roomName) {
    const badge = $('video-badge');
    if (!badge) return;
    const t = (k, d) => (app() && app().getTrans(k)) || d;
    if (live) {
      badge.className = 'absolute top-3 left-3 z-20 bg-red-600 text-white text-[9px] font-black px-2.5 py-0.5 rounded animate-pulse shadow-md uppercase';
      badge.textContent = 'EN VIVO';
    } else {
      badge.className = 'absolute top-3 left-3 z-20 bg-amber-500 text-black text-[9px] font-black px-2.5 py-0.5 rounded shadow-md uppercase';
      badge.textContent = (roomName ? String(roomName).toUpperCase() + ' • ' : '') + t('preview_badge', 'PREVISUALIZACIÓN');
    }
  }

  function attachLocal(stream) {
    const v = $('bunker-webcam-feed');
    if (v) {
      v.srcObject = stream;
      v.muted = true;
      v.playsInline = true;
      v.classList.remove('hidden');
      v.play().catch(() => {});
    }
    const ph = $('cam-loading-placeholder'); if (ph) ph.classList.add('hidden');
  }

  function grid() {
    return $('bunker-video-grid') || (app() && app().createVideoGrid ? app().createVideoGrid() : null);
  }

  function tileFor(peerId, name) {
    let tile = $('rv-tile-' + peerId);
    if (tile) return tile;
    const g = grid();
    if (!g) return null;
    tile = global.document.createElement('div');
    tile.id = 'rv-tile-' + peerId;
    tile.className = 'rv-tile relative flex-1 min-w-[45%] max-w-[50%] h-48 md:h-64';
    const video = global.document.createElement('video');
    video.autoplay = true; video.playsInline = true;
    video.className = 'w-full h-full object-cover border-2 border-[#ff00ff] rounded-xl shadow-lg bg-black';
    const label = global.document.createElement('span');
    label.className = 'rv-label';
    label.textContent = '@' + (name || peerId);
    tile.appendChild(video);
    tile.appendChild(label);
    g.appendChild(tile);
    return tile;
  }

  function removeTile(peerId) {
    const tile = $('rv-tile-' + peerId);
    if (!tile) return;
    const v = tile.querySelector('video');
    if (v) v.srcObject = null;
    tile.remove();
  }

  function updateToggles() {
    if (!app()) return;
    app().isMicMuted = st.micMuted;
    app().isCamOff = st.camOff;
    if (typeof app().updateMediaTogglesUI === 'function') app().updateMediaTogglesUI();
  }

  // ---------------------------------------------------------------- presencia (chips)
  function renderPresence(data) {
    const uid = String(data.user_id);
    const name = data.name || uid;
    const status = data.status;
    const chat = $('online-users-chips');
    const video = $('bunker-video-active-members');
    const idChat = 'radar-chat-' + uid, idVideo = 'radar-video-' + uid;

    if (status === 'offline') {
      const a = $(idChat); if (a) a.remove();
      const b = $(idVideo); if (b) b.remove();
      closePeer(uid);
    } else {
      if (chat && !$(idChat)) chat.appendChild(chip(idChat, uid, name, 'flex items-center gap-1 bg-black px-2 py-1 rounded-lg border border-emerald-500/40 text-emerald-300 truncate cursor-pointer hover:bg-neutral-800 transition', 'fa-solid fa-circle text-[4px] neon-green-dot'));
      if (status === 'live' && video && !$(idVideo)) video.appendChild(chip(idVideo, uid, name, 'flex items-center gap-1 bg-neutral-900 px-1.5 py-1 rounded border border-neutral-700 truncate cursor-pointer hover:bg-neutral-800 transition', 'fa-solid fa-circle text-[4px] text-amber-500 animate-pulse'));
      if (status !== 'live') { const b = $(idVideo); if (b) b.remove(); }
    }
    const counter = $('views-counter');
    if (counter && chat) counter.textContent = String(Math.max(1, chat.children.length));
  }

  function chip(id, uid, name, cls, iconCls) {
    const d = global.document.createElement('div');
    d.id = id; d.className = cls;
    d.setAttribute('data-act', 'profile');
    d.setAttribute('data-uid', uid);
    d.setAttribute('data-name', name);
    const i = global.document.createElement('i'); i.className = iconCls;
    d.appendChild(i);
    d.appendChild(global.document.createTextNode(' @' + name));
    return d;
  }

  // ---------------------------------------------------------------- peers
  function send(obj) { return global.BunkerChat.sendSignal(obj); }

  async function createPeer(peerId, name, initiator) {
    if (st.peers.has(peerId)) return st.peers.get(peerId);
    const max = cfg().features.maxMeshPeers || 6;
    if (st.peers.size >= max - 1) { toast('Sala llena para video P2P (máx. ' + max + ').'); return null; }

    const pc = new RTCPeerConnection({ iceServers: await loadIce(), bundlePolicy: 'max-bundle' });
    global.MediaManager.trackPeer(st.owner, pc);
    const me = Number(myId()), them = Number(peerId);
    const peer = { pc, pendingIce: [], name, initiator, makingOffer: false, polite: !isNaN(me) && !isNaN(them) ? me < them : myId() < peerId, failTimer: null };
    st.peers.set(peerId, peer);

    if (st.stream) st.stream.getTracks().forEach((t) => pc.addTrack(t, st.stream));

    pc.onicecandidate = (e) => { if (e.candidate) send({ type: 'webrtc_ice', target_id: peerId, candidate: e.candidate.toJSON ? e.candidate.toJSON() : e.candidate }); };

    pc.ontrack = (e) => {
      const tile = tileFor(peerId, peer.name);
      if (!tile) return;
      const v = tile.querySelector('video');
      const stream = (e.streams && e.streams[0]) || (v.srcObject instanceof MediaStream ? v.srcObject : new MediaStream());
      if (!e.streams || !e.streams[0]) stream.addTrack(e.track);
      if (v.srcObject !== stream) v.srcObject = stream;
      v.play().catch(() => {});
    };

    pc.onconnectionstatechange = () => {
      const s = pc.connectionState;
      if (s === 'connected') {
        clearTimeout(peer.failTimer);
        rebalance();
      } else if (s === 'failed') {
        if (peer.initiator) restartIce(peerId);
        peer.failTimer = setTimeout(() => { if (pc.connectionState !== 'connected') closePeer(peerId); }, 15000);
      } else if (s === 'closed') {
        closePeer(peerId);
      }
    };

    if (initiator) await makeOffer(peerId);
    return peer;
  }

  async function makeOffer(peerId, opts) {
    const peer = st.peers.get(peerId);
    if (!peer) return;
    try {
      peer.makingOffer = true;
      const offer = await peer.pc.createOffer(opts || {});
      await peer.pc.setLocalDescription(offer);
      send({ type: 'webrtc_offer', target_id: peerId, sdp: peer.pc.localDescription.sdp });
    } catch (e) { console.warn('[RoomVideo] offer', e); }
    finally { peer.makingOffer = false; }
  }

  function restartIce(peerId) {
    const peer = st.peers.get(peerId);
    if (!peer) return;
    if (typeof peer.pc.restartIce === 'function') peer.pc.restartIce();
    makeOffer(peerId, { iceRestart: true });
  }

  function perPeerBitrate() {
    const n = Math.max(1, st.peers.size);
    return Math.max(MIN_PER_PEER, Math.min(MAX_PER_PEER, Math.floor(UPLINK_BUDGET / n)));
  }

  async function capBitrate(pc, bps) {
    try {
      for (const s of pc.getSenders()) {
        if (!s.track || s.track.kind !== 'video' || typeof s.getParameters !== 'function') continue;
        const p = s.getParameters();
        if (!p.encodings || !p.encodings.length) p.encodings = [{}];
        if (p.encodings[0].maxBitrate === bps) continue;
        p.encodings[0].maxBitrate = bps;
        await s.setParameters(p);
      }
    } catch (_) { /* no soportado en todas las WebView */ }
  }

  /** Reparte la subida entre peers y ajusta la captura local según el tamaño de la malla. */
  let rebalanceTimer = null;
  function rebalance() {
    clearTimeout(rebalanceTimer);
    rebalanceTimer = setTimeout(async () => {
      if (!st.active) return;
      const bps = perPeerBitrate();
      for (const peer of st.peers.values()) {
        if (peer.pc.connectionState === 'connected') await capBitrate(peer.pc, bps);
      }
      const want = st.peers.size >= 3 ? 'low' : 'high';
      const track = st.stream && st.stream.getVideoTracks()[0];
      if (track && want !== st.profile && typeof track.applyConstraints === 'function') {
        const pr = PROFILES[want];
        try {
          await track.applyConstraints({ width: { ideal: pr.width }, height: { ideal: pr.height }, frameRate: { ideal: pr.frameRate, max: pr.frameRate } });
          st.profile = want;
        } catch (e) { console.warn('[RoomVideo] applyConstraints', e); }
      }
    }, 300);
  }

  async function flushIce(peer) {
    while (peer.pendingIce.length) {
      const c = peer.pendingIce.shift();
      try { await peer.pc.addIceCandidate(c); } catch (e) { console.warn('[RoomVideo] ice', e); }
    }
  }

  async function onOffer(from, sdp, name) {
    if (!st.active || st.suspended) return;
    let peer = st.peers.get(from) || await createPeer(from, name, false);
    if (!peer) return;
    const pc = peer.pc;
    const collision = peer.makingOffer || pc.signalingState !== 'stable';
    if (collision && !peer.polite) return;   // el peer "impolite" ignora la oferta en colisión
    try {
      if (collision) await pc.setLocalDescription({ type: 'rollback' });
      await pc.setRemoteDescription({ type: 'offer', sdp });
      await flushIce(peer);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      send({ type: 'webrtc_answer', target_id: from, sdp: pc.localDescription.sdp });
    } catch (e) { console.warn('[RoomVideo] answer', e); }
  }

  async function onAnswer(from, sdp) {
    const peer = st.peers.get(from);
    if (!peer || peer.pc.signalingState !== 'have-local-offer') return;
    try {
      await peer.pc.setRemoteDescription({ type: 'answer', sdp });
      await flushIce(peer);
    } catch (e) { console.warn('[RoomVideo] setAnswer', e); }
  }

  async function onIce(from, candidate) {
    const peer = st.peers.get(from);
    if (!peer || !candidate) return;
    if (!peer.pc.remoteDescription) { peer.pendingIce.push(candidate); return; }
    try { await peer.pc.addIceCandidate(candidate); } catch (e) { console.warn('[RoomVideo] ice', e); }
  }

  function closePeer(peerId) {
    const peer = st.peers.get(peerId);
    if (peer) {
      clearTimeout(peer.failTimer);
      st.peers.delete(peerId);
      global.MediaManager.releasePeer(st.owner, peer.pc);
      rebalance();
    }
    removeTile(peerId);
  }

  function closeAllPeers() { Array.from(st.peers.keys()).forEach(closePeer); }

  // ---------------------------------------------------------------- API pública
  const RoomVideo = {
    isActive() { return st.active; },
    stats() { return { peers: st.peers.size, perPeerBitrate: perPeerBitrate(), profile: st.profile }; },
    isLive() { return st.live; },
    peerCount() { return st.peers.size; },

    async join(roomId, roomName) {
      const room = roomId || (global.BunkerChat && global.BunkerChat.currentRoomId) || 'bunker_main';
      if (st.active && st.roomId === room && !st.suspended) { showBunker(roomName); return true; }
      if (st.active) this.leave({ silent: true });

      st.roomId = room;
      st.owner = 'room:' + room;
      st.live = false; st.micMuted = false; st.camOff = false; st.profile = 'high';
      showBunker(roomName || room);

      // El socket de texto debe pertenecer a esta sala (la señalización usa currentRoomId).
      if (global.BunkerChat.currentRoomId !== room || !global.BunkerChat.text) global.BunkerChat.initGlobal(null, null, room, roomName);

      try {
        st.stream = await acquireLocal();
      } catch (e) {
        B().haptic('error');
        toast((app() && app().getTrans('toast_cam_error')) || '⚠️ Permiso de cámara denegado o no disponible.');
        this.leave({ silent: true });
        return false;
      }
      st.active = true;
      st.suspended = false;
      attachLocal(st.stream);
      updateToggles();
      loadIce();
      send({ type: 'join_video' });
      B().setClosingConfirmation(true);
      B().haptic('success');
      return true;
    },

    leave(opts) {
      const wasActive = st.active;
      closeAllPeers();
      if (st.owner) global.MediaManager.release(st.owner);
      if (global.BunkerChat && global.BunkerChat.signal) global.BunkerChat.closeSignal();
      st.active = false; st.suspended = false; st.stream = null; st.live = false;
      const v = $('bunker-webcam-feed'); if (v) { v.srcObject = null; v.classList.add('hidden'); }
      const ph = $('cam-loading-placeholder'); if (ph) ph.classList.remove('hidden');
      const bunker = $('floating-video-bunker'); if (bunker) { bunker.classList.add('hidden'); bunker.classList.remove('video-hidden'); }
      const tab = $('floating-video-tab'); if (tab) tab.style.display = 'none';
      if (app()) app().isVideoMinimized = false;
      B().setClosingConfirmation(false);
      if (wasActive && !(opts && opts.silent)) B().haptic('light');
    },

    goLive() {
      if (!st.active) return;
      st.live = true;
      send({ type: 'go_live' });
      setBadge(true);
      const goLive = $('btn-go-live'); if (goLive) goLive.classList.add('hidden');
      const cancel = $('btn-cancel-stream'); if (cancel) cancel.classList.remove('hidden');
      B().haptic('heavy');
    },

    stopLive() {
      st.live = false;
      send({ type: 'stop_live' });
      setBadge(false, st.roomId);
      const goLive = $('btn-go-live'); if (goLive) goLive.classList.remove('hidden');
      const cancel = $('btn-cancel-stream'); if (cancel) cancel.classList.add('hidden');
    },

    toggleMic() {
      const t = st.stream && st.stream.getAudioTracks()[0];
      if (!t) return;
      st.micMuted = !st.micMuted;
      t.enabled = !st.micMuted;
      updateToggles();
      B().haptic('light');
    },

    toggleCam() {
      const t = st.stream && st.stream.getVideoTracks()[0];
      if (!t) return;
      st.camOff = !st.camOff;
      t.enabled = !st.camOff;
      updateToggles();
      B().haptic('light');
    },

    /** Cambia cámara/micrófono sin renegociar: replaceTrack en todos los peers. */
    async switchDevices() {
      if (!st.active) return false;
      const old = st.stream;
      let fresh;
      try { fresh = await acquireLocal(); } catch (_) { toast('⚠️ No se pudo abrir el dispositivo seleccionado.'); return false; }
      const vNew = fresh.getVideoTracks()[0] || null;
      const aNew = fresh.getAudioTracks()[0] || null;
      for (const peer of st.peers.values()) {
        for (const s of peer.pc.getSenders()) {
          if (!s.track) continue;
          try { await s.replaceTrack(s.track.kind === 'video' ? vNew : aNew); } catch (e) { console.warn('[RoomVideo] replaceTrack', e); }
        }
      }
      if (old) old.getTracks().forEach((t) => t.stop());
      st.stream = fresh;
      st.micMuted = false; st.camOff = false;
      attachLocal(fresh);
      updateToggles();
      return true;
    },

    /** Mensajes del socket de señalización. Devuelve true si los consumió. */
    onSignal(data) {
      if (!data || !data.type) return false;
      const from = data.caller_id != null ? String(data.caller_id) : null;
      if (from && from === myId()) return true;
      switch (data.type) {
        case 'video_peers':
          (data.peers || []).forEach((p) => {
            const id = String(p.user_id);
            renderPresence({ user_id: id, name: p.name, status: p.live ? 'live' : 'online' });
            if (id !== myId() && st.active && !st.suspended) createPeer(id, p.name, true);
          });
          return true;
        case 'radar_update':
          renderPresence(data);
          return true;
        case 'webrtc_offer': if (from) onOffer(from, data.sdp, data.name); return true;
        case 'webrtc_answer': if (from) onAnswer(from, data.sdp); return true;
        case 'webrtc_ice': if (from) onIce(from, data.candidate); return true;
        case 'peer_left': if (data.user_id != null) closePeer(String(data.user_id)); return true;
        default: return false;
      }
    },

    onPresence(data) { renderPresence(data); },

    onSignalReconnected() {
      // El servidor reenviará video_peers tras el join_video automático; los peers
      // viejos quedaron huérfanos → se cierran para renegociar limpio.
      closeAllPeers();
    },
  };

  // ---------------------------------------------------------------- ciclo de vida
  function bindLifecycle() {
    if (!B()) return;
    B().on('app:inactive', () => {
      if (!st.active || cfg().features.videoPersistentInBackground) return;
      st.suspended = true;
      closeAllPeers();
      if (st.owner) global.MediaManager.release(st.owner);
      st.stream = null;
      send({ type: 'leave_video' });
    });
    B().on('app:active', () => {
      if (!st.active || !st.suspended) return;
      const room = st.roomId;
      st.active = false;
      toast('Reconectando video…');
      RoomVideo.join(room);
    });
    B().on('app:terminate', () => { if (st.active) RoomVideo.leave({ silent: true }); });
  }
  bindLifecycle();

  global.RoomVideo = RoomVideo;
})(window);
