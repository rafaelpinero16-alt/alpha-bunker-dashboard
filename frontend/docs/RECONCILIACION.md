# Reconciliación producción (Vercel) ↔ arquitectura v2 — Alpha Bunker v2.3

Fecha: 22-oct-2026. Comparación del código desplegado hoy en Vercel contra todo lo construido en v2.0 → v2.2.

## 1. Diagnóstico: producción sigue en v1

| Archivo en producción | Comparación | Estado |
|---|---|---|
| `js/app.js` | **idéntico byte a byte** al usado como base desde v2.0 | Se conserva; `app_secure.js` sustituye en runtime sus métodos inseguros |
| `index.html` | **idéntico** al recibido antes de la integración v2 | Sustituir por el de v2.3 (scripts v2, CSP, `data-i18n`) |
| `js/translations.js`, `css/style.css` | idénticos | Se conservan |
| `js/api.js`, `js/chat.js`, `js/security.js` | **son los v1 originales** | **Eliminar**: sustituidos por `api_v2.js`, `chat_v2.js`, `hybrid_bridge.js`, `app_secure.js` |
| `_redirects` | formato Netlify/Cloudflare | **Eliminar**: Vercel lo ignora → `vercel.json` |
| `sw.js` v31 | cachea `api.js`/`chat.js`/`security.js` | Sustituir por v51 (borra cachés antiguas) |
| `manifest.json`, `404.html`, `privacy.html`, `terms.html` | — | Se conservan (`manifest`: `purpose: "any"`) |

Ninguna de las correcciones de seguridad v2 (robo de saldo vía `sender_id`, precios TON del cliente, admin por ID fijo, XSS, señalización WebRTC en el chat) está activa en producción.

## 2. Áreas pedidas

### 2.1 API y estado — rutas de propinas

Producción tiene **tres rutas distintas** para lo mismo, todas con identidad enviada por el cliente:

| Origen | Ruta | Problema |
|---|---|---|
| `api.js` `sendAlphaTip` | `POST /wallet/send-tip` `{sender_id,…}` | `sender_id` falsificable |
| `app.js` `sendCustomTip`, `sendTipFromPost` | `POST /wallet/transfer` `{sender_id,…}` | ídem; `api.js` no se usa |
| `app.js` `saveAllTipSlots` | `POST /creators/tip-menu/update` ×10 `{user_id,…}` | 10 peticiones, `user_id` falsificable |

**Flujo único v2** (`AlphaApi`, consumido solo a través de `app_secure.js`): `POST /v2/wallet/tip` (emisor = token, idempotente con `client_ref`) y `PUT /v2/creators/me/tip-menu` (los 10 slots en una petición). `app.js` ya no hace `fetch` propio: `app_secure.js` bloquea en runtime cualquier llamada al backend fuera de `/v2` (`features.blockLegacyEndpoints`).

**Rutas relativas / "backend en Vercel":** el backend está en **Render** (`alpha-bunker-backend.onrender.com`); Vercel solo sirve el frontend. Una ruta relativa (`/v2/...`) iría a Vercel y devolvería 404, y en el APK (origen `https://localhost`) no apuntaría a ningún servidor. La base absoluta de `config.js` es la correcta para TMA, web y APK.

### 2.2 WebSockets y WebRTC

| Punto | v1 en producción | v2.3 |
|---|---|---|
| Reintentos | 10 con 2 s fijos, `initGlobal` recursivo que **vacía el chat** y reconstruye el título en cada intento | 10 con backoff exponencial + jitter (máx. 30 s); al agotarse queda en pausa, sin bucle; se reanuda con `online`, al volver a primer plano o con `BunkerChat.reconnectAll()` |
| Identidad | `wss://…/chat/ws/{user_id}` (cualquiera escucha los DMs de otro) | ticket de un solo uso emitido por el backend |
| Aislamiento de sala | `room_id` en el payload y filtro en cliente (`data.room_id !== currentRoomId`) | la sala la fija la URL `/v2/chat/rooms/{sala}/text`; el servidor no puede cruzar salas |
| Las 6 salas | `bunker_main, letter_and_gear, alpha_clothes, sweat_and_thongs, slam, party_time` | mismas claves y nombres (`BunkerChat.roomNames`) |
| CRM / DMs | mismo socket que notificaciones, `target_id` del cliente | socket `/v2/chat/dm` independiente |
| Señalización | por el socket de texto → aparecía como mensajes | socket separado `/v2/video/rooms/{sala}/signal` |
| Malla P2P | sin tope, 640×360 fijo, sin TURN | máx. `maxMeshPeers` (6); presupuesto de subida 1,5 Mbps repartido (600→150 kbps/peer); con ≥3 peers baja a 480×270 @ 15 fps; TURN desde `/v2/video/ice-servers`; peers y pistas liberados vía `MediaManager` |

Por encima de 6 participantes con cámara una malla P2P no escala en móviles; el siguiente paso sería un SFU (LiveKit/mediasoup).

### 2.3 Orden de carga y `undefined`

- **Causa real** en producción: `app.js` se carga con `defer` y `security.js` sin él. `security.js` engancha sus wrappers en `DOMContentLoaded` y lee `typeof app`; funciona solo por el orden de eventos y, si falla, termina en silencio (`if (typeof app === 'undefined') return`).
- Además `security.js` **escapa el texto antes de enviarlo** (`<` → `&lt;`), así que los mensajes se guardaban escapados y se mostraban como `&lt;3`. Y guarda el rango en `localStorage` en base64 (editable por cualquiera) y lo **restaura** como nivel de acceso.
- **v2.3**: 11 scripts en orden fijo **sin `defer`** al final de `<body>` (`config → telegram-web-app + tonconnect-ui → translations(+patch) → hybrid_bridge → media_manager → api_v2 → chat_v2 → ui_bridge → webrtc_room → app → app_secure`). Cuando `app_secure.js` corre, `window.app` ya existe (lanza un error explícito si no). TonConnect se crea de forma perezosa en `initTonConnect()` solo si `TON_CONNECT_UI.TonConnectUI` existe; si no, aviso `toast_ton_not_loaded`.

### 2.4 3D y UI

- En el código **solo existe un componente 3D**: el splash (`initSplash3D`, Three.js r128). Las plantillas `video_call` y `wallet_card` que mencionas **no aparecen en ninguno de los archivos enviados**.
- El splash v1 creaba un `WebGLRenderer` nuevo en cada arranque, se congelaba a los 3 s aunque el splash siguiera visible (arranque en frío de Render ~1 min) y **nunca liberaba el contexto WebGL**. v2.3 (`Splash3D` en `app_secure.js`): un solo renderer, 30 fps, pausa en segundo plano, `dispose()` + `forceContextLoss()` al ocultar el splash, desactivado con `prefers-reduced-motion`.
- Los fuegos artificiales de subida de rango usan canvas 2D y terminan solos.
- `app.js` oscurecía la pantalla en `window.blur`, que también salta al abrir `openInvoice`, TonConnect o el permiso de cámara: el usuario pagaba a ciegas. Se mantiene el oscurecimiento al pasar a segundo plano y se anula el falso positivo.

## 3. Despliegue en Vercel

1. En el repositorio: **borra** `js/api.js`, `js/chat.js`, `js/security.js` y `_redirects`.
2. Copia el contenido del paquete (respetando carpetas). `.vercelignore` evita publicar `android/`, `docs/`, `scripts/`, `smoke.js`, `package.json`, etc.
3. Vercel → Project Settings: *Framework Preset* **Other**, *Build Command* vacío, *Output Directory* `.` (raíz).
4. `vercel.json` añade cabeceras: `no-cache` para HTML y `sw.js` (las actualizaciones llegan al instante), `frame-ancestors` limitado a Telegram (Telegram Web incrusta la Mini App en un iframe), `Permissions-Policy` de cámara/micrófono y CORS abierto para los manifiestos.
5. Tras desplegar, abre la Mini App una vez: el Service Worker v51 borra las cachés v31.
6. `node smoke.js` → **96 PASS, 0 FAIL**.

## 4. Pendiente de tu lado

- **Backend `/v2` en Render**: sigue siendo el requisito bloqueante (`docs/BACKEND_CONTRACT_V2.md`); sin él el frontend v2 muestra "Sin conexión".
- **Documento MINI APP ALPHA**: no llegó adjunto; si contiene reglas de diseño o seguridad adicionales, envíalo y se contrastan.
