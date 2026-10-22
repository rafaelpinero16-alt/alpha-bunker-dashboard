/**
 * js/config.js — Configuración única de la app híbrida (TMA + APK). Se carga PRIMERO.
 * Nada de aquí es secreto: todo lo sensible vive en el backend.
 */
window.ALPHA_CONFIG = Object.freeze({
  // Backend REST (Render · FastAPI). Todas las rutas usadas cuelgan de /v2.
  apiBaseUrl: 'https://alpha-bunker-backend.onrender.com',

  // WebSockets (mismo servicio de Render, protocolo seguro wss://).
  // Rutas: /v2/chat/dm · /v2/chat/rooms/{sala}/text · /v2/video/rooms/{sala}/signal
  wsBaseUrl: 'wss://alpha-bunker-backend.onrender.com',

  // Bot y Mini App (BotFather → /newapp). Enlace de la Mini App: t.me/<bot>/<shortName>
  botUsername: 'Alpha_store_botbot',
  miniAppShortName: 'app',

  // TonConnect: el manifest debe ser público, HTTPS y con CORS abierto.
  // El backend de Render debe servir este archivo en la raíz (GET /tonconnect-manifest.json).
  tonManifestUrl: 'https://alpha-bunker-backend.onrender.com/tonconnect-manifest.json',

  // Esquema de deep link del APK (AndroidManifest.xml → intent-filter "alphabunker").
  appScheme: 'alphabunker',

  colors: { header: '#000000', background: '#050505', bottomBar: '#050505' },

  // Tiempo máximo por petición HTTP. Render (plan gratuito) apaga el servicio tras 15 min
  // sin tráfico y tarda ~1 min en arrancar: 65 s cubre ese arranque en frío. Con una
  // instancia de pago (siempre activa) puedes bajarlo a 15000.
  timeoutMs: 65000,

  features: {
    // Telegram exige Stars para bienes/servicios digitales dentro de Mini Apps.
    // Mantén las pasarelas externas desactivadas dentro de Telegram.
    externalGatewaysInTelegram: false,
    externalGatewaysStandalone: true,
    // true = la cámara sigue activa si la app pasa a segundo plano (solo si lo necesitas).
    videoPersistentInBackground: false,
    // Máximo de participantes con cámara en una sala mesh P2P (por encima → usar SFU).
    maxMeshPeers: 6,
    // Login con Telegram en el APK/web (vía bot + deep link alphabunker://login).
    // Requiere /v2/auth/telegram/login-intent en el backend; si no existe, el botón se
    // desactiva solo y se muestra el aviso. Pon false para ocultar el flujo desde el inicio.
    telegramLoginStandalone: true,
    // Bloquea en runtime cualquier fetch al backend fuera de /v2 (red de seguridad).
    blockLegacyEndpoints: true,
  },
});
