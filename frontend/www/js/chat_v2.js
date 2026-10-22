/**
 * js/chat_v2.js (v2.1) — Reemplazo de chat.js con la MISMA interfaz pública (BunkerChat.*).
 *   - WebSockets con ticket firmado de un solo uso (no /ws/{user_id});
 *   - texto y señalización de video en sockets separados por sala;
 *   - room_id lo fija la URL; el cliente ya no puede escribir en otra sala;
 *   - reconexión con backoff exponencial + jitter y heartbeat de presencia.
 *
 * Cambios v2.1 (auditoría):
 *   - Cola de salida: antes send() devolvía false si el socket no estaba OPEN y la
 *     primera oferta/ICE de WebRTC se perdía (openSignal() + send inmediato).
 *   - Compatibilidad con app.js legacy: sendGlobal(JSON.stringify({...})) ya NO se
 *     publica como texto de chat; se parsea y se enruta (señalización → socket de video).
 *   - Getter `globalSocket` de compatibilidad (app.js lo consultaba y nunca existía,
 *     lo que provocaba reconexión en cada mensaje y que no se enviara nada).
 *   - Re-join automático del video tras reconexión del socket de señalización.
 *   - Los mensajes del socket de señalización se entregan primero a window.RoomVideo.
 */
(function (global) {
  'use strict';
  const B = () => global.AppBridge;
  const appRef = () => (typeof global.app !== 'undefined' ? global.app : null);

  const SIGNAL_TYPES = ['webrtc_offer', 'webrtc_answer', 'webrtc_ice', 'join_video', 'leave_video', 'go_live', 'stop_live'];
  const MAX_QUEUE = 100;

  function backoff(attempt) {
    const base = Math.min(30000, 1000 * Math.pow(2, attempt));
    return base / 2 + Math.random() * (base / 2);
  }

  function uuid() {
    if (global.crypto && global.crypto.randomUUID) return global.crypto.randomUUID();
    return 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 12);
  }

  /** Socket con reconexión automática, ticket renovado en cada intento y cola de salida. */
  function managedSocket(path, onMessage, onOpen) {
    let ws = null, attempt = 0, closedByUser = false, heartbeat = null, timer = null;
    const queue = [];

    function flush() {
      while (queue.length && ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(queue.shift()));
    }

    async function connect() {
      if (closedByUser) return;
      try {
        const url = await B().wsUrl(path);
        if (closedByUser) return;
        ws = new WebSocket(url);
      } catch (e) {
        if (e && e.status === 401) return;  // sin sesión: no reintentar en bucle
        timer = setTimeout(connect, backoff(attempt++));
        return;
      }
      ws.onopen = () => {
        attempt = 0;
        clearInterval(heartbeat);
        heartbeat = setInterval(() => rawSend({ type: 'ping' }), 25000);
        if (onOpen) { try { onOpen(); } catch (e) { console.error(e); } }
        flush();
      };
      ws.onmessage = (ev) => {
        let data;
        try { data = JSON.parse(ev.data); } catch (_) { return; }
        if (data && data.type === 'pong') return;
        onMessage(data);
      };
      ws.onclose = (ev) => {
        clearInterval(heartbeat);
        // 4401 auth, 4403 rango/KYC, 4404 sala: reintentar no sirve.
        if (closedByUser || [4400, 4401, 4403, 4404].indexOf(ev.code) >= 0) {
          if (ev.code === 4403 && appRef()) appRef().showToast(ev.reason || 'Acceso restringido a esta sala.');
          queue.length = 0;
          return;
        }
        timer = setTimeout(connect, backoff(attempt++));
      };
      ws.onerror = () => { try { ws.close(); } catch (_) {} };
    }

    function rawSend(obj) {
      if (ws && ws.readyState === WebSocket.OPEN) { ws.send(JSON.stringify(obj)); return true; }
      return false;
    }

    /** Envía o encola. Devuelve true si se envió o quedó en cola. */
    function send(obj) {
      if (rawSend(obj)) return true;
      if (closedByUser) return false;
      if (queue.length >= MAX_QUEUE) queue.shift();
      queue.push(obj);
      return true;
    }

    function close() {
      closedByUser = true;
      queue.length = 0;
      clearTimeout(timer);
      clearInterval(heartbeat);
      if (ws) try { ws.close(1000); } catch (_) {}
    }

    function readyState() { return ws ? ws.readyState : WebSocket.CONNECTING; }

    connect();
    return { send, close, readyState };
  }

  /** Normaliza payloads legacy (string JSON) en objetos. */
  function normalize(payload) {
    if (payload && typeof payload === 'object') return Object.assign({}, payload);
    if (typeof payload === 'string') {
      const s = payload.trim();
      if (s.charAt(0) === '{') { try { const o = JSON.parse(s); if (o && typeof o === 'object') return o; } catch (_) {} }
      return { text: payload };
    }
    return {};
  }

  const BunkerChat = {
    dm: null,
    text: null,
    signal: null,
    inVideo: false,
    currentRoomId: 'bunker_main',
    activeTargetUserId: null,
    activeTargetName: null,

    roomNames: {
      bunker_main: 'Búnker Principal', letter_and_gear: 'Letter and gear', alpha_clothes: 'Alpha clothes',
      sweat_and_thongs: 'Sweat and thongs', slam: 'Slam', party_time: 'Party time',
    },
    getRoomDisplayName(id) { return this.roomNames[id] || (id ? id.replace(/_/g, ' ').toUpperCase() : 'SALA'); },

    /** Compat con app.js legacy (que consultaba BunkerChat.globalSocket.readyState). */
    get globalSocket() {
      if (!this.text) return null;
      const self = this;
      return { get readyState() { return self.text ? self.text.readyState() : 3; }, send(s) { return self.sendGlobal(s); } };
    },

    setTargetUser(targetId, targetName) {
      this.activeTargetUserId = targetId && !isNaN(targetId) ? String(targetId) : null;
      this.activeTargetName = targetName || 'Usuario';
      const h = document.getElementById('crm-chat-title') || document.getElementById('chat-title');
      if (h) h.textContent = this.activeTargetUserId ? 'CHAT CON @' + this.activeTargetName : 'DMs (MENSAJES DIRECTOS)';
      if (this.activeTargetUserId && this.dm) this.dm.send({ type: 'mark_read', target_id: Number(this.activeTargetUserId) });
    },

    // ---------------------------------------------------------- DMs
    initCRM() {
      if (this.dm) return;
      this.dm = managedSocket('/v2/chat/dm', (data) => {
        const app = appRef();
        if (!app) return;
        if (data.type === 'error') return app.showToast(data.message);
        if (data.type === 'messages_read') {
          document.querySelectorAll('.msg-status-indicator').forEach((el) => { el.textContent = 'R'; el.title = 'Leído'; });
          return;
        }
        const me = String(app.userId);
        const other = String(data.user_id) === me ? String(data.recipient_id) : String(data.user_id);
        if (this.activeTargetUserId && other === this.activeTargetUserId) {
          app.appendChatMessage(data, 'chat-messages');
          app.scrollToBottom('chat-messages');
          if (String(data.user_id) !== me) this.dm.send({ type: 'mark_read', target_id: Number(other) });
        } else if (String(data.user_id) !== me) {
          app.showToast('📩 Nuevo mensaje de @' + (data.author_name || other));
          if (B()) B().haptic('success');
        }
      }, () => {
        // Al (re)conectar, recargar historial de la conversación abierta.
        const app = appRef();
        if (app && this.activeTargetUserId && typeof app.loadDmHistory === 'function') app.loadDmHistory(this.activeTargetUserId);
      });
    },

    sendCRM(payload) {
      if (!this.activeTargetUserId) return false;
      if (!this.dm) this.initCRM();
      const obj = normalize(payload);
      if (!obj.text && !obj.media_url && !obj.media_id) return false;
      return this.dm.send({ type: 'dm', target_id: Number(this.activeTargetUserId), text: obj.text || '', media_url: obj.media_url || null, media_id: obj.media_id || null, client_ref: uuid() });
    },

    // ---------------------------------------------------------- salas
    initGlobal(_ignoredUserId, _ignoredBaseUrl, roomId, customRoomName) {
      const nextRoom = roomId || 'bunker_main';
      // Re-entrar a la misma sala con el socket vivo no debe tumbar la conexión.
      if (this.text && this.currentRoomId === nextRoom && this.text.readyState() <= 1) return;
      this.leaveRoom();
      this.currentRoomId = nextRoom;
      const name = customRoomName || this.getRoomDisplayName(this.currentRoomId);
      const title = document.getElementById('global-chat-title') || document.getElementById('room-chat-title');
      if (title) title.textContent = name.toUpperCase();
      const box = document.getElementById('global-chat-messages');
      if (box) box.textContent = '';

      const room = encodeURIComponent(this.currentRoomId);
      this.text = managedSocket('/v2/chat/rooms/' + room + '/text', (data) => this._onText(data), async () => {
        try {
          const h = await B().authFetch('/v2/chat/rooms/' + room + '/history?limit=50');
          const app = appRef();
          const target = document.getElementById('global-chat-messages');
          if (app && target) {
            target.textContent = '';  // evita duplicados al reconectar
            (h.messages || []).forEach((m) => app.appendChatMessage(m, 'global-chat-messages'));
            app.scrollToBottom('global-chat-messages');
          }
        } catch (_) { /* historial opcional */ }
      });
    },

    _onText(data) {
      const app = appRef();
      if (!app) return;
      if (data.type === 'error') return app.showToast(data.message);
      if (data.type === 'online_count_update') {
        const el = document.getElementById('online-users-count');
        if (el) el.textContent = data.count;
        return;
      }
      if (data.type === 'presence' && global.RoomVideo) return global.RoomVideo.onPresence(data);
      if (data.type === 'message_deleted') {
        const el = document.querySelector('[data-msg-id="' + Number(data.id) + '"]');
        if (el) el.remove();
        return;
      }
      if (data.type === 'live_tip_alert') {
        if (B()) B().haptic('success');
        return app.showToast('🔥 @' + data.sender_name + ' envió ' + data.amount + ' $ALPHA');
      }
      app.appendChatMessage(data, 'global-chat-messages');
      app.scrollToBottom('global-chat-messages');
    },

    sendGlobal(payload) {
      const obj = normalize(payload);
      if (obj.type && SIGNAL_TYPES.indexOf(obj.type) >= 0) return this.sendSignal(obj);
      if (obj.type === 'radar_update') return false;            // la presencia la emite el servidor
      if (!this.text) return false;
      if (obj.type === 'live_tip') {
        return this.text.send({ type: 'live_tip', target_id: Number(obj.target_id), amount: Number(obj.amount), client_ref: obj.client_ref || uuid() });
      }
      if (!obj.text && !obj.media_url && !obj.media_id) return false;
      return this.text.send({ type: 'chat', text: obj.text || '', media_url: obj.media_url || null, media_id: obj.media_id || null, client_ref: uuid() });
    },

    // ---------------------------------------------------------- video (señalización separada)
    openSignal() {
      if (this.signal) return this.signal;
      const room = encodeURIComponent(this.currentRoomId);
      this.signal = managedSocket('/v2/video/rooms/' + room + '/signal', (data) => {
        const app = appRef();
        if (data.type === 'error') { if (app) app.showToast(data.message); return; }
        if (global.RoomVideo && global.RoomVideo.onSignal(data)) return;
        if (!app) return;
        if (data.type === 'radar_update' && app.handleRadarUpdate) return app.handleRadarUpdate(data);
        if (data.type && data.type.indexOf('webrtc_') === 0 && app.handleWebRTCMessage) return app.handleWebRTCMessage(data);
      }, () => {
        // Reconexión: el servidor perdió nuestro estado de sala → re-anunciarse.
        if (this.inVideo) this.signal.send({ type: 'join_video' });
        if (global.RoomVideo) global.RoomVideo.onSignalReconnected();
      });
      return this.signal;
    },

    sendSignal(obj) {
      if (obj && obj.type === 'join_video') this.inVideo = true;
      if (obj && obj.type === 'leave_video') this.inVideo = false;
      const clean = Object.assign({}, obj);
      delete clean.room_id;   // la sala la fija la URL del socket
      delete clean.user_id;   // la identidad la fija el ticket
      delete clean.caller_id;
      return this.openSignal().send(clean);
    },

    closeSignal() {
      if (this.signal) { this.signal.send({ type: 'leave_video' }); this.signal.close(); this.signal = null; }
      this.inVideo = false;
      if (global.MediaManager) global.MediaManager.release('room:' + this.currentRoomId);
    },

    switchRoom(roomId, roomName) {
      const app = appRef();
      if (app) app.currentRoomId = roomId;
      this.initGlobal(null, null, roomId, roomName);
    },

    leaveRoom() {
      if (global.RoomVideo && global.RoomVideo.isActive()) global.RoomVideo.leave({ silent: true });
      this.closeSignal();
      if (this.text) { this.text.close(); this.text = null; }
    },

    closeConnections() {
      this.leaveRoom();
      if (this.dm) { this.dm.close(); this.dm = null; }
    },
  };

  /** Inserta texto de usuario sin interpretar HTML. */
  global.renderSafeText = function (el, text) { el.textContent = text == null ? '' : String(text); };

  global.BunkerChat = BunkerChat;
})(window);
