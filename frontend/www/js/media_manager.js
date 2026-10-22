/**
 * js/media_manager.js — Propiedad explícita de cámara, micrófono y RTCPeerConnection.
 *
 * Problema v1: getUserMedia se llamaba desde varios flujos (preview, sala, videollamada)
 * y no todos ejecutaban track.stop(); al minimizar la Mini App o cambiar de vista la
 * cámara seguía encendida (LED activo, batería, y en iOS bloqueo de otras apps).
 *
 * Regla: TODO stream se pide a través de MediaManager.acquire(owner, …) y se libera con
 * MediaManager.release(owner). Al pasar la app a segundo plano se liberan los owners
 * no marcados como persistentes.
 *
 * Uso:
 *   const stream = await MediaManager.acquire('room:party_time', { video: true, audio: true });
 *   const pc = MediaManager.trackPeer('room:party_time', new RTCPeerConnection(cfg));
 *   …
 *   MediaManager.release('room:party_time');   // al salir de la sala
 */
(function (global) {
  'use strict';

  const owners = new Map(); // owner -> { streams:Set, peers:Set, persistent:bool }

  function entry(owner) {
    if (!owners.has(owner)) owners.set(owner, { streams: new Set(), peers: new Set(), persistent: false });
    return owners.get(owner);
  }

  function stopStream(stream) {
    try { stream.getTracks().forEach((t) => { t.onended = null; t.stop(); }); } catch (_) {}
  }

  function closePeer(pc) {
    try {
      pc.getSenders().forEach((s) => { try { if (s.track) s.track.stop(); } catch (_) {} });
      pc.ontrack = pc.onicecandidate = pc.onconnectionstatechange = null;
      pc.close();
    } catch (_) {}
  }

  const MediaManager = {
    /**
     * @param {string} owner  identificador de la vista/flujo dueño del stream
     * @param {MediaStreamConstraints} constraints
     * @param {{persistent?: boolean}} [opts] persistent=true mantiene el stream en
     *        segundo plano (solo para una llamada activa con audio).
     */
    async acquire(owner, constraints, opts) {
      if (!global.navigator.mediaDevices || !global.navigator.mediaDevices.getUserMedia) {
        throw new Error('MEDIA_UNSUPPORTED');
      }
      const stream = await global.navigator.mediaDevices.getUserMedia(constraints);
      const e = entry(owner);
      e.persistent = !!(opts && opts.persistent);
      e.streams.add(stream);
      stream.getTracks().forEach((t) => {
        t.onended = () => {
          if (stream.getTracks().every((x) => x.readyState === 'ended')) e.streams.delete(stream);
        };
      });
      return stream;
    },

    trackPeer(owner, pc) {
      entry(owner).peers.add(pc);
      return pc;
    },

    releasePeer(owner, pc) {
      const e = owners.get(owner);
      if (e && e.peers.delete(pc)) closePeer(pc);
    },

    release(owner) {
      const e = owners.get(owner);
      if (!e) return;
      e.peers.forEach(closePeer);
      e.streams.forEach(stopStream);
      owners.delete(owner);
      // Desacoplar <video> que aún referencien streams detenidos.
      global.document.querySelectorAll('video').forEach((v) => {
        if (v.srcObject && v.srcObject.getTracks().every((t) => t.readyState === 'ended')) v.srcObject = null;
      });
    },

    releaseAll(includePersistent) {
      Array.from(owners.keys()).forEach((o) => {
        if (includePersistent || !owners.get(o).persistent) this.release(o);
      });
    },

    activeOwners() { return Array.from(owners.keys()); },
  };

  // Ciclo de vida: integrado con AppBridge si está presente, si no con el DOM.
  function onInactive() { MediaManager.releaseAll(false); }
  function onTerminate() { MediaManager.releaseAll(true); }

  if (global.AppBridge) {
    global.AppBridge.on('app:inactive', onInactive);
    global.AppBridge.on('app:terminate', onTerminate);
  } else {
    global.document.addEventListener('visibilitychange', () => {
      if (global.document.visibilityState === 'hidden') onInactive();
    });
    global.addEventListener('pagehide', onTerminate);
  }

  global.MediaManager = MediaManager;
})(window);
