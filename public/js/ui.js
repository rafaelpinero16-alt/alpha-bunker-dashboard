/* ==========================================================================
   THE BUNKER — COMMAND OS
   ui.js — Capa de presentación (interfaz tipo constructor, estilo PuzzleBot): listas, tarjetas,
           filas de ajustes, analítica en vivo, planes de membresía, modales y toasts
   The Bunker Command OS © 2026 — Cloud Media Management
   ========================================================================== */

import { CONFIG, translations } from './config.js';
import { state } from './state.js';
import { tgApp } from './telegram.js';

// Colores e iconos por tipo de mensaje (claves de message_breakdown.types y del evento "message")
const KIND_META = {
    text:          { icon: '💬', color: '#2f7cf6' },
    media:         { icon: '🖼️', color: '#7c5cf0' },
    stickers_gifs: { icon: '🎭', color: '#e8a317' },
    commands:      { icon: '⌨️', color: '#1e9e62' },
    other:         { icon: '📦', color: '#94a3b8' }
};

// Color del texto del indicador de conexión del radar según el estado del cliente WebSocket.
// La propia etiqueta traducida lleva el emoji ("Conectado 🟢", "Reconectando 🟡"): no hay punto aparte.
const WS_STATUS_STYLE = {
    live:         'text-success',
    connecting:   'text-warning',
    reconnecting: 'text-warning',
    offline:      'text-danger',
    paused:       'text-muted',
    denied:       'text-danger',
    idle:         'text-muted'
};

// Tonos de los botones de acción de cada plan de membresía
const PLAN_TONES = {
    cyan:    '',
    amber:   '',
    magenta: '',
    emerald: '',
    rose:    'tone-danger'
};

// Estados del indicador de guardado del Estudio de Canales
const STUDIO_STATUS_STYLE = {
    idle:       'text-muted',
    dirty:      'text-warning',
    saving:     'text-primary is-pulsing',
    saved:      'text-success',
    mismatch:   'text-warning',
    invalid:    'text-danger',
    error:      'text-danger'
};

const TOAST_TONES = {
    info:    'tone-info',
    success: 'tone-success',
    warn:    'tone-warn',
    error:   'tone-error',
    level:   'tone-level'
};

// Las animaciones (toasts, destellos, mapa de calor) viven en styles.css.
const LIVE_CSS = '';

function byId(id) {
    return document.getElementById(id);
}

function clampPct(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return 0;
    return Math.max(0, Math.min(100, n));
}

export const ui = {
    t(key) {
        const dict = translations[state.currentLang] || {};
        return dict[key] || (translations.es && translations.es[key]) || key;
    },

    /** Traducción con variables: tf('toast_level_up_body', { name, level }) sustituye {name} y {level}. */
    tf(key, vars = {}) {
        return this.t(key).replace(/\{(\w+)\}/g, (match, name) => (vars[name] !== undefined ? String(vars[name]) : match));
    },

    escapeHtml(str) {
        if (str === null || str === undefined) return '';
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    },

    fmtNum(value) {
        const n = Number(value);
        if (!Number.isFinite(n)) return '—';
        try {
            return new Intl.NumberFormat(state.currentLang === 'es' ? 'es-CO' : 'en-US').format(n);
        } catch (err) {
            return String(n);
        }
    },

    kindLabel(kind) {
        return this.t(`kind_${KIND_META[kind] ? kind : 'other'}`);
    },

    kindIcon(kind) {
        return (KIND_META[kind] || KIND_META.other).icon;
    },

    updateTranslations() {
        const dict = translations[state.currentLang];
        document.querySelectorAll('[data-i18n]').forEach(el => {
            const key = el.getAttribute('data-i18n');
            if (dict[key]) el.innerText = dict[key];
        });
        document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
            const key = el.getAttribute('data-i18n-placeholder');
            if (dict[key]) el.placeholder = dict[key];
        });
    },

    setTheme(theme) {
        const value = theme === 'dark' ? 'dark' : 'light';
        state.currentTheme = value;
        document.documentElement.setAttribute('data-theme', value);
        try { localStorage.setItem('bunker_theme', value); } catch (err) { /* almacenamiento bloqueado */ }
        byId('theme-btn-light')?.classList.toggle('is-active', value === 'light');
        byId('theme-btn-dark')?.classList.toggle('is-active', value === 'dark');
        tgApp.setThemeColors(value);
    },

    setStat(id, value) {
        const el = document.getElementById(id);
        if (!el) return;
        el.innerText = (value === null || value === undefined || value === '') ? '0' : value;
    },

    /** Escribe texto plano (nunca HTML) en un elemento por id. Devuelve el elemento o null. */
    setText(id, value) {
        const el = byId(id);
        if (!el) return null;
        el.textContent = (value === null || value === undefined || value === '') ? '—' : String(value);
        return el;
    },

    setVisible(id, visible) {
        byId(id)?.classList.toggle('hidden', !visible);
    },

    /** Destello breve para indicar que un valor se actualizó en caliente. */
    flash(id) {
        const el = byId(id);
        if (!el || !el.classList) return;
        el.classList.remove('bk-flash');
        void el.offsetWidth;
        el.classList.add('bk-flash');
    },

    renderStats(data) {
        const num = (value) => this.fmtNum(value ?? 0);
        const stars = `${num(data?.revenue_stars)} ⭐`;
        this.setStat('stat-subs-count', num(data?.subscribers));
        this.setStat('stat-revenue-count', stars);
        this.setStat('stat-verified', num(data?.verified));
        this.setStat('stat-expelled', num(data?.expelled));
        this.setStat('stat-purges', num(data?.purges));

        const profileBal = document.getElementById('profile-balance-stars');
        if (profileBal) profileBal.innerText = stars;
        document.querySelectorAll('[data-mirror]').forEach(el => {
            const source = byId(el.getAttribute('data-mirror'));
            if (source) el.textContent = source.textContent;
        });
    },

    generateSparkline(data, color) {
        const width = 300, height = 75;
        if (!data || data.length < 2) return '';
        const c = color || '#2f7cf6';
        const max = Math.max(...data), min = Math.min(...data);
        const range = (max - min) === 0 ? 1 : (max - min);
        const stepX = width / (data.length - 1);
        const pts = data.map((v, i) => [i * stepX, height - ((v - min) / range) * (height - 16) - 8]);
        const line = pts.map((p, i) => (i === 0 ? `M${p[0].toFixed(1)},${p[1].toFixed(1)}` : `L${p[0].toFixed(1)},${p[1].toFixed(1)}`)).join(' ');
        const area = `${line} L${width},${height} L0,${height} Z`;
        const gid = `spark-${Math.random().toString(36).slice(2, 9)}`;
        return `<svg viewBox="0 0 ${width} ${height}" class="spark-svg" preserveAspectRatio="none">
            <defs>
                <linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stop-color="${c}" stop-opacity="0.22"/>
                    <stop offset="100%" stop-color="${c}" stop-opacity="0.0"/>
                </linearGradient>
            </defs>
            <path d="${area}" fill="url(#${gid})"/>
            <path d="${line}" fill="none" stroke="${c}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>
        </svg>`;
    },

    chatCardTemplate(chat) {
        const isChannel = chat.type === 'channel';
        const licenseActive = chat.license_status === 'active';
        const safeId = this.escapeHtml(chat.id);
        const safeTitle = this.escapeHtml(chat.title);
        const safeMembers = this.escapeHtml(chat.members ?? '0');

        const statusHtml = licenseActive
            ? `<span class="badge badge-success">${this.escapeHtml(this.t('license_active'))}</span>`
            : `<button type="button" onclick="app.renewLicense('${safeId}')" class="btn btn-danger btn-xs">${this.escapeHtml(this.t('license_renew'))}</button>`;

        const deltaHtml = (chat.joined != null)
            ? `<span class="delta-up">+${this.escapeHtml(chat.joined)}</span><span class="delta-down">-${this.escapeHtml(chat.left)}</span>`
            : `<span class="text-muted mono">—</span>`;

        // La analítica en vivo solo existe para grupos y supergrupos (los canales no generan mensajes rastreables).
        const analyticsBtn = isChannel ? '' : `
                <button type="button" onclick="app.openAnalytics('${safeId}')" class="btn btn-ghost btn-xs">
                    <i class="fa-solid fa-chart-line"></i> ${this.escapeHtml(this.t('nav_analytics'))}
                </button>`;

        return `
        <div class="chat-card" data-chat-id="${safeId}">
            <div class="chat-card-top">
                <span class="tile-icon ${isChannel ? 'tone-violet' : 'tone-blue'}"><i class="fa-solid ${isChannel ? 'fa-bullhorn' : 'fa-users'}"></i></span>
                <div class="li-main" style="min-width:0;flex:1">
                    <p class="li-title truncate">${safeTitle}</p>
                    <p class="li-sub"><i class="fa-solid fa-user" style="font-size:10px"></i> ${safeMembers}</p>
                </div>
                ${statusHtml}
            </div>
            <div class="chat-card-spark">${this.generateSparkline(chat.activity && chat.activity.length >= 2 ? chat.activity : [0, 0, 0, 0, 0], isChannel ? '#7c5cf0' : '#2f7cf6')}</div>
            <div class="chat-card-foot">
                <span>${deltaHtml}</span>
                <div class="btn-row">${analyticsBtn}
                    <button type="button" onclick="app.configureChat('${safeId}')" class="btn btn-soft btn-xs">
                        <i class="fa-solid fa-gear"></i> ${this.escapeHtml(this.t('configure'))}
                    </button>
                </div>
            </div>
        </div>`;
    },

    renderChatList(containerId, list, emptyMsg) {
        const el = document.getElementById(containerId);
        if (!el) return;
        const isChannel = containerId.includes('channel');
        const addBtnLabel = isChannel ? this.t('btn_connect_channel') : this.t('btn_connect_group');
        const targetType = isChannel ? 'channel' : 'group';

        if (!list || list.length === 0) {
            el.innerHTML = `
            <div class="empty-state">
                <span class="es-icon">${isChannel ? '📢' : '🛡️'}</span>
                <p>${this.escapeHtml(emptyMsg)}</p>
                <button type="button" onclick="app.openAddBot('${targetType}')" class="btn btn-primary btn-sm">${this.escapeHtml(addBtnLabel)}</button>
            </div>`;
            return;
        }
        el.innerHTML = list.map(c => this.chatCardTemplate(c)).join('');
    },

    renderChatListError(containerId, msg, retryFnName) {
        const el = document.getElementById(containerId);
        if (!el) return;
        el.innerHTML = `
        <div class="state-box is-error">
            <p>⚠️ ${this.escapeHtml(msg)}</p>
            ${retryFnName ? `<button type="button" onclick="app.${retryFnName}()" class="btn btn-danger btn-sm"><i class="fa-solid fa-rotate"></i> ${this.escapeHtml(this.t('btn_retry'))}</button>` : ''}
        </div>`;
    },

    subscriberTemplate(s) {
        const daysLeft = s.days_left ?? 0;
        const isGrace = daysLeft <= 0;
        const badge = isGrace ? 'badge-danger' : (daysLeft <= 3 ? 'badge-warning' : 'badge-success');
        const daysLabel = isGrace ? this.t('grace_period') : this.tf('days_left', { n: this.fmtNum(daysLeft) });

        const safeUsername = this.escapeHtml(s.username || s.user_id);
        const safePlanName = this.escapeHtml(s.plan_name || this.t('membership_default'));
        const safePrice = this.escapeHtml(s.price ?? 0);
        const initial = this.escapeHtml(String(s.username || s.user_id || '?').charAt(0).toUpperCase());

        return `
        <div class="list-item">
            <div class="avatar sm">${initial}</div>
            <div class="li-main">
                <p class="li-title truncate">@${safeUsername}</p>
                <p class="li-sub">${safePlanName} · ⭐ ${safePrice}</p>
            </div>
            <span class="badge ${badge}">${this.escapeHtml(daysLabel)}</span>
        </div>`;
    },

    renderSubscriberList(list) {
        const el = document.getElementById('watchdog-list');
        if (!el) return;
        if (!list || list.length === 0) {
            el.innerHTML = `<div class="empty-state"><span class="es-icon">🗂️</span><p>${this.escapeHtml(this.t('no_subs'))}</p></div>`;
            return;
        }
        el.innerHTML = list.map(s => this.subscriberTemplate(s)).join('');
    },

    /**
     * Rellena todos los <select> con ese id. `kind` ('group' | 'channel') fija el texto del
     * placeholder; si se omite se deduce del id, como antes.
     */
    populateSelect(id, list, emptyLabel, kind) {
        const elements = document.querySelectorAll(`#${id}`);
        if (!elements.length) return;

        const isGroup = kind ? kind === 'group' : id.includes('group');
        const placeholderText = isGroup ? this.t('select_your_community') : this.t('select_your_channel');

        elements.forEach(sel => {
            if (!list || list.length === 0) {
                sel.innerHTML = `<option value="">⚠️ ${emptyLabel}</option>`;
                return;
            }

            const optionsHtml = list.map(c => {
                const icon = c.type === 'channel' ? '📢' : '🛡️';
                return `<option value="${this.escapeHtml(c.id)}">${icon} ${this.escapeHtml(c.title)}</option>`;
            }).join('');

            sel.innerHTML = `<option value="">${placeholderText}</option>${optionsHtml}`;

            if (state.selectedChatId && list.some(item => String(item.id) === String(state.selectedChatId))) {
                sel.value = String(state.selectedChatId);
            }
        });
    },

    renderUserProfile(user) {
        const nameEl = document.getElementById('user-name');
        const handleEl = document.getElementById('user-handle');
        const idEl = document.getElementById('user-id-display');
        const imgEl = document.getElementById('avatar-img');
        const initialsEl = document.getElementById('avatar-initials');

        const dName = document.getElementById('drawer-user-name');
        const dHandle = document.getElementById('drawer-user-handle');
        const dImg = document.getElementById('drawer-avatar-img');
        const dInitials = document.getElementById('drawer-avatar-initials');

        const pName = document.getElementById('profile-name');
        const pHandle = document.getElementById('profile-handle');
        const pId = document.getElementById('profile-id');
        const pImg = document.getElementById('profile-img');
        const pInitials = document.getElementById('profile-initials');

        if (user) {
            const fullName = `${user.first_name || ''} ${user.last_name || ''}`.trim() || 'Comandante';
            const handle = user.username ? `@${user.username}` : `ID: ${user.id}`;
            const idText = `ID: ${user.id}`;
            const initials = ((user.first_name || 'U').charAt(0) + (user.last_name ? user.last_name.charAt(0) : '')).toUpperCase();

            if (nameEl) nameEl.innerText = fullName;
            if (handleEl) handleEl.innerText = handle;
            if (idEl) idEl.innerText = idText;

            if (dName) dName.innerText = fullName;
            if (dHandle) dHandle.innerText = handle;

            if (pName) pName.innerText = `${fullName} 👑`;
            if (pHandle) pHandle.innerText = handle;
            if (pId) pId.innerText = idText;

            if (user.photo_url) {
                [imgEl, dImg, pImg].forEach(img => {
                    if (img) { img.src = user.photo_url; img.classList.remove('hidden'); }
                });
                [initialsEl, dInitials, pInitials].forEach(init => {
                    if (init) init.classList.add('hidden');
                });
            } else {
                [initialsEl, dInitials, pInitials].forEach(init => {
                    if (init) init.innerText = initials;
                });
            }
        }
    },

    renderAffiliateLink(userId) {
        const el = document.getElementById('affiliate-link-text');
        if (!el) return;
        // Sin identidad de sesión no hay enlace: jamás se muestra el de otro operador.
        el.innerText = userId ? `https://t.me/${CONFIG.BOT_USERNAME}?start=ref_${userId}` : '—';
    },

    // ======================================================================
    // 📈 ANALÍTICA EN VIVO — constructores de HTML (puros, sin acceso al DOM)
    // ======================================================================

    /** Textos de todos los KPIs del snapshot, por id de elemento. */
    computeKpiTexts(data) {
        const s = data?.summary || {};
        const g = data?.growth || {};
        const c7 = g.cohort_7d || {};
        const c30 = g.cohort_30d || {};
        const pct = (cohort) => (cohort.retention_pct === null || cohort.retention_pct === undefined)
            ? '—'
            : `${cohort.retention_pct}%`;
        const members = (s.members_live !== null && s.members_live !== undefined) ? s.members_live : s.members_tracked;

        return {
            'an-kpi-dau': this.fmtNum(s.dau ?? 0),
            'an-kpi-wau': this.fmtNum(s.wau ?? 0),
            'an-kpi-mau': this.fmtNum(s.mau ?? 0),
            'an-kpi-stickiness': `${s.stickiness_pct ?? 0}%`,
            'an-kpi-members': this.fmtNum(members ?? 0),
            'an-kpi-members-sub': `${this.fmtNum(s.members_tracked ?? 0)} ${this.t('an_members_tracked')}`,
            'an-kpi-joins': `${this.fmtNum(g.new_members_7d ?? 0)} / ${this.fmtNum(g.new_members_30d ?? 0)}`,
            'an-kpi-retention-7d': pct(c7),
            'an-kpi-retention-7d-sub': `n=${this.fmtNum(c7.size ?? 0)}`,
            'an-kpi-retention-30d': pct(c30),
            'an-kpi-retention-30d-sub': `n=${this.fmtNum(c30.size ?? 0)}`
        };
    },

    /** Texto y color de la variación de mensajes frente a ayer a la misma hora. */
    computeMessageDelta(summary) {
        const delta = summary?.messages_delta_pct;
        if (delta === null || delta === undefined || !Number.isFinite(Number(delta))) {
            return { text: '—', tone: 'text-muted' };
        }
        const value = Number(delta);
        return {
            text: `${value >= 0 ? '▲' : '▼'} ${Math.abs(value)}%`,
            tone: value >= 0 ? 'text-success' : 'text-danger'
        };
    },

    buildHeatmapHtml(heatmap) {
        const matrix = heatmap?.matrix;
        if (!Array.isArray(matrix) || matrix.length !== 7 || !heatmap.total) return '';

        const dayLabels = (state.currentLang === 'en' ? heatmap.days_en : heatmap.days) || [];
        const max = Math.max(1, Number(heatmap.max) || 0);
        const peak = heatmap.peak || null;
        const rows = [];

        for (let d = 0; d < 7; d++) {
            rows.push(`<span class="bk-hm-day">${this.escapeHtml(dayLabels[d] ?? '')}</span>`);
            const row = Array.isArray(matrix[d]) ? matrix[d] : [];
            for (let h = 0; h < 24; h++) {
                const value = Math.max(0, Number(row[h]) || 0);
                const alpha = value === 0 ? 0.05 : (0.14 + 0.86 * Math.sqrt(value / max));
                const isPeak = peak && peak.day_index === d && peak.hour === h;
                const bg = value === 0 ? 'var(--surface-3)' : `rgba(var(--hm-rgb),${alpha.toFixed(3)})`;
                const outline = isPeak ? 'outline:2px solid var(--warning);outline-offset:0;' : '';
                const label = `${dayLabels[d] ?? ''} ${String(h).padStart(2, '0')}:00 · ${this.fmtNum(value)}`;
                rows.push(`<div class="bk-hm-cell" title="${this.escapeHtml(label)}" style="background:${bg};${outline}"></div>`);
            }
        }

        // Fila de horas: solo se rotulan 00, 06, 12, 18 y 23 para no saturar el ancho.
        rows.push('<span></span>');
        for (let h = 0; h < 24; h++) {
            rows.push(`<span class="bk-hm-hour">${[0, 6, 12, 18, 23].includes(h) ? String(h).padStart(2, '0') : ''}</span>`);
        }
        return `<div class="bk-hm-grid">${rows.join('')}</div>`;
    },

    buildHeatmapPeakText(heatmap) {
        const peak = heatmap?.peak;
        if (!peak) return '';
        const day = state.currentLang === 'en' ? peak.day_en : peak.day_es;
        return `${this.t('an_peak_label')}: ${day} ${String(peak.hour).padStart(2, '0')}:00 · ${this.fmtNum(peak.count)}`;
    },

    buildBreakdown(breakdown) {
        const types = Array.isArray(breakdown?.types) ? breakdown.types : [];
        const total = Number(breakdown?.total) || 0;
        if (!total) return { barHtml: '', legendHtml: '' };

        const barHtml = types
            .filter(item => Number(item.count) > 0)
            .map(item => {
                const color = (KIND_META[item.key] || KIND_META.other).color;
                return `<div style="flex:${Number(item.count)} 1 0%;background:${color}" title="${this.escapeHtml(item.key)}"></div>`;
            })
            .join('');

        const legendHtml = types.map(item => {
            const meta = KIND_META[item.key] || KIND_META.other;
            const label = state.currentLang === 'en' ? item.label_en : item.label_es;
            return `
            <div class="legend-row">
                <span style="display:flex;align-items:center;gap:8px;min-width:0">
                    <span class="legend-dot" style="background:${meta.color}"></span>
                    <span class="truncate">${meta.icon} ${this.escapeHtml(label || item.key)}</span>
                </span>
                <span class="text-muted mono">${this.fmtNum(item.count)} · <strong style="color:var(--text)">${this.escapeHtml(item.pct)}%</strong></span>
            </div>`;
        }).join('');

        return { barHtml, legendHtml };
    },

    buildLeaderboardHtml(list) {
        if (!Array.isArray(list) || list.length === 0) return '';
        const medals = ['🥇', '🥈', '🥉'];

        return list.slice(0, 10).map((u, idx) => {
            const rank = Number(u.rank) || (idx + 1);
            const handle = u.username ? `@${this.escapeHtml(u.username)} · ` : '';
            return `
            <div class="row-item" data-user-id="${this.escapeHtml(u.user_id ?? '')}">
                <span class="rank">${medals[rank - 1] || `#${rank}`}</span>
                <div class="li-main" style="flex:1;min-width:0">
                    <div style="display:flex;justify-content:space-between;gap:8px">
                        <p class="li-title truncate">${this.escapeHtml(u.name)}</p>
                        <span class="text-primary mono" style="font-size:12px;font-weight:700;flex-shrink:0">${this.fmtNum(u.messages_30d)} ${this.escapeHtml(this.t('an_msgs_30d'))}</span>
                    </div>
                    <p class="li-sub">${handle}${this.escapeHtml(this.t('an_level'))} ${this.escapeHtml(u.level)} · ${this.fmtNum(u.xp)} XP</p>
                    <div class="progress"><div style="width:${clampPct(u.level_progress_pct)}%"></div></div>
                </div>
            </div>`;
        }).join('');
    },

    sparkPlaceholder() {
        return '<div class="hint mono" style="height:100%;display:grid;place-items:center">—</div>';
    },

    // ======================================================================
    // 📈 ANALÍTICA EN VIVO — aplicación al DOM
    // ======================================================================
    ensureLiveStyles() {
        // Compatibilidad: las animaciones del radar ya están en styles.css (no se inyecta CSS en tiempo de ejecución).
        return;
    },

    /** Muestra el estado vacío (sin comunidad), cargando, error o el contenido. */
    setAnalyticsPanel(panel) {
        this.setVisible('an-empty', panel === 'empty');
        this.setVisible('an-loading', panel === 'loading');
        this.setVisible('an-error', panel === 'error');
        this.setVisible('an-content', panel === 'content');
    },

    setAnalyticsLoading(loading) {
        // Si ya hay datos en pantalla, un refresco no debe taparlos con el cargador.
        if (loading && !state.liveAnalytics) this.setAnalyticsPanel('loading');
    },

    renderAnalyticsError(message, retryable = true) {
        this.setAnalyticsPanel('error');
        this.setText('an-error-msg', message);
        this.setVisible('an-error-retry', retryable);
    },

    resetAnalyticsView() {
        this.setAnalyticsPanel('empty');
        this.setText('an-updated', '');
        this.clearFeed();
    },

    renderAnalytics(data) {
        if (!data || typeof data !== 'object') return;
        this.ensureLiveStyles();
        this.setAnalyticsPanel('content');

        Object.entries(this.computeKpiTexts(data)).forEach(([id, text]) => this.setText(id, text));
        this.renderMessagesToday(data.summary);
        this.renderStarsKpis(data.summary);

        const daily = data.growth?.daily || {};
        const sparks = [
            ['an-spark-messages', daily.messages, '#2f7cf6', 'an-spark-messages-total', data.summary?.messages_30d],
            ['an-spark-active', daily.active_users, '#1e9e62', 'an-spark-active-peak', Array.isArray(daily.active_users) && daily.active_users.length ? Math.max(...daily.active_users) : 0],
            ['an-spark-growth', daily.new_members, '#7c5cf0', 'an-spark-growth-total', data.growth?.new_members_30d]
        ];
        sparks.forEach(([containerId, series, color, labelId, headline]) => {
            const container = byId(containerId);
            if (container) container.innerHTML = this.generateSparkline(series, color) || this.sparkPlaceholder();
            this.setText(labelId, this.fmtNum(headline ?? 0));
        });

        const heatmapEl = byId('an-heatmap');
        if (heatmapEl) {
            heatmapEl.innerHTML = this.buildHeatmapHtml(data.heatmap)
                || `<p class="hint" style="text-align:center;padding:20px 0">${this.escapeHtml(this.t('an_heatmap_empty'))}</p>`;
        }
        this.setText('an-heatmap-peak', this.buildHeatmapPeakText(data.heatmap));

        const { barHtml, legendHtml } = this.buildBreakdown(data.message_breakdown);
        const barEl = byId('an-breakdown-bar');
        if (barEl) barEl.innerHTML = barHtml;
        const legendEl = byId('an-breakdown-legend');
        if (legendEl) {
            legendEl.innerHTML = legendHtml
                || `<p class="hint" style="text-align:center;padding:8px 0">${this.escapeHtml(this.t('an_heatmap_empty'))}</p>`;
        }

        const boardEl = byId('an-leaderboard');
        if (boardEl) {
            boardEl.innerHTML = this.buildLeaderboardHtml(data.leaderboard)
                || `<p class="hint" style="text-align:center;padding:14px 0">${this.escapeHtml(this.t('an_lb_empty'))}</p>`;
        }

        const stamp = data.generated_at_local ? `${data.generated_at_local}${data.timezone ? ` (${data.timezone})` : ''}` : '';
        this.setText('an-updated', stamp ? `${this.t('an_updated')}: ${stamp}` : '');
        this.renderVoiceCard();
    },

    renderMessagesToday(summary) {
        this.setText('an-kpi-messages-today', this.fmtNum(summary?.messages_today ?? 0));
        const delta = this.computeMessageDelta(summary);
        const el = this.setText('an-kpi-messages-delta', delta.text);
        if (el) el.className = `mono ${delta.tone}`;
    },

    renderStarsKpis(summary) {
        this.setText('an-kpi-stars-total', `${this.fmtNum(summary?.stars_total ?? 0)} ⭐`);
        this.setText('an-kpi-stars-today', this.fmtNum(summary?.stars_today ?? 0));
        this.setText('an-kpi-stars-30d', this.fmtNum(summary?.stars_30d ?? 0));
        this.setText('an-kpi-payments', this.fmtNum(summary?.payments_count ?? 0));
    },

    renderVoiceCard() {
        const voice = state.liveVoice || {};
        const active = Boolean(voice.active);
        this.setText('an-voice-status', active ? this.t('an_voice_live') : this.t('an_voice_idle'));
        const statusEl = byId('an-voice-status');
        if (statusEl) statusEl.className = active ? 'text-success' : 'text-muted';
        const dot = byId('an-voice-dot');
        if (dot) dot.className = `voice-dot${active ? ' is-live' : ''}`;
        this.setText('an-voice-count', `${this.fmtNum(voice.participants ?? 0)} ${this.t('an_voice_present')}`);
        this.setText('an-voice-mics', `${this.fmtNum(voice.mics ?? 0)} ${this.t('an_voice_mics')}`);
    },

    /** Indicador de conexión del radar (cabecera global + cabecera de la analítica). */
    setWsStatus(status) {
        const known = Object.prototype.hasOwnProperty.call(WS_STATUS_STYLE, status) ? status : 'idle';
        state.wsStatus = known;
        const label = this.t(`ws_${known}`);
        ['ws-status', 'an-ws'].forEach(prefix => {
            const text = byId(`${prefix}-label`);
            if (!text) return;
            text.textContent = label;
            text.className = prefix === 'ws-status' ? '' : WS_STATUS_STYLE[known];
        });
        byId('ws-status-pill')?.setAttribute('data-status', known);
    },

    /** Comunidad a la que está conectado el radar (junto al estado), para que cambiar de comunidad sea inequívoco. */
    setRadarTarget(title) {
        const el = byId('an-ws-chat');
        if (!el) return;
        el.textContent = title ? `· ${title}` : '';
        el.setAttribute('title', title || '');
    },

    renderToastToggle() {
        const icon = byId('an-toast-toggle-icon');
        if (icon) icon.className = state.liveToastsEnabled ? 'fa-solid fa-bell' : 'fa-solid fa-bell-slash';
        const btn = byId('an-toast-toggle');
        if (btn) btn.setAttribute('aria-pressed', state.liveToastsEnabled ? 'true' : 'false');
    },

    // ======================================================================
    // 💎 PLANES DE MEMBRESÍA DEL CANAL
    // ======================================================================

    /**
     * HTML de Telegram → HTML seguro para la vista previa. MISMA gramática que telegram_html.py
     * (normalize_telegram_html), que es lo que el backend publica: la vista previa no puede "arreglar"
     * algo que Telegram luego rechazaría o mostraría distinto.
     *  · Solo b, i, u, s, code sin atributos; los alias (strong, em, ins, strike, del) se canonicalizan.
     *  · Las entidades válidas de Telegram (&lt; &gt; &amp; &quot; &#NN; &#xHH;) se respetan
     *    (antes se escapaban dos veces: "A &amp; B" se veía literal en la vista previa).
     *  · Todo lo demás se escapa. Cierres huérfanos se descartan; los cruces se corrigen cerrando y
     *    reabriendo; lo abierto se cierra al final. Dentro de <code> no se abren otras etiquetas.
     */
    safeTelegramHtml(text) {
        const ALIASES = { b: 'b', strong: 'b', i: 'i', em: 'i', u: 'u', ins: 'u', s: 's', strike: 's', del: 's', code: 'code' };
        const TOKEN = /(<(\/?)(b|strong|i|em|u|ins|s|strike|del|code)>)|(&(?:lt|gt|amp|quot|#\d{1,7}|#x[0-9a-fA-F]{1,6});)/gi;
        const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        const textPart = (s) => esc(s).replace(/\r?\n/g, '<br>');
        const src = text === null || text === undefined ? '' : String(text);
        const out = [];
        const stack = [];
        let pos = 0;
        let m;
        TOKEN.lastIndex = 0;
        while ((m = TOKEN.exec(src)) !== null) {
            out.push(textPart(src.slice(pos, m.index)));
            pos = TOKEN.lastIndex;
            if (m[4]) { out.push(m[4]); continue; }
            const closing = Boolean(m[2]);
            const name = ALIASES[m[3].toLowerCase()];
            const inCode = stack.includes('code');
            if (!closing) {
                if (inCode) { out.push(esc(m[1])); continue; }
                stack.push(name);
                out.push(`<${name}>`);
                continue;
            }
            if (!stack.includes(name)) { if (inCode) out.push(esc(m[1])); continue; }
            if (inCode && name !== 'code') { out.push(esc(m[1])); continue; }
            const reopen = [];
            while (stack.length) {
                const top = stack.pop();
                out.push(`</${top}>`);
                if (top === name) break;
                reopen.push(top);
            }
            for (let k = reopen.length - 1; k >= 0; k--) { stack.push(reopen[k]); out.push(`<${reopen[k]}>`); }
        }
        out.push(textPart(src.slice(pos)));
        while (stack.length) out.push(`</${stack.pop()}>`);
        return out.join('');
    },

    /** Botón de acción rápida de un plan: glifo + etiqueta diminuta (5 caben en una fila de 360 px). */
    planActionButton({ action, glyph, label, tip, tone, onclick, disabled = false, spinning = false }) {
        const icon = spinning
            ? '<i class="fa-solid fa-spinner fa-spin pa-glyph"></i>'
            : `<span class="pa-glyph">${glyph}</span>`;
        return `
        <button type="button" data-action="${action}" onclick="${onclick}" title="${this.escapeHtml(tip)}" aria-label="${this.escapeHtml(tip)}"${disabled ? ' disabled' : ''}
            class="plan-action ${PLAN_TONES[tone] || ''}">
            ${icon}
            <span class="pa-label">${this.escapeHtml(label)}</span>
        </button>`;
    },

    /** Barra de confirmación inline (eliminar / difundir): sustituye a la botonera hasta confirmar o cancelar. */
    planConfirmBar(plan, action) {
        const isDelete = action === 'delete';
        const tone = isDelete ? 'rose' : 'magenta';
        const text = this.tf(isDelete ? 'plans_confirm_delete' : 'plans_confirm_broadcast', { name: plan.name });
        const yes = this.t(isDelete ? 'plans_confirm_delete_yes' : 'plans_confirm_broadcast_yes');
        const call = isDelete ? `app.deletePlan(${plan.plan_id}, true)` : `app.broadcastPlan(${plan.plan_id}, true)`;
        return `
        <div role="alertdialog" data-confirm="${action}" class="confirm-bar${isDelete ? ' is-danger' : ''}">
            <p class="break">${this.escapeHtml(text)}</p>
            <div class="cb-actions">
                <button type="button" data-action="cancel" onclick="app.cancelPlanConfirm()" class="btn btn-secondary btn-sm">${this.escapeHtml(this.t('plans_confirm_no'))}</button>
                <button type="button" data-action="confirm" onclick="${call}" class="btn ${isDelete ? 'btn-danger' : 'btn-primary'} btn-sm" data-tone="${tone}">${this.escapeHtml(yes)}</button>
            </div>
        </div>`;
    },

    /** Fila con el enlace de compra generado y su botón Copiar. */
    planLinkRow(plan, link) {
        return `
        <div data-role="plan-link" class="link-row">
            <p class="lr-label">🔗 ${this.escapeHtml(this.t('plans_link_label'))}</p>
            <div class="copy-field" style="background:var(--surface)">
                <span class="lr-url">${this.escapeHtml(link)}</span>
                <button type="button" data-action="copy" onclick="app.copyPlanLink(${plan.plan_id})" class="btn btn-success btn-xs">${this.escapeHtml(this.t('plans_btn_copy'))}</button>
            </div>
            <p class="hint">${this.escapeHtml(this.t('plans_link_hint'))}</p>
        </div>`;
    },

    /** Tarjeta completa de un plan. ctx: { busyAction, confirm, link }. */
    buildPlanCard(plan, ctx = {}) {
        const id = plan.plan_id;
        const active = Boolean(plan.is_active);
        const busyAction = ctx.busyAction || null;
        const busy = Boolean(busyAction);

        const mediaChip = plan.has_media
            ? `<span class="chip">🖼️ ${this.escapeHtml(this.t('plans_media_' + plan.media_type))}</span>`
            : '';

        const actions = ctx.confirm
            ? this.planConfirmBar(plan, ctx.confirm)
            : `<div class="plan-actions">
                ${this.planActionButton({ action: 'preview', glyph: '👁️', label: this.t('plans_btn_preview'), tip: this.t('plans_tip_preview'), tone: 'cyan', onclick: `app.previewPlan(${id})` })}
                ${this.planActionButton({ action: 'toggle', glyph: active ? '⏸️' : '▶️', label: this.t(active ? 'plans_btn_pause' : 'plans_btn_activate'), tip: this.t(active ? 'plans_tip_pause' : 'plans_tip_activate'), tone: 'amber', onclick: `app.togglePlanStatus(${id})`, disabled: busy, spinning: busyAction === 'toggle' })}
                ${this.planActionButton({ action: 'broadcast', glyph: '📢', label: this.t('plans_btn_broadcast'), tip: this.t('plans_tip_broadcast'), tone: 'magenta', onclick: `app.broadcastPlan(${id})`, disabled: busy, spinning: busyAction === 'broadcast' })}
                ${this.planActionButton({ action: 'link', glyph: '🔗', label: this.t(ctx.link ? 'plans_btn_copy' : 'plans_btn_link'), tip: this.t(ctx.link ? 'plans_tip_copy' : 'plans_tip_link'), tone: 'emerald', onclick: `app.generateInviteLink(${id})`, disabled: busy, spinning: busyAction === 'link' })}
                ${this.planActionButton({ action: 'delete', glyph: '🗑️', label: this.t('plans_btn_delete'), tip: this.t('plans_tip_delete'), tone: 'rose', onclick: `app.deletePlan(${id})`, disabled: busy, spinning: busyAction === 'delete' })}
            </div>`;

        return `
        <article id="plan-card-${id}" data-plan-id="${id}" data-status="${active ? 'active' : 'paused'}"${busy ? ' aria-busy="true"' : ''} class="plan-card">
            <div class="pc-head">
                <div style="min-width:0">
                    <h4 class="pc-name truncate">💎 ${this.escapeHtml(plan.name)}</h4>
                    <div class="pc-meta">
                        <span class="chip">⏳ ${this.escapeHtml(this.tf('plans_days', { n: this.fmtNum(plan.duration_days) }))}</span>
                        <span class="chip chip-amber">⭐ ${this.escapeHtml(this.fmtNum(plan.stars_price))} XTR</span>
                        ${mediaChip}
                    </div>
                </div>
                <span data-role="plan-status" class="badge ${active ? 'badge-success' : 'badge-danger'}">${this.escapeHtml(this.t(active ? 'plans_status_active' : 'plans_status_paused'))}</span>
            </div>
            ${ctx.link ? this.planLinkRow(plan, ctx.link) : ''}
            ${actions}
        </article>`;
    },

    /** Resumen bajo el título: "N activos · M en total · K suscriptores activos". */
    renderChannelPlansSummary(list, summary) {
        const el = byId('channel-plans-count');
        if (!el) return;
        if (!Array.isArray(list)) {
            el.textContent = '';
            return;
        }
        const active = summary && Number.isFinite(Number(summary.active_count)) ? Number(summary.active_count) : list.filter(p => p.is_active).length;
        const total = summary && Number.isFinite(Number(summary.total)) ? Number(summary.total) : list.length;
        let text = this.tf('plans_count', { active: this.fmtNum(active), total: this.fmtNum(total) });
        if (summary && summary.subscribers !== null && summary.subscribers !== undefined && Number.isFinite(Number(summary.subscribers))) {
            text += ` · ${this.tf('plans_subscribers', { n: this.fmtNum(summary.subscribers) })}`;
        }
        el.textContent = text;
    },

    /**
     * Dibuja el listado de planes del canal en #channel-plans-list.
     * @param {Array} plansList  Planes del servidor: { plan_id, name, duration_days, stars_price, status, is_active, ... }
     * @param {object} [opts]    { busy: {planId: acción}, confirm: {planId, action}, links: {planId: url}, summary }
     */
    renderChannelPlans(plansList, opts = {}) {
        const host = byId('channel-plans-list');
        if (!host) return;
        const busy = opts.busy || {};
        const links = opts.links || {};
        const confirm = opts.confirm || null;
        const list = (Array.isArray(plansList) ? plansList : []).filter(p => p && Number.isInteger(Number(p.plan_id)));

        this.renderChannelPlansSummary(list, opts.summary);

        if (list.length === 0) {
            host.innerHTML = `
            <div class="empty-state">
                <span class="es-icon">💎</span>
                <p>${this.escapeHtml(this.t('plans_empty'))}</p>
            </div>`;
            return;
        }

        host.innerHTML = list.map(plan => {
            const normalized = { ...plan, plan_id: Number(plan.plan_id) };
            return this.buildPlanCard(normalized, {
                busyAction: busy[normalized.plan_id] || null,
                confirm: confirm && Number(confirm.planId) === normalized.plan_id ? confirm.action : null,
                link: links[normalized.plan_id] || null
            });
        }).join('');
    },

    /** Estados sin lista: idle (sin canal), loading y error (con reintento). */
    renderChannelPlansState(kind, message = '') {
        const host = byId('channel-plans-list');
        if (!host) return;
        this.renderChannelPlansSummary(null);

        if (kind === 'loading') {
            host.innerHTML = `<div class="state-box is-loading"><i class="fa-solid fa-spinner fa-spin"></i> ${this.escapeHtml(this.t('plans_loading'))}</div>`;
        } else if (kind === 'error') {
            host.innerHTML = `
            <div class="state-box is-error">
                <p>⚠️ ${this.escapeHtml(message || this.t('plans_load_error'))}</p>
                <button type="button" data-action="retry" onclick="app.refreshChannelPlans()" class="btn btn-danger btn-sm"><i class="fa-solid fa-rotate"></i> ${this.escapeHtml(this.t('btn_retry'))}</button>
            </div>`;
        } else {
            host.innerHTML = `<div class="empty-state">${this.escapeHtml(this.t('plans_select_channel'))}</div>`;
        }
    },

    /** Vista previa de la tarjeta comercial tal como la verán los suscriptores en Telegram (solo lectura). */
    renderPlanPreview(plan) {
        const body = byId('plan-preview-body');
        if (!body || !plan) return;
        const stars = Number(plan.stars_price) || 0;
        const media = plan.has_media
            ? `<div class="tgp-media">🖼️ ${this.escapeHtml(this.tf('plans_preview_media', { type: this.t('plans_media_' + plan.media_type) }))}</div>`
            : '';
        const promo = plan.promo_text
            ? `<div class="break">${this.safeTelegramHtml(plan.promo_text)}</div>`
            : '';
        const resource = plan.target_link
            ? `<div class="tgp-btn">${this.escapeHtml(this.t('plans_preview_resource'))}</div>`
            : '';

        body.innerHTML = `
        <div data-role="plan-preview" class="tg-preview">
            ${media}
            <div class="tgp-body">
                <p class="tgp-title break">💎 ${this.escapeHtml(plan.name)}</p>
                <p>⏳ <b>${this.escapeHtml(this.t('plans_preview_duration'))}:</b> ${this.escapeHtml(this.tf('plans_days', { n: this.fmtNum(plan.duration_days) }))}</p>
                <p>⭐ <b>${this.escapeHtml(this.t('plans_preview_price'))}:</b> ${this.escapeHtml(this.fmtNum(stars))} XTR</p>
                ${promo}
                <p class="tgp-sign">🛡️ Cloud Media Management</p>
            </div>
            <div class="tgp-buttons">
                <div class="tgp-btn">${this.escapeHtml(this.tf('plans_preview_subscribe', { n: this.fmtNum(stars) }))}</div>
                ${resource}
            </div>
        </div>`;
        this.setVisible('modal-plan-preview', true);
    },

    closePlanPreview() {
        this.setVisible('modal-plan-preview', false);
        const body = byId('plan-preview-body');
        if (body) body.innerHTML = '';
    },

    // ======================================================================
    // 🎬 ESTUDIO DE CANALES — formulario reactivo
    // ======================================================================
    /**
     * Campos del Estudio que se guardan de forma reactiva: la difusión automática de promoción (v8.2).
     * Enlace VIP, tarifa y duración ya no son "ajustes sueltos" del canal: viven en cada plan que crea el
     * Generador de Planes (v8.3) dentro de channel_plans, que es lo que cobra y entrega el bot.
     */
    STUDIO_FIELDS: {
        broadcast_target:   'studio-broadcast-target',
        broadcast_interval: 'studio-broadcast-interval',
        promo_text:         'studio-promo-text'
    },

    /** Valores crudos (texto) de la difusión del Estudio. */
    readStudioForm() {
        const read = (id) => byId(id)?.value ?? '';
        const f = this.STUDIO_FIELDS;
        return {
            broadcast_target: read(f.broadcast_target),
            broadcast_interval: read(f.broadcast_interval),
            promo_text: read(f.promo_text)
        };
    },

    // ======================================================================
    // ➕ GENERADOR DE PLANES (v8.3)
    // ======================================================================
    PLAN_FORM_FIELDS: {
        plan_name:     'plan-form-name',
        stars_price:   'plan-form-price',
        duration_days: 'plan-form-days',
        target_link:   'plan-form-link',
        promo_text:    'plan-form-promo'
    },

    readPlanForm() {
        const read = (id) => byId(id)?.value ?? '';
        const f = this.PLAN_FORM_FIELDS;
        return Object.fromEntries(Object.entries(f).map(([key, id]) => [key, read(id)]));
    },

    /** Restablece el formulario a sus valores por defecto (también con el foco: es una acción explícita). */
    resetPlanForm() {
        const defaults = {
            plan_name: '', target_link: '', promo_text: '',
            stars_price: String(CONFIG.PLAN_FORM?.DEFAULT_PRICE ?? 150),
            duration_days: String(CONFIG.PLAN_FORM?.DEFAULT_DAYS ?? 30)
        };
        Object.entries(this.PLAN_FORM_FIELDS).forEach(([key, id]) => {
            const el = byId(id);
            if (el) el.value = defaults[key];
            this.setFieldError(id, '');
        });
        this.updatePlanPromoCounter();
        this.renderPlanFormResult(null);
    },

    clearPlanFormErrors() {
        Object.values(this.PLAN_FORM_FIELDS).forEach(id => this.setFieldError(id, ''));
    },

    updatePlanPromoCounter() {
        const area = byId(this.PLAN_FORM_FIELDS.promo_text);
        const counter = byId('plan-form-promo-counter');
        if (!area || !counter) return;
        const max = CONFIG.PLAN_FORM?.PROMO_MAX || 1000;
        const len = area.value.length;
        counter.textContent = `${len}/${max}`;
        counter.className = `counter${len > max ? ' is-over' : len > max * 0.9 ? ' is-warn' : ''}`;
    },

    /** Botones del generador ocupados (crear / difundir) con spinner en el botón principal. */
    setPlanFormBusy(busy) {
        ['pf-create-btn', 'pf-broadcast-btn', 'pf-clear-btn', 'pf-preview-btn'].forEach(id => this.setButtonBusy(id, busy));
        const icon = byId('pf-create-icon');
        if (icon) icon.innerHTML = busy ? '<i class="fa-solid fa-spinner fa-spin"></i>' : '💾';
        this.setText('pf-create-label', this.t(busy ? 'pf_creating' : 'pf_btn_create'));
    },

    /**
     * Resultado de la creación: enlace de compra y, si el bot puede invitar, el enlace de verificación de
     * un solo uso (solo para el propietario). null lo oculta.
     */
    renderPlanFormResult(result) {
        const box = byId('plan-form-result');
        if (!box) return;
        if (!result || !result.plan) {
            box.innerHTML = '';
            box.className = 'result-box hidden';
            return;
        }
        const rows = [];
        if (result.purchase_link) {
            rows.push(`<p class="break">🔗 <span class="mono" style="user-select:all">${this.escapeHtml(result.purchase_link)}</span></p>`);
        }
        const check = result.delivery || {};
        if (check.ready && check.invite_link) {
            rows.push(`<p class="text-soft">${this.escapeHtml(this.t('pf_check_link'))}: <span class="mono text-primary break" style="user-select:all">${this.escapeHtml(check.invite_link)}</span></p>`);
        } else {
            rows.push(`<p class="text-warning">⚠️ ${this.escapeHtml(this.t('pf_toast_created_warn'))}</p>`);
        }
        box.className = `result-box ${check.ready ? 'is-ok' : 'is-warn'}`;
        box.innerHTML = `<p><strong>💎 ${this.escapeHtml(result.plan.name)}</strong> · ${this.escapeHtml(this.fmtNum(result.plan.stars_price))} ⭐ · ${this.escapeHtml(this.tf('plans_days', { n: this.fmtNum(result.plan.duration_days) }))}</p>${rows.join('')}`;
    },

    // ======================================================================
    // 🎛️ CONSOLA DE PROGRAMACIÓN 1:1 (v8.3)
    // ======================================================================
    /** Campos de cada módulo. Los de tipo 'switch' se aplican al instante; el resto con "Guardar". */
    CONFIG_LAYOUT: {
        aduana: {
            captcha_enabled: 'switch', captcha_mode: 'select', captcha_timeout: 'int', custom_welcome: 'text'
        },
        acoustic: {
            autolower_enabled: 'switch', autolower_pct: 'int', shield_enabled: 'switch', micvip_price: 'int', speaker_price: 'int'
        },
        tips: {
            tips_enabled: 'switch', tips_presets: 'presets', custom_tips_allowed: 'switch'
        },
        perimeter: {
            linklock_enabled: 'switch', antiflood_enabled: 'switch', antiflood_rate: 'int', antiflood_window: 'int',
            service_cleaner_enabled: 'switch'
        }
    },

    configSectionOf(field) {
        return Object.keys(this.CONFIG_LAYOUT).find(sec => Object.prototype.hasOwnProperty.call(this.CONFIG_LAYOUT[sec], field)) || null;
    },

    /** Interruptor visual (role="switch"). busy=true muestra el pulso mientras viaja la petición. */
    setConfigSwitch(field, on, { busy = false, disabled = false } = {}) {
        const btn = byId(`cfg-${field}`);
        if (!btn) return;
        btn.setAttribute('aria-checked', on ? 'true' : 'false');
        btn.disabled = Boolean(disabled || busy);
        btn.classList.toggle('is-on', Boolean(on));
        btn.classList.toggle('is-busy', Boolean(busy));
    },

    getConfigSwitch(field) {
        return byId(`cfg-${field}`)?.getAttribute('aria-checked') === 'true';
    },

    updateAutolowerLabel() {
        const range = byId('cfg-autolower_pct');
        this.setText('cfg-autolower_pct-value', `${range ? range.value : 2}%`);
    },

    updateWelcomeCounter() {
        const area = byId('cfg-custom_welcome');
        const counter = byId('cfg-custom_welcome-counter');
        if (!area || !counter) return;
        const max = CONFIG.CHAT_CONFIG?.WELCOME_MAX || 1000;
        counter.textContent = `${area.value.length}/${max}`;
        counter.className = `counter${area.value.length > max ? ' is-over' : ''}`;
    },

    /**
     * Pinta la configuración recibida del servidor. `skipSections` protege los módulos con ediciones sin
     * guardar, y un campo con el foco nunca se pisa (el operador puede estar escribiendo).
     */
    renderChatConfiguration(config, { skipSections = [] } = {}) {
        if (!config) return;
        Object.entries(this.CONFIG_LAYOUT).forEach(([section, fields]) => {
            if (skipSections.includes(section)) return;
            const values = config[section] || {};
            Object.entries(fields).forEach(([field, kind]) => {
                if (!Object.prototype.hasOwnProperty.call(values, field)) return;
                const value = values[field];
                if (kind === 'switch') {
                    this.setConfigSwitch(field, Boolean(value));
                    return;
                }
                const el = byId(`cfg-${field}`);
                if (!el || document.activeElement === el) return;
                el.value = kind === 'presets' ? (Array.isArray(value) ? value.join(', ') : String(value ?? '')) : String(value ?? '');
                this.setFieldError(`cfg-${field}`, '');
            });
        });
        this.updateAutolowerLabel();
        this.updateWelcomeCounter();
    },

    /** Valores crudos de los campos NO interruptor de un módulo. */
    readConfigSection(section) {
        const fields = this.CONFIG_LAYOUT[section] || {};
        const out = {};
        Object.entries(fields).forEach(([field, kind]) => {
            if (kind === 'switch') return;
            out[field] = byId(`cfg-${field}`)?.value ?? '';
        });
        return out;
    },

    /** Estado del módulo: idle | dirty | saving | saved | invalid | error | remote. */
    setConfigSectionStatus(section, kind, text = '') {
        const el = byId(`cfg-status-${section}`);
        if (!el) return;
        const tone = {
            dirty: 'text-warning', saving: 'text-primary is-pulsing', saved: 'text-success',
            invalid: 'text-danger', error: 'text-danger', remote: 'text-violet'
        }[kind] || 'text-muted';
        el.textContent = text;
        el.className = `cfg-status ${tone}`;
    },

    setConfigSectionBusy(section, busy) {
        this.setButtonBusy(`cfg-save-${section}`, busy);
        this.setText(`cfg-save-label-${section}`, this.t(busy ? 'cfg_saving' : 'cfg_save'));
    },

    /**
     * Estado global de la consola: 'idle' (sin comunidad), 'loading' o 'ready'. Fuera de 'ready' todos los
     * controles quedan deshabilitados: nunca se edita sobre valores que no vinieron del servidor.
     */
    setConsoleState(kind, message = '') {
        const ready = kind === 'ready';
        document.querySelectorAll('#cfg-console .cfg-input, #cfg-console .cfg-switch, #cfg-console [id^="cfg-save-"]').forEach(el => {
            if (el.tagName === 'BUTTON' && el.id.startsWith('cfg-save-label')) return;
            el.disabled = !ready;
        });
        const label = byId('cfg-console-state');
        if (label) {
            label.textContent = message || (kind === 'loading' ? this.t('cfg_loading') : kind === 'idle' ? this.t('cfg_pick') : '');
            label.className = `cfg-status ${kind === 'loading' ? 'text-primary is-pulsing' : 'text-muted'}`;
        }
        if (!ready) {
            Object.keys(this.CONFIG_LAYOUT).forEach(sec => this.setConfigSectionStatus(sec, 'idle'));
            this.renderPerimeterSummary(null);
        }
    },

    /** Contador de caracteres del texto promocional (rojo al superar el límite). */
    updatePromoCounter() {
        const area = byId(this.STUDIO_FIELDS.promo_text);
        const counter = byId('studio-promo-counter');
        if (!area || !counter) return;
        const max = CONFIG.STUDIO?.PROMO_MAX || 1000;
        const len = area.value.length;
        counter.textContent = `${len}/${max}`;
        counter.className = `counter${len > max ? ' is-over' : len > max * 0.9 ? ' is-warn' : ''}`;
    },

    /** Indicador de la difusión automática guardada en el servidor. */
    setBroadcastStatus(cfg) {
        const on = Boolean(cfg && cfg.broadcast_enabled);
        const text = on ? this.tf('bc_status_on', { h: cfg.broadcast_interval }) : this.t('bc_status_off');
        const el = byId('studio-broadcast-status');
        if (el) {
            el.textContent = text;
            el.className = on ? 'text-success' : 'text-muted';
        }
        // Espejo en el resumen de Telemetría (perímetro operativo).
        const tel = byId('telemetry-broadcast');
        if (tel) {
            tel.textContent = cfg ? text : '—';
            tel.className = `sr-value ${cfg ? (on ? 'text-success' : 'text-muted') : 'text-muted'}`;
        }
    },

    /**
     * Vista previa de la difusión personalizada. El texto pasa por safeTelegramHtml (misma gramática que
     * telegram_html.py en el backend): lo que se ve aquí es exactamente lo que se publica.
     */
    renderBroadcastPreview({ promoText = '', targetLabel = '', interval = 12, scheduled = false } = {}) {
        const body = byId('broadcast-preview-body');
        if (!body) return;
        const target = targetLabel
            ? this.tf('bc_preview_target', { target: targetLabel })
            : this.t('bc_preview_target_self');
        const schedule = scheduled ? this.tf('bc_preview_schedule', { h: interval }) : this.t('bc_preview_schedule_off');
        body.innerHTML = `
        <div class="stack" style="gap:10px">
            <div class="btn-row">
                <span class="chip">📍 ${this.escapeHtml(target)}</span>
                <span class="chip">⏱️ ${this.escapeHtml(schedule)}</span>
            </div>
            <div data-role="broadcast-preview" class="tg-preview">
                <div class="tgp-body">
                    <div class="break">${this.safeTelegramHtml(promoText)}</div>
                    <p class="tgp-sign">🛡️ Cloud Media Management</p>
                </div>
                <div class="tgp-buttons">
                    <div class="tgp-btn">${this.escapeHtml(this.t('bc_preview_buy'))}</div>
                </div>
            </div>
            <p class="hint">${this.escapeHtml(this.t('bc_preview_buy_note'))}</p>
        </div>`;
        this.setVisible('modal-broadcast-preview', true);
    },

    closeBroadcastPreview() {
        this.setVisible('modal-broadcast-preview', false);
        const body = byId('broadcast-preview-body');
        if (body) body.innerHTML = '';
    },

    /** Deshabilita los botones de difusión mientras se publica (evita dobles envíos). */
    setBroadcastBusy(busy) {
        ['bc-send-btn', 'bc-preview-send-btn', 'bc-clear-btn'].forEach(id => this.setButtonBusy(id, busy));
        const icon = byId('bc-send-icon');
        if (icon) icon.innerHTML = busy ? '<i class="fa-solid fa-spinner fa-spin"></i>' : '📢';
    },

    /** Botón ocupado genérico (disabled + aria-busy). */
    setButtonBusy(id, busy) {
        const btn = byId(id);
        if (!btn) return;
        btn.disabled = Boolean(busy);
        btn.setAttribute('aria-busy', busy ? 'true' : 'false');
    },

    // ======================================================================
    // 🧾 CANAL DE REGISTRO — modal nativo (v8.2)
    // ======================================================================
    openLogChannelView({ community = '', current = '' } = {}) {
        this.setText('log-channel-community', community || '—');
        this.setText('log-channel-current', current || this.t('logm_none'));
        const input = byId('log-channel-input');
        if (input) input.value = current || '';
        this.setFieldError('log-channel-input', '');
        this.setLogChannelBusy(false);
        this.setVisible('modal-log-channel', true);
        // En móviles el foco abre el teclado al instante; un pequeño retraso evita saltos de la animación.
        if (input) setTimeout(() => { try { input.focus({ preventScroll: true }); } catch (err) { input.focus(); } }, 120);
    },

    closeLogChannelView() {
        const input = byId('log-channel-input');
        if (input) input.blur();
        this.setVisible('modal-log-channel', false);
        this.setLogChannelBusy(false);
    },

    isLogChannelOpen() {
        const el = byId('modal-log-channel');
        return Boolean(el && !el.classList.contains('hidden'));
    },

    setLogChannelBusy(busy) {
        this.setButtonBusy('log-channel-save-btn', busy);
        this.setText('log-channel-save-label', this.t(busy ? 'logm_saving' : 'logm_save'));
        const input = byId('log-channel-input');
        if (input) input.readOnly = Boolean(busy);
    },

    /** Texto del panel "Log Channel" de la comunidad. */
    renderLogChannelStatus(logChannel) {
        const logEl = byId('chat-log-channel');
        if (!logEl) return;
        const enabled = Boolean(logChannel?.enabled && logChannel?.channel_id);
        logEl.textContent = enabled ? `${this.t('status_enabled')} (${logChannel.channel_id})` : this.t('status_disabled');
        logEl.className = `sr-value truncate ${enabled ? 'text-success' : 'text-muted'}`;
    },

    // ======================================================================
    // 🛡️ CONSOLA DE GRUPOS — interruptores de moderación (v8.2)
    // ======================================================================
    /**
     * Pinta los interruptores. loading=true: estado aún desconocido (nunca se muestra un valor inventado).
     * idle=true: no hay comunidad seleccionada ('—'). busyKey: interruptor con una petición en curso.
     */
    renderSecuritySwitches(switches, { loading = false, busyKey = null, idle = false } = {}) {
        // Compatibilidad v8.2: los interruptores heredados son ahora campos de la consola de programación.
        const legacy = CONFIG.CHAT_CONFIG?.LEGACY_SWITCHES || {};
        Object.entries(legacy).forEach(([key, field]) => {
            const known = !loading && !idle && switches && Object.prototype.hasOwnProperty.call(switches, key);
            this.setConfigSwitch(field, known && Boolean(switches[key]), { busy: busyKey === key, disabled: !known });
        });
    },

    /**
     * Rellena los campos con valores del servidor. Un campo con el foco no se toca: el operador
     * puede estar escribiendo mientras llega la respuesta y no se le debe pisar lo tecleado.
     */
    fillStudioForm(values) {
        const fields = this.STUDIO_FIELDS;
        Object.entries(fields).forEach(([key, id]) => {
            const el = byId(id);
            if (!el || document.activeElement === el) return;
            if (!values || !Object.prototype.hasOwnProperty.call(values, key)) return;   // campo no incluido: se respeta
            const value = values[key];
            const text = (value === null || value === undefined) ? '' : String(value);
            if (el.tagName === 'SELECT' && !Array.from(el.options).some(o => o.value === text)) {
                el.value = String(CONFIG.STUDIO?.DEFAULT_INTERVAL ?? 12);   // valor desconocido → intervalo por defecto
            } else {
                el.value = text;
            }
        });
        this.updatePromoCounter();
    },

    /** Marca (o limpia) el error de un campo del Estudio. `message` vacío limpia. */
    setFieldError(inputId, message) {
        const input = byId(inputId);
        const hint = byId(`${inputId}-error`);
        const invalid = Boolean(message);
        if (input) {
            input.classList.toggle('is-invalid', invalid);
            input.setAttribute('aria-invalid', invalid ? 'true' : 'false');
        }
        if (hint) {
            hint.textContent = message || '';
            hint.classList.toggle('hidden', !invalid);
        }
    },

    clearStudioErrors() {
        Object.values(this.STUDIO_FIELDS).forEach(id => this.setFieldError(id, ''));
    },

    /** Indicador de guardado: kind ∈ idle | dirty | saving | saved | mismatch | invalid | error. */
    setStudioStatus(kind, text = '') {
        const el = byId('studio-save-status');
        if (!el) return;
        const known = Object.prototype.hasOwnProperty.call(STUDIO_STATUS_STYLE, kind) ? kind : 'idle';
        el.textContent = text;
        el.className = `hint ${STUDIO_STATUS_STYLE[known]}`;
        el.setAttribute('data-status', known);
    },

    /** Deshabilita el botón mientras se guarda (evita dobles envíos). */
    setStudioBusy(busy) {
        const btn = byId('studio-save-btn');
        if (!btn) return;
        btn.disabled = Boolean(busy);
        btn.setAttribute('aria-busy', busy ? 'true' : 'false');
    },

    // ======================================================================
    // 🔐 SESIÓN
    // ======================================================================
    /** Aviso a pantalla completa cuando el initData de Telegram ya no es válido (no hay forma de renovarlo desde dentro). */
    showSessionExpired(show) {
        this.setVisible('session-expired', Boolean(show));
    },

    /**
     * Vacía todo lo que se pintó con datos de un operador. Se llama al cerrar sesión y al detectar que la
     * identidad cambió: ningún dato de la sesión anterior puede quedar en el DOM, ni siquiera oculto.
     */
    resetSessionView() {
        ['channels-list', 'groups-list', 'watchdog-list', 'chat-top-users-list', 'chat-admin-stats-list',
         'an-leaderboard', 'an-heatmap', 'an-breakdown-bar', 'an-breakdown-legend', 'an-live-feed',
         'an-spark-messages', 'an-spark-active', 'an-spark-growth'].forEach(id => {
            const el = byId(id);
            if (el) el.innerHTML = '';
        });

        ['channel-owner-select', 'group-owner-select', 'analytics-chat-select'].forEach(id => {
            const el = byId(id);
            if (el) {
                el.innerHTML = '<option value=""></option>';
                el.value = '';
            }
        });

        this.renderStats({});
        this.renderAffiliateLink(null);
        // Estos dos elementos llevan data-i18n: se restauran a su texto por defecto traducido.
        this.renderChatPlanStatus(null);
        this.renderLogChannelStatus(null);
        this.renderTopUsers(null);
        this.renderAdminStats(null);
        this.renderPerimeterSummary(null);
        this.fillStudioForm({
            broadcast_target: '',
            broadcast_interval: CONFIG.STUDIO?.DEFAULT_INTERVAL ?? 12,
            promo_text: ''
        });
        this.resetPlanForm();
        this.updatePromoCounter();
        this.setBroadcastStatus(null);
        this.closeBroadcastPreview();
        this.closeLogChannelView();
        Object.keys(this.CONFIG_LAYOUT).forEach(section => {
            Object.entries(this.CONFIG_LAYOUT[section]).forEach(([field, kind]) => {
                if (kind === 'switch') this.setConfigSwitch(field, false, { disabled: true });
                else this.setFieldError(`cfg-${field}`, '');
            });
        });
        this.setConsoleState('idle');
        this.clearStudioErrors();
        this.setStudioStatus('idle');
        this.setText('channel-id-display', 'ID: —');
        this.renderChannelPlansState('idle');
        this.closePlanPreview();
        this.setRadarTarget('');
        this.resetAnalyticsView();
        this.renderVoiceCard();
    },

    // ======================================================================
    // 🔴 ACTIVIDAD EN VIVO (feed)
    // ======================================================================
    feedItemText(item) {
        const vars = { ...(item.vars || {}) };
        if (vars.kind !== undefined) vars.kind = this.kindLabel(vars.kind);
        return this.tf(item.key, vars);
    },

    buildFeedRow(item) {
        const row = document.createElement('div');
        row.className = 'feed-row';

        const icon = document.createElement('span');
        icon.textContent = item.icon || '•';

        const text = document.createElement('span');
        text.className = 'fr-text';
        text.textContent = this.feedItemText(item);   // textContent: los nombres de usuario nunca se interpretan como HTML

        const time = document.createElement('span');
        time.className = 'fr-time';
        time.textContent = new Date(item.ts).toLocaleTimeString(state.currentLang === 'es' ? 'es-CO' : 'en-US', { hour12: false });

        row.appendChild(icon);
        row.appendChild(text);
        row.appendChild(time);
        return row;
    },

    /** item: { icon, key, vars } — se localiza al pintar, así sobrevive al cambio de idioma. */
    pushFeedItem(item) {
        const entry = { ...item, ts: item.ts || Date.now() };
        const max = CONFIG.ANALYTICS?.FEED_MAX_ITEMS || 30;
        state.liveFeed.unshift(entry);
        if (state.liveFeed.length > max) state.liveFeed.length = max;

        const list = byId('an-live-feed');
        if (!list) return;
        byId('an-feed-empty')?.classList.add('hidden');
        list.prepend(this.buildFeedRow(entry));
        while (list.children.length > max) list.lastElementChild.remove();
    },

    /** Repinta el feed completo (cambio de idioma). El marcador "esperando…" vive fuera de la lista. */
    renderFeed() {
        const list = byId('an-live-feed');
        if (!list) return;
        list.innerHTML = '';
        state.liveFeed.forEach(entry => list.appendChild(this.buildFeedRow(entry)));
        byId('an-feed-empty')?.classList.toggle('hidden', state.liveFeed.length > 0);
    },

    clearFeed() {
        state.liveFeed = [];
        this.renderFeed();
    },

    // ======================================================================
    // 🔔 TOASTS FLOTANTES
    // ======================================================================
    _toasts: new Map(),      // key → { el, timer }
    _msgBuf: [],
    _msgTimer: null,

    getToastHost() {
        let host = byId('toast-stack');
        if (!host) {
            host = document.createElement('div');
            host.id = 'toast-stack';

            document.body.appendChild(host);
        }
        return host;
    },

    /**
     * Aviso flotante. Con `key` repetida se actualiza el aviso existente en lugar de apilar otro.
     * Devuelve el elemento (o null si las alertas están silenciadas y no se fuerza).
     */
    showToast({ key = null, icon = '🔔', title = '', body = '', tone = 'info', ttl = 4500, force = false } = {}) {
        if (!state.liveToastsEnabled && !force) return null;
        this.ensureLiveStyles();
        const host = this.getToastHost();

        let entry = key ? this._toasts.get(key) : null;
        if (entry) {
            clearTimeout(entry.timer);
            this._fillToast(entry.el, { icon, title, body });
        } else {
            const el = document.createElement('div');
            el.className = `toast bk-toast ${TOAST_TONES[tone] || TOAST_TONES.info}`;
            el.setAttribute('role', 'status');
            el.addEventListener('click', () => this.dismissToast(key || el));
            this._fillToast(el, { icon, title, body });
            host.appendChild(el);
            entry = { el, timer: null };
            this._toasts.set(key || el, entry);

            const max = CONFIG.ANALYTICS?.TOAST_MAX_VISIBLE || 3;
            while (this._toasts.size > max) {
                this.dismissToast(this._toasts.keys().next().value);
            }
        }

        entry.timer = setTimeout(() => this.dismissToast(key || entry.el), ttl);
        return entry.el;
    },

    _fillToast(el, { icon, title, body }) {
        el.textContent = '';
        const iconEl = document.createElement('span');
        iconEl.className = 't-icon';
        iconEl.textContent = icon;

        const box = document.createElement('div');
        box.style.minWidth = '0';
        box.style.flex = '1';
        const titleEl = document.createElement('p');
        titleEl.className = 't-title';
        titleEl.textContent = title;
        box.appendChild(titleEl);
        if (body) {
            const bodyEl = document.createElement('p');
            bodyEl.className = 't-body';
            bodyEl.textContent = body;
            box.appendChild(bodyEl);
        }

        el.appendChild(iconEl);
        el.appendChild(box);
    },

    dismissToast(keyOrEl) {
        const entry = this._toasts.get(keyOrEl);
        if (!entry) return;
        clearTimeout(entry.timer);
        this._toasts.delete(keyOrEl);
        entry.el.classList.add('bk-toast-out');
        setTimeout(() => entry.el.remove(), 200);
    },

    clearToasts() {
        [...this._toasts.keys()].forEach(key => this.dismissToast(key));
        clearTimeout(this._msgTimer);
        this._msgTimer = null;
        this._msgBuf = [];
    },

    /** Ascenso de nivel de gamificación (evento level_up). */
    notifyLevelUp({ name, level, userId }) {
        this.showToast({
            key: `level-${userId ?? name}`,
            icon: '🏆',
            tone: 'level',
            ttl: 6500,
            title: this.t('toast_level_up_title'),
            body: this.tf('toast_level_up_body', { name, level })
        });
    },

    /**
     * Mensajes en vivo: se agrupan en ventanas de unos segundos para no inundar la pantalla
     * en comunidades activas (un aviso por ventana, que se actualiza en lugar de apilarse).
     */
    notifyLiveMessage({ name, kind }) {
        if (!state.liveToastsEnabled || document.hidden) return;
        this._msgBuf.push({ name, kind });
        if (this._msgTimer) return;
        this._msgTimer = setTimeout(() => this.flushMessageToast(), CONFIG.ANALYTICS?.MESSAGE_TOAST_WINDOW_MS || 2500);
    },

    flushMessageToast() {
        const buffer = this._msgBuf;
        this._msgBuf = [];
        this._msgTimer = null;
        if (!buffer.length) return;

        if (buffer.length === 1) {
            const only = buffer[0];
            this.showToast({
                key: 'live-messages',
                icon: (KIND_META[only.kind] || KIND_META.other).icon,
                tone: 'info',
                ttl: 3500,
                title: this.t('toast_msg_title_one'),
                body: this.tf('feed_message', { name: only.name, kind: this.kindLabel(only.kind) })
            });
            return;
        }

        const names = [...new Set(buffer.map(item => item.name))];
        const shown = names.slice(0, 3).join(', ');
        this.showToast({
            key: 'live-messages',
            icon: '💬',
            tone: 'info',
            ttl: 3500,
            title: this.tf('toast_msg_title_many', { n: buffer.length }),
            body: names.length > 3 ? `${shown} +${names.length - 3}` : shown
        });
    },

    notifyVoiceCall(started) {
        this.showToast({
            key: 'voice-call',
            icon: started ? '🎙️' : '🔇',
            tone: started ? 'success' : 'warn',
            ttl: 4500,
            title: this.t(started ? 'toast_voice_started' : 'toast_voice_ended')
        });
    },

    notifyStarsPayment({ name, stars }) {
        this.showToast({
            key: `payment-${Date.now()}`,
            icon: '⭐',
            tone: 'success',
            ttl: 6000,
            title: this.t('toast_payment_title'),
            body: this.tf('toast_payment_body', { stars, name })
        });
    },

    // ======================================================================
    // 🧭 NAVEGACIÓN (v9.0 · interfaz tipo constructor)
    // ======================================================================
    /** Claves de título y subtítulo de cada sección (barra superior). */
    TAB_META: {
        dashboard:      { title: 'nav_dash',        sub: 'page_sub_dashboard' },
        analytics:      { title: 'nav_analytics',   sub: 'page_sub_analytics' },
        channels:       { title: 'nav_channels',    sub: 'page_sub_channels' },
        groups:         { title: 'nav_groups',      sub: 'page_sub_groups' },
        'bot-settings': { title: 'groups_title',    sub: 'page_sub_bot_settings' },
        watchdog:       { title: 'nav_watchdog',    sub: 'page_sub_watchdog' },
        plans:          { title: 'nav_plans',       sub: 'page_sub_plans' },
        affiliates:     { title: 'nav_aff',         sub: 'page_sub_affiliates' },
        profile:        { title: 'menu_my_profile', sub: 'page_sub_profile' }
    },

    /** Marca la sección activa en la barra lateral y actualiza el título de la barra superior. */
    setActiveNav(tabId) {
        document.querySelectorAll('.nav-item[data-tab]').forEach(item => {
            const active = item.getAttribute('data-tab') === tabId;
            item.classList.toggle('is-active', active);
            if (active) item.setAttribute('aria-current', 'page');
            else item.removeAttribute('aria-current');
        });
        const meta = this.TAB_META[tabId] || this.TAB_META.dashboard;
        const title = byId('page-title');
        if (title) {
            title.setAttribute('data-i18n', meta.title);
            title.textContent = this.t(meta.title);
        }
        const sub = byId('page-subtitle');
        if (sub) {
            sub.setAttribute('data-i18n', meta.sub);
            sub.textContent = this.t(meta.sub);
        }
    },

    /** Precios de los planes de la plataforma desde CONFIG.PRICES (única fuente). */
    renderPlatformPrices() {
        document.querySelectorAll('[data-price]').forEach(el => {
            const plan = CONFIG.PRICES?.[el.getAttribute('data-price')];
            if (plan && Number.isFinite(Number(plan.stars))) el.textContent = this.fmtNum(plan.stars);
        });
    },

    // ======================================================================
    // 🛡️ PANEL DE LA COMUNIDAD
    // ======================================================================
    /** Estado del plan tarifario de la comunidad (null = sin datos / sin tarifa). */
    renderChatPlanStatus(plan) {
        const el = byId('chat-plan-status');
        if (!el) return;
        const isActive = plan?.status === 'active';
        el.textContent = isActive ? `${this.t('tariff_active')} (${plan.name || ''})` : this.t('tariff_empty');
        el.className = `sr-value ${isActive ? 'text-success' : 'text-danger'}`;
        el.style.textAlign = 'left';
    },

    /** Top 10 de usuarios activos (30 días) de /chat/{id}/top-users. */
    renderTopUsers(list) {
        const el = byId('chat-top-users-list');
        if (!el) return;
        if (!Array.isArray(list) || list.length === 0) {
            el.innerHTML = `<p class="hint" style="padding:10px 0">${this.escapeHtml(this.t('top_users_empty'))}</p>`;
            return;
        }
        const medals = ['🥇', '🥈', '🥉'];
        el.innerHTML = list.map(u => `
            <div class="row-item">
                <span class="rank">${medals[u.rank - 1] || `#${this.escapeHtml(u.rank)}`}</span>
                <div class="li-main" style="flex:1;min-width:0">
                    <p class="li-title truncate">${this.escapeHtml(u.name)}</p>
                    ${u.badge ? `<p class="li-sub">${this.escapeHtml(u.badge)}</p>` : ''}
                </div>
                <span class="text-primary mono" style="font-weight:700;font-size:12.5px">${this.escapeHtml(this.tf('top_msgs', { n: this.fmtNum(u.messages) }))}</span>
            </div>`).join('');
    },

    /** Rendimiento de administradores de /chat/{id}/admin-stats. */
    renderAdminStats(list) {
        const el = byId('chat-admin-stats-list');
        if (!el) return;
        if (!Array.isArray(list) || list.length === 0) {
            el.innerHTML = `<p class="hint" style="padding:10px 0">${this.escapeHtml(this.t('admin_stats_empty'))}</p>`;
            return;
        }
        el.innerHTML = list.map(adm => `
            <div class="row-item">
                <div class="avatar sm">${this.escapeHtml(String(adm.name || '?').charAt(0).toUpperCase())}</div>
                <div class="li-main" style="flex:1;min-width:0">
                    <p class="li-title truncate">${this.escapeHtml(adm.name)}</p>
                    <p class="li-sub">${this.escapeHtml(adm.role)}</p>
                </div>
                <div style="text-align:right">
                    <p class="text-primary mono" style="font-weight:700;font-size:12.5px">${this.escapeHtml(this.tf('admin_msgs', { n: this.fmtNum(adm.messages) }))}</p>
                    <p class="hint">${this.escapeHtml(this.tf('admin_replies', { n: this.fmtNum(adm.replies) }))}</p>
                </div>
            </div>`).join('');
    },

    /**
     * Resumen del perímetro en Telemetría a partir de la configuración REAL de la comunidad seleccionada
     * (GET /chat/{id}/configuration). Sin comunidad cargada se muestra "Elige una comunidad", nunca un valor inventado.
     */
    renderPerimeterSummary(config) {
        const set = (id, text, on) => {
            const el = byId(id);
            if (!el) return;
            el.textContent = text;
            el.className = `sr-value ${on === null ? 'text-muted' : on ? 'text-success' : 'text-muted'}`;
        };
        if (!config) {
            ['telemetry-captcha', 'telemetry-autolower', 'telemetry-shield'].forEach(id => set(id, this.t('tel_pick'), null));
            return;
        }
        const captcha = Boolean(config.aduana?.captcha_enabled);
        const autolower = Boolean(config.acoustic?.autolower_enabled);
        const shield = Boolean(config.acoustic?.shield_enabled);
        set('telemetry-captcha', this.t(captcha ? 'tel_on' : 'tel_off'), captcha);
        set('telemetry-autolower', autolower ? this.tf('tel_autolower', { pct: config.acoustic?.autolower_pct ?? '—' }) : this.t('tel_off'), autolower);
        set('telemetry-shield', this.t(shield ? 'tel_on' : 'tel_off'), shield);
    }
};
