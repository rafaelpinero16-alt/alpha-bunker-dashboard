# Auditoría de integración — MINI APP ALPHA v2 → v2.1

Fecha: 21-oct-2026 · Alcance: `app.js` (app_5), `hybrid_bridge.js`, `api_v2.js`, `chat_v2.js`, `media_manager.js`, `translations.js` (translations_2), `style.css` (style_2).

## Veredicto

Los módulos v2 (`hybrid_bridge`, `api_v2`, `chat_v2`, `media_manager`) están bien diseñados, pero **`app.js` no los usa**: sigue siendo el cliente v1. Hace 27 `fetch` directos al backend legacy enviando `user_id`, decide precios y niveles en el cliente, y llama a una API de chat (`BunkerChat.globalSocket`) que `chat_v2.js` no expone. Con los archivos tal como están, la app **no funciona** (el chat de salas no envía mensajes) y **no es segura** (cualquiera puede transferir saldo ajeno).

La solución entregada no reescribe `app.js`: añade `app_secure.js`, que sustituye en runtime los métodos afectados, más parches puntuales en los módulos v2.

---

## A. Críticos (seguridad / dinero)

| # | Hallazgo | Dónde | Corrección |
|---|---|---|---|
| A1 | **Robo de saldo**: `/wallet/transfer` acepta `sender_id` del cliente. Cualquiera puede mandar propinas desde la cuenta de otro. | `sendCustomTip`, `sendTipFromPost` | `AlphaApi.tip()` → `/v2/wallet/tip` (emisor = token). |
| A2 | **Retiros suplantables**: `/wallet/request-payout` con `user_id` en el body. | `requestPayoutFromSettings` | `/v2/wallet/payouts`; rol+KYC validados en servidor. |
| A3 | **Precio TON decidido por el cliente**: `create-transaction` recibe `price_ton`, `alpha_total`, `level`; `/payments/ton/verify` recibe `level`. | `rechargeAlphaCoins` | `AppBridge.payTon(slug)`; el servidor fija importe y verifica on-chain. |
| A4 | **Ascenso de rango sin pago confirmado**: el callback `openInvoice → 'paid'` muestra el ascenso sin que el backend lo haya confirmado. | `buyPackageStars` | `AppBridge.payStars` + `pollOrder`; el rango se lee de `/v2/auth/me`. |
| A5 | **Admin en el cliente**: IDs fijos (`8269470905`, `123456789`) o `localStorage.alpha_user_name === 'Tel: +57…'` dan rol admin y tier 4. Expone además un teléfono personal en el bundle. | `initUserId` | Rol solo desde `/v2/auth/me`. **Borra ese número del código fuente publicado.** |
| A6 | **Identidad falsificable**: `initUserId` usa `initDataUnsafe.user.id` o genera `99xxxxxx`; se envía como `user_id`. | `initUserId`, todos los fetch | Identidad = JWT emitido tras validar `initData` (HMAC) en servidor. |
| A7 | **Contenido de pago filtrado**: los posts bloqueados se envían con `media_url` real y solo se desenfocan con CSS. | `buildFeedHTML`, `viewCreatorProfile` | El render usa solo `preview_url`. **El backend no debe enviar `media_url` de posts bloqueados.** |
| A8 | **XSS almacenado**: nombres, IDs y URLs de otros usuarios se interpolan dentro de `onclick="…'${x}'…"`. `escapeHtml` no protege ese contexto (el parser HTML decodifica `&#39;` antes de ejecutar JS). Afecta: feed (URL de lightbox sin escapar), chat (`author_name`), radar, bandeja de DMs, perfil de creador (`setAttribute('onclick', …)` con nombre crudo), menú de propinas, catálogo. | varios | Delegación por `data-act` + `escapeHtml` solo en contexto HTML/atributo. |
| A9 | **Wallet TON sin prueba de propiedad**: `/wallet/connect-ton` vincula cualquier dirección. | `initTonConnect` | `ton_proof` (TonConnect `setConnectRequestParameters`) verificado en servidor. |
| A10 | Contraseña guardada en claro en `localStorage` y validada en el cliente. | `updatePasswordSettings` | `/v2/auth/change-password`; oculto en TMA. |
| A11 | Media como `data:URL` dentro de JSON/WebSocket (videos de hasta 20 MB → ~27 MB base64 por frame). | chat, posts, avatar | `AlphaApi.uploadMedia` con URL prefirmada. |

## B. Fallos funcionales (la app no hace lo que parece)

| # | Hallazgo | Efecto | Corrección |
|---|---|---|---|
| B1 | `app.js` consulta `BunkerChat.globalSocket` (6 sitios); `chat_v2` no lo define. | `sendGlobalChatMessage` cree que no hay conexión, **reinicia la sala en cada envío** y el mensaje nunca sale. Propinas en vivo siempre fallan. | Getter de compatibilidad + overrides que usan `sendGlobal`. |
| B2 | `sendGlobal(JSON.stringify({type:'webrtc_offer'…}))`: `chat_v2` trata el string como `{text}`. | **La señalización WebRTC, `join_video`, `radar_update` se publican como mensajes de chat** visibles; el video nunca conecta. | `chat_v2` parsea y enruta tipos de señalización al socket de video. |
| B3 | `managedSocket.send` devolvía `false` si el socket no estaba `OPEN`. | La primera oferta/ICE tras `openSignal()` se perdía. | Cola de salida (100 msgs) con flush en `onopen`. |
| B4 | Historial de sala cargado dos veces (app con endpoint legacy + chat_v2) y duplicado al reconectar. | Mensajes repetidos. | Solo chat_v2, limpieza al reconectar, dedupe por `data-msg-id`. |
| B5 | Historial de DMs nunca se carga. | Conversación vacía al abrirla. | `loadDmHistory` + recarga al reconectar. |
| B6 | `getTrans` devuelve la clave si falta; 24 claves usadas no existen. | El usuario ve `toast_invoice_gen`, `cat_title`… y el patrón `getTrans(k) \|\| 'texto'` nunca aplica. | `getTrans` → `''` con fallback en→es; `translations_patch.js` añade las claves; corrige `fr.no_contacts/no_recent_tx` (estaban en inglés). |
| B7 | Navegación: `history.go(-n)` dispara un único `popstate`, la pila solo bajaba un nivel. | BackButton desincronizado. | `popstate` usa `state.depth`. |
| B8 | Ningún modal de `app.js` usa `AppBridge.navigation`. | BackButton de Telegram nunca aparece; atrás de Android cierra la app. | `ui_bridge.js` observa los modales y apila/desapila automáticamente. |
| B9 | `handleAvatarChange` llama a `previewImage` (que rellena `tempPostMedia`). | Cambiar avatar adjunta la foto al próximo post. | Override: sube avatar y actualiza perfil. |
| B10 | `prompt()` / `confirm()` del navegador. | En clientes Telegram pueden no mostrarse. | `UI.confirm/alert` → `showConfirm/showAlert` (≥6.2); `UI.form` con MainButton. |
| B11 | `loginWithPhone/registerWithData` solo cambiaban de vista. | Login sin autenticación. | Formularios reales contra `/v2/auth/*`; login con Telegram en Standalone vía bot. |
| B12 | Enlace de referido `t.me/bot?start=ref_…` abre el chat del bot, no la Mini App. | Referidos perdidos. | `t.me/<bot>/<app>?startapp=<code>`. |

## C. Hardware y video

| # | Hallazgo | Corrección |
|---|---|---|
| C1 | `requestAndLoadMedia`, `applyAVSettings`, `startGlobalSelfieCam`, `populateMediaDevices` llaman a `getUserMedia` fuera de `MediaManager`. La selfie nunca libera la cámara; abrir Ajustes enciende la cámara para leer etiquetas. | Todo vía `RoomVideo` → `MediaManager`; selfie con `<input capture>`; Ajustes sin sondeo. |
| C2 | Peers creados por `app.createPeerConnection` no registrados en `MediaManager`: al minimizar quedan abiertos. | `trackPeer`/`releasePeer`; suspensión y re-join en `app:inactive/active`. |
| C3 | Solo STUN. Sin TURN, gran parte de llamadas en redes móviles (NAT simétrico/CGNAT) no conectan. | `/v2/video/ice-servers` con credenciales TURN temporales (coturn REST). |
| C4 | ICE aplicados antes de `remoteDescription` (excepción silenciada). | Cola de ICE por peer. |
| C5 | Cambio de cámara detenía pistas sin `replaceTrack`. | `RoomVideo.switchDevices()` con `replaceTrack`. |
| C6 | Colisión de ofertas (ambos peers ofertan). | Perfect negotiation simplificada (polite/impolite por ID). |
| C7 | Mesh P2P: cada participante sube N-1 flujos. | Límite configurable (`maxMeshPeers=6`) y 640×360 / 600 kbps. Para salas grandes: SFU (LiveKit/mediasoup). |

## D. Cumplimiento y plataforma

- **Pagos dentro de Telegram**: Telegram exige Telegram Stars para bienes y servicios digitales dentro de bots/Mini Apps. Los botones Skrill/Binance/Payoneer/ACH quedan **ocultos dentro de Telegram** (`features.externalGatewaysInTelegram=false`) y visibles solo en Standalone. Si publicas el APK en Google Play, revisa su política de facturación para contenido digital; para distribución fuera de Play (APK directo) no aplica.
- **Las pasarelas externas no acreditan nada automáticamente**: los enlaces Skrill/Binance son estáticos, sin referencia al usuario. Necesitan conciliación manual o webhooks del proveedor.
- **Telegram no ofrece API de videollamadas ni de grupos para Mini Apps.** Lo nativo que sí aplica a estas secciones: `openTelegramLink` para unirse a grupos/canales (ya usado por `AppBridge.openLink`), `HapticFeedback`, `BackButton` (minimiza el búnker de video), `enableClosingConfirmation` durante video y pagos, `showConfirm/showAlert`, `MainButton` en formularios.
- **Verificación de edad**: el consentimiento vivía solo en `localStorage`. Ahora se persiste en servidor (`age_confirmed`), y el backend debe exigirlo para contenido restringido.
- **Blur de privacidad en `blur`/`focus`** (DOMContentLoaded de app.js): se dispara al abrir `openInvoice`, TonConnect o el permiso de cámara, dejando la pantalla negra. Recomendado: conservar solo el de `visibilitychange`.

## E. Verificación realizada

`smoke.js` carga los 11 scripts en el orden de producción sobre un DOM simulado con Telegram WebApp, red `/v2` y WebSocket simulados. **52/52 comprobaciones superadas (incluye orden de scripts de index.html)**, entre ellas: identidad desde servidor, ningún request con `user_id`, XSS escapado, post bloqueado sin `media_url`, endpoint legacy bloqueado (410), señalización fuera del chat, rango solo tras `pollOrder`, `enableClosingConfirmation` durante el pago, 402 en propina y desapilado correcto de la navegación.

No sustituye pruebas en dispositivos reales (cámara, `openInvoice`, TonConnect, Android WebView) — ver checklist en `IMPLEMENTACION.md`.
