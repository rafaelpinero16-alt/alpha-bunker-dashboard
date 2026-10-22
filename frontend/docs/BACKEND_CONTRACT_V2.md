# Contrato backend `/v2` — lo que el frontend v2.1 espera

Todas las rutas (salvo `/v2/auth/telegram|login|register|refresh|logout|telegram/login-intent*`) exigen `Authorization: Bearer <JWT>`. **Ninguna ruta acepta `user_id` del cliente**: el usuario es siempre `sub` del token.
Errores: JSON `{ "detail": "…" }` con status coherente (401 sesión, 402 saldo, 403 permiso/KYC, 404, 409/429 límites).

## 1. Autenticación

| Método | Ruta | Entrada | Salida / reglas |
|---|---|---|---|
| POST | `/v2/auth/telegram` | header `X-Telegram-Init-Data` | Valida initData: `secret = HMAC_SHA256(key="WebAppData", msg=BOT_TOKEN)`; `hash == HMAC_SHA256(secret, data_check_string)` (pares `k=v` ordenados, sin `hash`, unidos por `\n`). Rechazar `auth_date` > 24 h. Crea/actualiza usuario por `user.id`. Si `start_param` empieza por `ref_`, registra referido **solo en el alta**. → `{access_token, access_expires_at, refresh_token?}` |
| POST | `/v2/auth/login` · `/register` | `{email,password[,display_name,requested_role,referral_code]}` | Argon2id/bcrypt. `requested_role` solo `fan`/`creator`; creator sin privilegios hasta KYC. Rate limit + captcha servidor (Turnstile). |
| POST | `/v2/auth/refresh` · `/logout` | `{refresh_token}` | Refresh rotatorio, revocable, ligado a dispositivo. |
| POST | `/v2/auth/change-password` | `{current_password,new_password}` | 403 si la actual no coincide. Mín. 8. |
| POST | `/v2/auth/ws-ticket` | — | `{ticket}` aleatorio, **un solo uso, TTL ≤ 30 s**, ligado al usuario. |
| POST | `/v2/auth/link/telegram` | — | `{deep_link: "https://t.me/<bot>?start=link_<nonce>"}` |
| POST | `/v2/auth/telegram/login-intent` | — | `{intent_id, poll_secret, deep_link: "https://t.me/<bot>?start=login_<nonce>"}` (TTL 2 min). |
| POST | `/v2/auth/telegram/login-intent/poll` | `{intent_id, poll_secret}` | Pendiente → `{}`; confirmado en el bot → sesión; caducado → 410. |
| GET | `/v2/auth/me` | — | `{id, display_name, role, access_level, kyc_status, warnings_count, avatar_url, bio, is_invisible, ton_address, telegram_linked, referral_code, age_confirmed}` |

## 2. Usuarios y media

| Método | Ruta | Notas |
|---|---|---|
| PUT | `/v2/users/me` | Campos permitidos: `display_name` (1 cambio/30 días → 409 `{retry_after_days}`), `bio` (≤280), `avatar_media_id`, `is_invisible` (exige tier ≥1), `age_confirmed`. Ignorar cualquier otro campo (rol, nivel, saldo). |
| GET | `/v2/users/{id}/profile` | `{display_name, bio, avatar_url, is_online, is_following}` |
| GET | `/v2/users/{id}/posts` | Mismo formato que el feed. |
| POST | `/v2/users/{id}/follow` | Toggle → `{following, message}` |
| POST | `/v2/users/{id}/block` | Bloqueo en servidor (filtra feed, DMs y salas). |
| POST | `/v2/media/upload-url` | `{content_type,size,purpose}` → `{media_id, upload_url, headers?}`. Lista blanca MIME, límites por `purpose` (avatar 2 MB, chat 15 MB, post 50 MB). |
| POST | `/v2/media/{id}/complete` | Verifica tipo real (magic bytes), escanea, genera `preview_url` desenfocado. → `{media_id, url, preview_url}` (URLs firmadas de vida corta). |
| POST | `/v2/kyc/session` | `{url}` del proveedor KYC (Sumsub/Veriff/…). Resultado por webhook. |

## 3. Wallet (libro contable de doble entrada, transacciones atómicas)

| Método | Ruta | Reglas |
|---|---|---|
| GET | `/v2/wallet/me` · `/me/transactions?limit` | Saldo derivado del ledger. |
| POST | `/v2/wallet/tip` | `{creator_id, amount, post_id?, message?, client_ref}`. Idempotente por `(user, client_ref)`. 402 sin saldo; 400 si `creator_id == sub`. `SELECT … FOR UPDATE` del saldo. |
| POST | `/v2/wallet/payouts` | Solo `role=creator` + `kyc_status=verified` (403). Retiene saldo, revisión manual/antifraude. |
| POST | `/v2/wallet/ton/proof-payload` | `{payload}` aleatorio, un solo uso, TTL 15 min. |
| POST/DELETE | `/v2/wallet/ton/link` | Verificar `ton_proof`: dominio = el del manifest, payload emitido y no usado, timestamp reciente, firma Ed25519 con la clave pública obtenida de `wallet_state_init`/contrato, dirección derivada coincide. |

## 4. Pagos

| Método | Ruta | Reglas |
|---|---|---|
| GET | `/v2/payments/packages` | `[{slug, alpha_total, price_stars, price_ton, level}]` — **precios solo aquí**. |
| POST | `/v2/payments/stars/invoice` | `{package_slug}` → crea orden `pending` → `createInvoiceLink(currency="XTR", provider_token="", prices=[…], payload=order_id)` → `{invoice_link, order_id}` |
| — | Webhook del bot | `pre_checkout_query`: validar orden/importe y responder `answerPreCheckoutQuery` en < 10 s. `successful_payment`: marcar `paid` idempotente por `telegram_payment_charge_id`, acreditar y subir nivel en la misma transacción. Soportar `refundStarPayment`. |
| POST | `/v2/payments/ton/order` | `{package_slug}` → `{order_id, address, amount_nano, payload, valid_until}`; `payload` = BOC con comentario `order_id`. |
| — | Watcher TON | Lee transacciones entrantes (toncenter/tonapi), casa comentario + importe exacto + destino, espera finalidad, marca `paid`. Nunca acredita por petición del cliente. |
| GET | `/v2/payments/orders/{id}` | `{status: pending|paid|failed|refunded}` solo del propietario. |

## 5. Posts, creadores, chat

| Método | Ruta | Reglas |
|---|---|---|
| GET | `/v2/posts/feed?before_id` | Por post: `id, creator_id, author, author_avatar, is_online, content, media_url, media_type, preview_url, is_locked, price_alpha, level_required, likes_count, liked_by_me, teaser`. **Si `is_locked`: no enviar `media_url` ni `content` completo.** Excluir bloqueados. |
| POST | `/v2/posts` | `{text, media_id, level_required, price_alpha}`; solo creator verificado o admin. |
| DELETE | `/v2/posts/{id}` | Autor o admin. |
| POST | `/v2/posts/{id}/unlock` | Cobra `price_alpha` del ledger, idempotente por `client_ref`. |
| POST/DELETE | `/v2/posts/{id}/like` | |
| GET | `/v2/creators/{id}/tip-menu` · PUT `/v2/creators/me/tip-menu` | `{slots:[{slot_number 1-10, title ≤80, price_alpha>0}]}` |
| GET | `/v2/chat/conversations` | `[{user_id, name, avatar_url, is_online, last_message_preview, last_has_media, last_time, unread_count}]` |
| GET | `/v2/chat/dm/{id}/history` · `/v2/chat/rooms/{room}/history` | `{messages:[…]}` (máx. 48 h en salas si se mantiene esa política). |
| DELETE | `/v2/chat/messages/{id}` · POST `/{id}/report` | Autor o admin. Emitir `message_deleted` a la sala. |

## 6. WebSockets (`wss://…/v2/...?ticket=…`)

Cierre con códigos: `4401` sin auth, `4403` rango/KYC insuficiente (reason legible), `4404` sala inexistente, `4400` mensaje inválido. Rate limit por conexión. Responder `ping` con `pong`.

**`/v2/chat/dm`** — C→S: `{type:'dm', target_id, text, media_id, client_ref}`, `{type:'mark_read', target_id}`. S→C: mensaje `{id, user_id, recipient_id, author_name, access_level, text, media_url, created_at, is_read}` a ambos extremos; `{type:'messages_read'}`.

**`/v2/chat/rooms/{room}/text`** — verifica `access_level ≥ min_access_level` de la sala al conectar. C→S: `{type:'chat', text, media_id, client_ref}`, `{type:'live_tip', target_id, amount, client_ref}` (cobro en ledger). S→C: mensajes de chat, `online_count_update`, `presence {user_id,name,status}`, `live_tip_alert {sender_name, amount}`, `message_deleted {id}`.

**`/v2/video/rooms/{room}/signal`** — exige tier ≥1 y el de la sala. C→S: `join_video`, `leave_video`, `go_live`, `stop_live`, `webrtc_offer|webrtc_answer {target_id, sdp}`, `webrtc_ice {target_id, candidate}`. El servidor **reenvía solo a `target_id` si está en la misma sala** y añade `caller_id` (+`name`) desde el ticket. Tras `join_video` envía al que entra `video_peers {peers:[{user_id,name,live}]}` y a los demás `radar_update {user_id,name,status:'online'|'live'|'offline'}`. Al desconectar: `peer_left {user_id}`.

**`GET /v2/video/ice-servers`** → `{ice_servers:[{urls:['stun:…']},{urls:['turn:turn.tu-dominio:3478?transport=udp','turns:turn.tu-dominio:5349'], username, credential}]}` con credenciales coturn `use-auth-secret` (TTL 1 h).

## 7. Requisitos añadidos para el APK (v2.2)

- **CORS**: permitir los orígenes `https://localhost` (APK Android), `capacitor://localhost` (iOS) y el dominio de Vercel. Métodos `GET, POST, PUT, DELETE, OPTIONS`; cabeceras `Authorization, Content-Type, X-Telegram-Init-Data`. Sin esto todas las peticiones del APK fallan con `NETWORK`.
- **Login con Telegram en Standalone**: `POST /v2/auth/telegram/login-intent` acepta `{ platform }` y devuelve `{ intent_id, poll_secret, deep_link }`. Al confirmar en el bot, este debe responder con un botón URL `alphabunker://login?intent=<intent_id>` para devolver al usuario al APK. Si el endpoint no existe (404/405/501) el cliente desactiva el botón y muestra un aviso.
- **Tiempos de respuesta**: el cliente corta cada petición según `config.timeoutMs`. En el plan gratuito de Render el servicio se apaga tras 15 min sin tráfico y tarda ~1 min en arrancar; por eso `timeoutMs` es 65000. Con una instancia de pago puedes bajarlo a 15000.
