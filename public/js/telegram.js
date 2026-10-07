/* ==========================================================================
   THE BUNKER — COMMAND OS
   telegram.js — SDK de Telegram WebApp: viewport, colores del tema, hápticos
   y widget oficial de inicio de sesión (fuera de Telegram).
   The Bunker Command OS © 2026 — Cloud Media Management
   ========================================================================== */

import { CONFIG } from './config.js';

// Colores de la cabecera y el fondo nativos de Telegram para cada tema (coinciden con styles.css).
const THEME_COLORS = {
    light: { header: '#ffffff', background: '#f3f5f9' },
    dark:  { header: '#161d27', background: '#0e131a' }
};

export const tgApp = {
    get tg() {
        return window.Telegram?.WebApp || null;
    },

    /** true solo si la página se abrió como Mini App con initData firmado. */
    get isMiniApp() {
        const raw = this.tg?.initData;
        return typeof raw === 'string' && raw.trim() !== '';
    },

    /** Esquema de color del cliente de Telegram ('light' | 'dark') o null fuera de Telegram. */
    colorScheme() {
        if (!this.isMiniApp) return null;
        const scheme = this.tg?.colorScheme;
        return scheme === 'dark' || scheme === 'light' ? scheme : null;
    },

    initViewport() {
        const tg = this.tg;
        if (!tg) return;
        try { tg.ready(); } catch (e) { /* SDK antiguo */ }
        try { tg.expand(); } catch (e) { /* SDK antiguo */ }
        // Evita que un deslizamiento vertical cierre la Mini App mientras se hace scroll en formularios largos.
        if (typeof tg.disableVerticalSwipes === 'function') {
            try { tg.disableVerticalSwipes(); } catch (e) { /* cliente sin soporte */ }
        }
    },

    setThemeColors(theme) {
        const tg = this.tg;
        if (!tg) return;
        const colors = THEME_COLORS[theme] || THEME_COLORS.light;
        if (typeof tg.setHeaderColor === 'function') {
            try { tg.setHeaderColor(colors.header); } catch (e) { /* versión sin soporte de color libre */ }
        }
        if (typeof tg.setBackgroundColor === 'function') {
            try { tg.setBackgroundColor(colors.background); } catch (e) { /* versión sin soporte */ }
        }
    },

    hapticImpact(style = 'light') {
        try { this.tg?.HapticFeedback?.impactOccurred(style); } catch (e) { /* sin hápticos */ }
    },

    hapticNotification(type = 'success') {
        try { this.tg?.HapticFeedback?.notificationOccurred(type); } catch (e) { /* sin hápticos */ }
    },

    hapticSelection() {
        try { this.tg?.HapticFeedback?.selectionChanged(); } catch (e) { /* sin hápticos */ }
    },

    openTelegramLink(url) {
        if (this.tg && typeof this.tg.openTelegramLink === 'function') {
            this.tg.openTelegramLink(url);
        } else {
            window.open(url, '_blank', 'noopener');
        }
    },

    closeApp() {
        if (this.tg && typeof this.tg.close === 'function') this.tg.close();
    },

    /**
     * Inyecta el widget oficial "Log in with Telegram" en #telegram-login-widget-container.
     * El dominio debe estar autorizado en @BotFather (/setdomain). Una sola vez por carga.
     * Nota: la credencial que devuelve el widget se canjea en el servidor por un token de sesión;
     * jamás se guarda initData en el navegador (ver session en api.js).
     */
    renderTelegramWidget(onAuthCallbackName = 'app.handleTelegramWidgetAuth') {
        const container = document.getElementById('telegram-login-widget-container');
        if (!container || container.dataset.rendered === '1') return;
        container.innerHTML = '';

        const script = document.createElement('script');
        script.async = true;
        script.src = 'https://telegram.org/js/telegram-widget.js?22';
        script.setAttribute('data-telegram-login', CONFIG.BOT_USERNAME);
        script.setAttribute('data-size', 'large');
        script.setAttribute('data-radius', '10');
        script.setAttribute('data-onauth', `${onAuthCallbackName}(user)`);
        script.setAttribute('data-request-access', 'write');

        container.appendChild(script);
        container.dataset.rendered = '1';
    }
};
