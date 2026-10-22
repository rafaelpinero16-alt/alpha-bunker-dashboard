# Alpha Bunker v2.3 — Telegram Mini App + APK (Capacitor)

```
index.html                 entrada única (viewport-fit=cover, CSP, scripts v2 en orden)
privacy.html · terms.html · manifest.json · sw.js
css/style.css · css/hybrid.css
js/config.js → telegram-web-app + tonconnect-ui → translations(.js|_patch.js)
  → hybrid_bridge → media_manager → api_v2 → chat_v2 → ui_bridge → webrtc_room → app → app_secure
capacitor.config.json · tonconnect-manifest.json · package.json · scripts/build-www.mjs
android/app/src/main/AndroidManifest.xml
smoke.js                   npm test  → 96 PASS, 0 FAIL (TMA, APK, APK sin red, WS caído)
resources/                 fuentes de icono/splash nativos (npm run assets:sources)
docs/                      RECONCILIACION · AUDITORIA · BACKEND_CONTRACT_V2 · IMPLEMENTACION · APK_ANDROID
vercel.json · .vercelignore · 404.html   despliegue estático en Vercel
```

## Comandos

```bash
npm install
npm test                         # pruebas de humo (orden de scripts + flujos críticos)
npx cap add android              # solo la primera vez
npm run assets:sources -- assets/logo.png   # fuentes de icono/splash
npm run assets:android           # icono y splash nativos (sin logo de Capacitor)
npm run android:sync             # copia la web a www/ y sincroniza Capacitor
npm run android:open             # abre Android Studio → Build → Generate Signed APK
```

1. Copia tu carpeta `assets/` (logos, badges) a la raíz: `build-www` la incluye en el APK.
2. Hosting de la Mini App: sirve la raíz (o `www/`) por HTTPS y regístrala en BotFather.
3. `tonconnect-manifest.json`: el campo `url` debe ser el dominio donde se sirve la Mini App, e `iconUrl` un PNG de 180×180 público.
4. Tras `npx cap add android`, sustituye `android/app/src/main/AndroidManifest.xml` por el de este paquete (guarda el original si lo has personalizado).
5. El backend debe exponer las rutas `/v2` de `docs/BACKEND_CONTRACT_V2.md`; sin ellas la app muestra error de red al arrancar.
