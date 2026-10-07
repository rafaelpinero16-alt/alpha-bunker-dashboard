# Alpha Bunker Dashboard

Plataforma híbrida (Dashboard web + Telegram Mini App) para proteger, automatizar y monetizar comunidades de Telegram. Backend en **FastAPI**, motor del bot en **aiogram 3** vía webhook seguro, y pagos con **Telegram Stars**, **PayPal**, **Binance Pay** y transferencias manuales (**Global66**, **Payoneer**).

## Qué incluye

| Módulo | Función |
|---|---|
| `app/main.py` | App FastAPI, `lifespan` (registra/elimina el webhook), CORS, `/health`, estáticos |
| `app/auth.py` | Validación HMAC-SHA256 del `initData` de la Mini App + dependencia `get_current_telegram_user` |
| `app/api/webhooks.py` | Webhook de Telegram (header secreto), webhook de PayPal verificado, retorno/cancelación de PayPal |
| `app/api/dashboard.py` | API REST de la Mini App: usuario, comunidades, ajustes, reglas por bloques, checkout |
| `app/bot/*` | Dispatcher, teclados y handlers (`/start`, `/dashboard`, `/planes`, pagos Stars, captcha, bienvenida, lista negra, reglas) |
| `app/services/database.py` | Persistencia asíncrona en JSON con escritura atómica |
| `app/services/payments.py` | Catálogo de planes, Stars, PayPal REST v2, Binance Pay, entrega del acceso VIP |
| `public/index.html` | Dashboard / Mini App en 6 idiomas (ES, EN, IT, FR, DE, PT) |

## 1. Requisitos

- Python 3.11 o superior
- Un bot creado con [@BotFather](https://t.me/BotFather)
- Un dominio HTTPS público (Railway, Render o ngrok en local)

## 2. Instalación local

```bash
git clone <tu-repo> alpha-bunker-dashboard
cd alpha-bunker-dashboard

python -m venv .venv
source .venv/bin/activate          # Windows: .venv\Scripts\activate
pip install -r requirements.txt

cp .env.example .env
```

Edita `.env` con tus valores. Para generar un `WEBHOOK_SECRET` válido:

```bash
python -c "import secrets; print(secrets.token_urlsafe(48))"
```

## 3. Exponer el puerto con ngrok

Telegram solo entrega webhooks a URLs HTTPS públicas:

```bash
ngrok http 8000
```

Copia la URL `https://xxxx.ngrok-free.app` en `.env`:

```env
WEBHOOK_HOST=https://xxxx.ngrok-free.app
DASHBOARD_URL=https://xxxx.ngrok-free.app/
```

> Cada vez que ngrok cambie de URL, actualiza `.env` y reinicia el servidor: el webhook se vuelve a registrar solo al arrancar.

## 4. Levantar el servidor

```bash
uvicorn app.main:app --host 0.0.0.0 --port 8000 --proxy-headers
```

O bien:

```bash
python -m app.main
```

Usa **un solo worker**: el almacén JSON y el captcha viven en memoria del proceso.

## 5. Configurar la Mini App en BotFather

1. `/mybots` → tu bot → **Bot Settings** → **Configure Mini App** → **Enable Mini App** y pega `DASHBOARD_URL`.
2. Opcional: **Menu Button** → misma URL, para abrir el dashboard desde el botón del chat.
3. En **Group Privacy**, desactiva el modo privado (`/setprivacy` → Disable) para que el bot lea los mensajes del grupo (lista negra y reglas por palabra clave).

## 6. Verificar el webhook

```bash
curl https://TU_DOMINIO/health
```

Respuesta esperada:

```json
{"api": "online", "bot": "online", "webhook": "ok", "status": "ok", ...}
```

También puedes consultar Telegram directamente:

```bash
curl "https://api.telegram.org/bot<BOT_TOKEN>/getWebhookInfo"
```

Una petición sin el header secreto debe devolver `401`:

```bash
curl -X POST https://TU_DOMINIO/api/v1/telegram/webhook -d '{}' -H "Content-Type: application/json"
```

## 7. Probar los flujos de pago

### Telegram Stars
1. Escribe `/planes` al bot, elige un plan y pulsa **⭐ Telegram Stars**.
2. Paga la factura. El bot aprueba el `pre_checkout_query`, registra la transacción y te envía un enlace de invitación de un solo uso a `VIP_CHAT_ID` (el bot debe ser admin allí con permiso para invitar).
3. La conversión de precio se controla con `STARS_PER_USD`.

### PayPal (sandbox)
1. Crea una app REST en [developer.paypal.com](https://developer.paypal.com) y copia Client ID y Secret con `PAYPAL_MODE=sandbox`.
2. En la misma app crea un webhook apuntando a `https://TU_DOMINIO/api/v1/payments/paypal/webhook` con los eventos `CHECKOUT.ORDER.APPROVED`, `PAYMENT.CAPTURE.COMPLETED`, `PAYMENT.CAPTURE.DENIED` y `PAYMENT.CAPTURE.DECLINED`. Copia su ID en `PAYPAL_WEBHOOK_ID`.
3. Paga con una cuenta personal sandbox. Al aprobar, PayPal redirige a `/api/v1/payments/paypal/return`, que captura la orden y vuelve al dashboard con `?payment=success`. El webhook actúa como respaldo si el usuario cierra la ventana.

### Binance Pay
1. Obtén `BINANCE_API_KEY` y `BINANCE_API_SECRET` en el portal de comerciante de Binance Pay.
2. Las órdenes se crean en USDT. Tras pagar, pulsa **Comprobar pago** en el dashboard: el backend consulta el estado (`/binancepay/openapi/v2/order/query`) y entrega el acceso si figura `PAID`.

### Global66 y Payoneer
Se muestran como transferencia manual cuando `GLOBAL66_ACCOUNT` o `PAYONEER_EMAIL` tienen valor. La transacción queda `pending` y el administrador recibe un aviso en Telegram para confirmarla.

## 8. Despliegue en Railway o Render

1. Sube el repositorio a GitHub y crea un servicio web desde él.
2. Comando de inicio:
   ```bash
   uvicorn app.main:app --host 0.0.0.0 --port $PORT --proxy-headers
   ```
3. Define todas las variables de `.env.example` en el panel del proveedor. `WEBHOOK_HOST` y `DASHBOARD_URL` deben usar el dominio público que te asigne la plataforma.
4. Monta un volumen persistente y apunta `DATABASE_PATH` a él (por ejemplo `/data/alpha_bunker.json`); sin volumen, los datos se pierden en cada redeploy.

## 9. Uso del dashboard

1. Añade el bot como administrador a tu grupo o canal (permisos: borrar mensajes, restringir miembros, invitar usuarios). Aparecerá en **Tus comunidades**.
2. En **Gestionar** → **Protección** configura bienvenida, captcha, palabras prohibidas y roles automáticos.
3. En **Reglas** crea bloques *Cuando → Entonces*: comando, palabra clave o entrada al grupo → mensaje, rol, expulsión o muro de pago.
4. **Plantillas** aplica configuraciones completas (Comunidad VIP, Antispam total, Tienda) en un paso.

## Notas de seguridad

- Toda la API del dashboard exige `initData` firmado por Telegram (header `X-Telegram-Init-Data` o `Authorization: tma <initData>`), con caducidad configurable en `INIT_DATA_MAX_AGE`.
- El webhook de Telegram compara el header `X-Telegram-Bot-Api-Secret-Token` en tiempo constante.
- Los webhooks de PayPal se validan contra `/v1/notifications/verify-webhook-signature`.
- La entrega de cada pago es idempotente: una transacción solo pasa de `pending` a `completed` una vez, aunque lleguen el retorno y el webhook a la vez.
