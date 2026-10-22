# APK Android — iconos, splash, depuración y causas de "congelamiento"

## 1. Icono y splash propios (adiós al logo de Capacitor)

`@capacitor/assets` genera todos los tamaños de Android (mipmap-*, adaptive icons, splash de Android 12+) a partir de imágenes fuente en una carpeta del proyecto. Usamos **`resources/`** para no mezclarla con `assets/`, que es la carpeta de imágenes de la web.

### Opción A — generar las fuentes desde tu logo (recomendada)

```bash
npm install                                     # instala @capacitor/assets y sharp (devDependencies)
npm run assets:sources -- assets/logo.png       # o assets/logo.jpg; ideal ≥ 1024×1024 px
npm run assets:android                          # genera icono + splash en android/app/src/main/res
npx cap sync android
```

`assets:sources` crea en `resources/`:

| Archivo | Tamaño | Uso |
|---|---|---|
| `icon-only.png` | 1024×1024 | icono clásico (Android < 8) |
| `icon-foreground.png` | 1024×1024 | capa delantera del icono adaptativo (logo al 66 %, zona segura) |
| `icon-background.png` | 1024×1024 | capa trasera, color `#050505` |
| `splash.png` / `splash-dark.png` | 2732×2732 | splash claro/oscuro, logo centrado |

### Opción B — preparar las imágenes a mano

Crea `resources/` con esos cinco archivos (PNG, mismos tamaños) y ejecuta exactamente:

```bash
npx @capacitor/assets generate --android --assetPath resources \
  --iconBackgroundColor "#050505" --iconBackgroundColorDark "#050505" \
  --splashBackgroundColor "#050505" --splashBackgroundColorDark "#050505"
npx cap sync android
```

### Si sigue apareciendo el logo de Capacitor

1. **Desinstala** la app del teléfono antes de instalar el nuevo APK: el launcher de Android cachea el icono.
2. En Android Studio: **Build → Clean Project** y vuelve a generar el APK.
3. Comprueba que existan `android/app/src/main/res/mipmap-anydpi-v26/ic_launcher.xml` y `drawable*/splash.png` con fecha de hoy.
4. En Android 12+ el splash del sistema muestra el **icono** sobre `backgroundColor`; `@capacitor/splash-screen` (ya en `package.json`) lo oculta a los 600 ms (`capacitor.config.json`).

## 2. Depurar el APK con `chrome://inspect`

Las builds **debug** de Capacitor tienen la WebView inspeccionable por defecto.

1. Activa **Opciones de desarrollador → Depuración USB** en el teléfono y conéctalo por USB.
2. En Chrome de escritorio abre `chrome://inspect/#devices` → *Alpha Bunker* → **inspect**.
3. Filtra la consola por estos prefijos:

| Prefijo | Qué registra |
|---|---|
| `[AppBridge] entorno:` | `capacitor:android` (APK) o `telegram:*` (Mini App) |
| `[AppBridge] Fallo de red en …` | sin red, DNS o **CORS** (ver §3) |
| `[AlphaBoot]` | arranque, `AppBridge.init`, servicios iniciales |
| `[AlphaAuth] … falló — entorno=… status=… code=…` | login, registro, login con Telegram |
| `[i18n]` | cambio de idioma |

Códigos: `TIMEOUT` (el servidor no respondió en `timeoutMs`), `NETWORK` (red/CORS), `401` credenciales, `409` cuenta existente, `TG_LOGIN_UNAVAILABLE` (falta el endpoint del bot).

## 3. Por qué el login "se congelaba" y qué cambió

Se revisó la hipótesis de llamadas síncronas a `window.Telegram.WebApp` sin protección: en la v2.1 todas estaban ya detrás de `isTelegram()`/`tgAtLeast()`. Ahora además pasan todas por `AppBridge.tgCall()` con try/catch. Las causas reales encontradas:

| Causa | Efecto en el APK | Corrección (v2.2) |
|---|---|---|
| `fetch` sin timeout | Si el backend estaba dormido o la petición quedaba colgada, el botón no respondía nunca | Timeout configurable (`config.timeoutMs`, 65 s en Render gratuito) con mensaje "el servidor tardó demasiado" |
| Sin estado de carga | Nada indicaba que la petición estaba en curso; parecía congelado y se pulsaba de nuevo | Spinner + botón bloqueado durante la petición (`withBusy`), siempre liberado en `finally` |
| `t.me` en `server.allowNavigation` | "Login con Telegram" podía cargar t.me **dentro** de la WebView y sustituir la app | Eliminado; los enlaces se abren con `@capacitor/app-launcher` (app de Telegram) o `@capacitor/browser` |
| Login con Telegram sin salida | Sondeo de hasta 2 min sin forma de cancelar | Diálogo de espera con **Cancelar** (también el botón atrás); deep link `alphabunker://login` acelera la vuelta; si el backend no tiene el endpoint, el botón se desactiva con aviso |
| Error de arranque → `alert` + `reload` | Bucle de recargas sin red | Pantalla "Sin conexión" con **Reintentar**; sin sesión guardada se muestra igualmente la advertencia/login |
| Toast de 1,5 s | Los errores pasaban desapercibidos | 2,5–6 s según longitud, con `role="status"` |

**Requisito de backend imprescindible — CORS.** El APK hace las peticiones desde el origen `https://localhost` (`androidScheme: "https"`). Si Render no lo permite, *todas* las llamadas fallan con `NETWORK`. Orígenes a permitir:

```
https://localhost          ← APK Android (Capacitor)
capacitor://localhost      ← iOS (si se compila)
https://<tu-proyecto>.vercel.app   ← Mini App / web
```

Métodos `GET, POST, PUT, DELETE, OPTIONS`; cabeceras `Authorization, Content-Type, X-Telegram-Init-Data`.

## 4. Login con Telegram desde el APK (flujo del bot)

1. APK → `POST /v2/auth/telegram/login-intent` → `{ intent_id, poll_secret, deep_link: "https://t.me/<bot>?start=login_<nonce>" }`.
2. El APK abre la app de Telegram (AppLauncher). El bot recibe `/start login_<nonce>`, pide confirmar y marca el intent como aprobado para ese `telegram_user_id`.
3. El bot responde con un botón URL **`alphabunker://login?intent=<intent_id>`** ("Volver a Alpha Bunker"). Al pulsarlo, Android reabre el APK (intent-filter del manifest) y la app sondea al instante.
4. APK → `POST /v2/auth/telegram/login-intent/poll` → sesión (`access_token`, `refresh_token`).

Si no vas a implementar este flujo todavía, pon `features.telegramLoginStandalone: false` en `js/config.js`: el botón muestra el aviso y se prioriza email/contraseña.

## 5. Release

```bash
npm test                      # 96 PASS, 0 FAIL
npm run android:sync          # copia la web a www/ y sincroniza Android
npm run android:open          # Android Studio → Build → Generate Signed Bundle / APK
```
