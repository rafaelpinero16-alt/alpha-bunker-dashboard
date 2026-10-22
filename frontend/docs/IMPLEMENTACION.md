# Plan de implementación — Alpha Bunker híbrida (Telegram Mini App + APK)

## 0. Estructura final

```
www/                         ← webDir de Capacitor y raíz del hosting HTTPS de la Mini App
├── index.html               ← integrar index.scripts.html
├── css/style.css            (sin cambios)
├── css/hybrid.css           NUEVO
├── assets/…                 (badges, iconos)
└── js/
    ├── config.js            NUEVO   configuración única
    ├── translations.js      (sin cambios)
    ├── translations_patch.js NUEVO  24 claves faltantes + fix fr
    ├── hybrid_bridge.js     PARCHEADO  navegación, Capacitor, login vía bot
    ├── media_manager.js     (sin cambios)
    ├── api_v2.js            PARCHEADO  AlphaApi completo + subida de media
    ├── chat_v2.js           PARCHEADO  cola, enrutado de señalización, compat
    ├── ui_bridge.js         NUEVO   diálogos nativos, BackButton ↔ modales, MainButton
    ├── webrtc_room.js       NUEVO   video de salas sobre MediaManager
    ├── app.js               (app_5.js SIN cambios)
    └── app_secure.js        NUEVO   sustituye los métodos inseguros de app.js
smoke.js               NUEVO   node smoke.js
capacitor.config.json        NUEVO
tonconnect-manifest.json     NUEVO   (servir desde el backend)
android/app/src/main/AndroidManifest.xml  NUEVO  completo, listo para copiar
```

Elimina del proyecto `api.js` y `chat.js` v1 si aún existen.

## Fase 1 — Backend (bloqueante; sin esto el frontend no tiene a qué llamar)

1. Implementa las rutas de `docs/BACKEND_CONTRACT_V2.md` en el servicio de Render (FastAPI), bajo `/v2`.
2. Prioridad: `auth/telegram` (validación HMAC de initData) → `auth/me` → `ws-ticket` → WebSockets → `wallet/*` (ledger) → `payments/*` (webhook Stars + watcher TON) → `media/*` → resto.
3. Bot: configura el webhook para `pre_checkout_query` y `successful_payment`; `/start link_…`, `/start login_…`.
4. TURN: despliega coturn (`use-auth-secret`, puertos 3478 UDP/TCP y 5349 TLS) y expón `/v2/video/ice-servers`.
5. Sirve `tonconnect-manifest.json` con `Access-Control-Allow-Origin: *` y un icono PNG 180×180.
6. **Desactiva las rutas legacy** (`/wallet/transfer`, `/wallet/balance/{id}`, `/users/sync`, `/posts/create`, `/payments/ton/verify`…) o haz que devuelvan 410. Mientras existan, cualquiera puede llamarlas directamente aunque el frontend ya no lo haga.
7. Corrige el feed para no enviar `media_url` de posts bloqueados.

## Fase 2 — Ensamblar el frontend

1. Copia los archivos de `js/` y `css/` a `www/`.
2. Edita `js/config.js`: `apiBaseUrl`, `botUsername`, `miniAppShortName` (el que des en BotFather), `appScheme`.
3. `index.html` ya trae viewport, CSP, `hybrid.css` y el orden de scripts v2.
4. En la vista de login, apunta los botones a `app.loginWithEmail()`, `app.registerWithData()` y `app.loginWithTelegram()`.
5. Si tu formulario de publicación tiene campo de precio, dale `id="admin-price"`.
6. Recomendado en `app.js` (único cambio manual sugerido): en el `DOMContentLoaded`, borra las dos líneas `window.addEventListener('blur'…)` / `('focus'…)`; mantén `visibilitychange`.
7. Ejecuta `node smoke.js` desde la raíz del paquete: debe terminar en `52 PASS, 0 FAIL`.

## Fase 3 — Telegram Mini App

1. BotFather → `/newapp` (o `/myapps` → editar): URL HTTPS de `www/`, short name = `miniAppShortName`.
2. `/setdomain` del bot al dominio del hosting (necesario para login widget y TonConnect `twaReturnUrl`).
3. Activa pagos con Stars (no requiere proveedor; moneda `XTR`).
4. Abre `https://t.me/<bot>/<shortName>` y verifica: splash → feed sin pantalla de login, BackButton aparece al abrir un modal y lo cierra, compra con Stars de un paquete barato de prueba.
5. Depuración: Telegram Desktop/macOS con modo debug de WebView, o Android con `chrome://inspect` (habilitando depuración de WebView en ajustes avanzados de Telegram).

## Fase 4 — APK con Capacitor

```bash
npm init -y
npm i @capacitor/core @capacitor/cli @capacitor/android @capacitor/app @capacitor/preferences @capacitor/keyboard
npx cap init "Alpha Bunker" com.alphabunker.app --web-dir www
cp capacitor.config.json .           # sobrescribe el generado
npx cap add android
npx cap sync android
```

1. Copia los permisos de `native/AndroidManifest.snippets.xml` (cámara, micrófono, intent-filter `alphabunker://`, `<queries>` para wallets y Telegram).
2. Capacitor concede los permisos de `getUserMedia` a la WebView pidiendo los permisos runtime de Android; no hace falta plugin adicional.
3. `@capacitor/app` activa en `hybrid_bridge` el botón atrás físico (misma pila que BackButton) y `appStateChange` (libera cámara al minimizar).
4. Para el refresh token, sustituye `@capacitor/preferences` por un plugin de almacenamiento seguro (Keystore) cuando puedas; la interfaz `store` del bridge ya está aislada para ese cambio.
5. `npx cap open android` → Build → Generate Signed Bundle/APK. En release, `webContentsDebuggingEnabled: false`.
6. iOS (opcional): `npx cap add ios`, claves de `native/Info.plist.snippets.xml`.

En el APK los pagos funcionan así: **TON** directo con TonConnect (vuelve a la app vía `alphabunker://tonconnect`); **Stars** solo si la cuenta tiene Telegram vinculado (la factura se paga en la app de Telegram y el APK sondea la orden); pasarelas externas según `features.externalGatewaysStandalone`.

## Fase 5 — Checklist en dispositivos reales

| Prueba | TMA Android | TMA iOS | TMA Desktop | APK |
|---|---|---|---|---|
| Login automático / login email | ☐ | ☐ | ☐ | ☐ |
| BackButton / atrás físico cierra modal superior | ☐ | ☐ | ☐ | ☐ |
| Compra Stars → rango sube solo tras confirmación | ☐ | ☐ | ☐ | ☐ (vinculado) |
| TonConnect: conectar (ton_proof) + pagar + volver a la app | ☐ | ☐ | ☐ | ☐ |
| Sala: chat en vivo, sin mensajes "fantasma" de señalización | ☐ | ☐ | ☐ | ☐ |
| Video 3 personas, una en 4G (valida TURN) | ☐ | ☐ | ☐ | ☐ |
| Minimizar con cámara activa → LED se apaga → al volver reconecta | ☐ | ☐ | ☐ | ☐ |
| Cerrar con video activo pide confirmación | ☐ | ☐ | ☐ | — |
| Subida de foto/video/audio en chat y post | ☐ | ☐ | ☐ | ☐ |
| Nombre con `"><img src=x onerror=alert(1)>` se ve como texto | ☐ | ☐ | ☐ | ☐ |
| Pasarelas externas ocultas dentro de Telegram | ☐ | ☐ | ☐ | — |

## Fase 6 — Despliegue y operación

1. Despliega backend → frontend (el frontend v2.1 contra backend sin `/v2` no arranca: muestra error de red).
2. Deja `features.blockLegacyEndpoints = true`; en consola verás `[AlphaSecure] Endpoint legacy bloqueado` si algo olvidado lo intenta.
3. Monitoriza: órdenes `pending` > 10 min, fallos de `pre_checkout_query`, cierres WS 4403, ratio de ICE `failed` (si es alto, TURN no está bien).
4. Siguiente iteración (deuda técnica): migrar el HTML de `index.html` y las plantillas de `app.js` a `data-act` para poder quitar `'unsafe-inline'` de la CSP, y borrar de `app.js` el código ya sustituido.
