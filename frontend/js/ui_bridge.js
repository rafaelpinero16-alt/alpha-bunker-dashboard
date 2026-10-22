/**
 * js/ui_bridge.js — Capa de UI nativa unificada (TMA ↔ Web/APK).
 *
 *   UI.alert(msg) / UI.confirm(msg)  → Telegram.WebApp.showAlert/showConfirm (≥6.2) o modal propio
 *   UI.form({...})                    → formulario modal; en Telegram usa MainButton como "enviar"
 *   UI.copy(text)                     → portapapeles con fallback
 *   Modales ↔ BackButton              → cualquier modal de app.js que se haga visible registra
 *                                       una entrada en AppBridge.navigation, así el BackButton de
 *                                       Telegram, el botón atrás de Android y el del navegador
 *                                       cierran el modal superior. No requiere tocar app.js.
 *
 * Depende de: hybrid_bridge.js (AppBridge). Cargar después de él.
 */
(function (global) {
  'use strict';
  const B = () => global.AppBridge;
  const doc = global.document;

  // ---------------------------------------------------------------- helpers DOM seguros
  function h(tag, attrs, children) {
    const el = doc.createElement(tag);
    Object.keys(attrs || {}).forEach((k) => {
      if (k === 'class') el.className = attrs[k];
      else if (k === 'text') el.textContent = attrs[k];
      else if (k.indexOf('on') === 0 && typeof attrs[k] === 'function') el.addEventListener(k.slice(2), attrs[k]);
      else if (attrs[k] !== undefined && attrs[k] !== null && attrs[k] !== false) el.setAttribute(k, attrs[k] === true ? '' : attrs[k]);
    });
    (children || []).forEach((c) => { if (c) el.appendChild(typeof c === 'string' ? doc.createTextNode(c) : c); });
    return el;
  }

  function tg() { return B() && B().telegram; }

  // ---------------------------------------------------------------- diálogos
  function overlay(content) {
    const wrap = h('div', { class: 'ab-overlay', id: 'modal-ab-dialog', role: 'dialog', 'aria-modal': 'true' }, [content]);
    doc.body.appendChild(wrap);
    return wrap;
  }

  function webDialog(message, buttons) {
    return new Promise((resolve) => {
      let box;
      const done = (v) => { box.remove(); resolve(v); };
      box = overlay(h('div', { class: 'ab-dialog' }, [
        h('p', { class: 'ab-dialog-msg', text: message }),
        h('div', { class: 'ab-dialog-actions' }, buttons.map((b) => h('button', { class: 'ab-btn ' + (b.primary ? 'ab-btn-primary' : ''), text: b.text, onclick: () => done(b.value) }))),
      ]));
      box._abClose = () => done(buttons[0].value === true ? false : buttons[0].value);
    });
  }

  const UI = {
    h,

    alert(message) {
      const T = tg();
      const msg = String(message || '').slice(0, 4096);
      if (T && B().tgAtLeast('6.2')) return new Promise((r) => T.showAlert(msg, () => r()));
      return webDialog(msg, [{ text: 'OK', value: undefined, primary: true }]);
    },

    confirm(message) {
      const T = tg();
      const msg = String(message || '').slice(0, 4096);
      if (T && B().tgAtLeast('6.2')) return new Promise((r) => T.showConfirm(msg, (ok) => r(!!ok)));
      return webDialog(msg, [{ text: 'Cancelar', value: false }, { text: 'Aceptar', value: true, primary: true }]);
    },

    /**
     * Formulario modal.
     * fields: [{ name, label, type: 'text'|'number'|'password'|'email'|'select', options:[{value,label}], value, required, min }]
     * Resuelve con un objeto {name: value} o null si se cancela.
     */
    form({ title, description, fields, submitText }) {
      return new Promise((resolve) => {
        const inputs = {};
        const rows = fields.map((f) => {
          let input;
          if (f.type === 'select') {
            input = h('select', { class: 'cyber-input ab-input', name: f.name }, (f.options || []).map((o) =>
              h('option', { value: o.value, selected: String(o.value) === String(f.value) ? true : null, text: o.label })));
          } else {
            input = h('input', { class: 'cyber-input ab-input', name: f.name, type: f.type || 'text', min: f.min, autocomplete: f.autocomplete || 'off', value: f.value != null ? String(f.value) : null, placeholder: f.placeholder || '' });
          }
          inputs[f.name] = input;
          return h('label', { class: 'ab-field' }, [h('span', { text: f.label }), input]);
        });
        const errorEl = h('p', { class: 'ab-form-error', text: '' });
        let closed = false;
        let box;
        const usedMain = { v: false };

        function finish(v) {
          if (closed) return;
          closed = true;
          if (usedMain.v) B().mainButton.hide();
          box.remove();
          resolve(v);
        }
        function submit() {
          const out = {};
          for (const f of fields) {
            const raw = inputs[f.name].value.trim();
            if (f.required && !raw) { errorEl.textContent = (f.label || f.name) + ': obligatorio'; B().haptic('error'); return; }
            out[f.name] = f.type === 'number' ? Number(raw) : raw;
          }
          B().haptic('medium');
          finish(out);
        }

        const submitBtn = h('button', { class: 'ab-btn ab-btn-primary', type: 'submit', text: submitText || 'Confirmar' });
        const formEl = h('form', { class: 'ab-dialog ab-form', onsubmit: (e) => { e.preventDefault(); submit(); } }, [
          title ? h('h3', { class: 'ab-dialog-title', text: title }) : null,
          description ? h('p', { class: 'ab-dialog-msg', text: description }) : null,
          ...rows,
          errorEl,
          h('div', { class: 'ab-dialog-actions' }, [h('button', { class: 'ab-btn', type: 'button', text: 'Cancelar', onclick: () => finish(null) }), submitBtn]),
        ]);
        box = overlay(formEl);
        box._abClose = () => finish(null);

        // En Telegram el envío va por el MainButton nativo (y se oculta el botón web).
        if (B().mainButton.show({ text: (submitText || 'CONFIRMAR').toUpperCase(), onClick: submit })) {
          usedMain.v = true;
          submitBtn.style.display = 'none';
        }
        const first = rows.length && inputs[fields[0].name];
        if (first) setTimeout(() => first.focus(), 50);
      });
    },

    async copy(text) {
      try { await global.navigator.clipboard.writeText(String(text)); return true; } catch (_) {}
      const ta = h('textarea', { style: 'position:fixed;opacity:0' });
      ta.value = String(text);
      doc.body.appendChild(ta);
      ta.select();
      let ok = false;
      try { ok = doc.execCommand('copy'); } catch (_) {}
      ta.remove();
      return ok;
    },

    /** Cierra todos los modales visibles (los de app.js y los propios). */
    closeTop,
  };

  // ---------------------------------------------------------------- modales ↔ navegación
  // Contenedores que cuentan como "capa" sobre el feed.
  const LAYER_SELECTOR = '[id^="modal-"], #media-lightbox-modal, #floating-video-bunker, #view-upload';
  const NAV_ID = 'ab-layer';
  let suppressNext = false;
  let scheduled = false;

  function isOpen(el) {
    if (el.classList.contains('hidden') || el.classList.contains('video-hidden')) return false;
    if (el.id === 'modal-ab-dialog') return true;
    return el.style.display !== 'none';
  }

  function openLayers() {
    return Array.prototype.filter.call(doc.querySelectorAll(LAYER_SELECTOR), isOpen);
  }

  function zOf(el) { const z = parseInt(global.getComputedStyle(el).zIndex, 10); return isNaN(z) ? 0 : z; }

  /** Cierra la capa visible más alta usando la acción propia de cada una. */
  function closeTop() {
    const layers = openLayers();
    if (!layers.length) return false;
    const top = layers.reduce((a, b) => (zOf(b) >= zOf(a) ? b : a));
    const app = global.app;
    if (top._abClose) { top._abClose(); return true; }
    switch (top.id) {
      case 'floating-video-bunker': if (app) app.toggleMinimizeVideo(); break;
      case 'media-lightbox-modal': if (app) app.closeLightbox(); else top.classList.add('hidden'); break;
      case 'view-upload': if (app) app.switchView('feed'); else top.classList.add('hidden'); break;
      case 'modal-chat':
        if (app && global.document.getElementById('dm-chat-view') && !global.document.getElementById('dm-chat-view').classList.contains('hidden')) app.backToInbox();
        else top.classList.add('hidden');
        break;
      default:
        // El socket de texto de la sala se mantiene si hay video activo en ella.
        if (top.id === 'modal-global-chat' && global.BunkerChat && !(global.RoomVideo && global.RoomVideo.isActive())) global.BunkerChat.leaveRoom();
        top.classList.add('hidden');
    }
    return true;
  }

  function onNavBack() {
    if (suppressNext) { suppressNext = false; return; }
    closeTop();
    schedule();  // si quedan capas abiertas, se vuelve a apilar una entrada
  }

  function reconcile() {
    scheduled = false;
    const nav = B() && B().navigation;
    if (!nav) return;
    const anyOpen = openLayers().length > 0;
    const hasEntry = nav.current() === NAV_ID;
    if (anyOpen && !hasEntry) nav.push(NAV_ID, onNavBack);
    else if (!anyOpen && hasEntry) { suppressNext = true; nav.back(); }
  }

  // Diferido: app.js hace closeModals() y abre otro modal en el mismo tick.
  function schedule() { if (!scheduled) { scheduled = true; setTimeout(reconcile, 0); } }

  function startObserver() {
    const mo = new global.MutationObserver((mutations) => {
      for (const m of mutations) {
        const t = m.target;
        if (m.type === 'attributes' && t.matches && t.matches(LAYER_SELECTOR)) { schedule(); return; }
        if (m.type === 'childList') {
          for (const n of m.addedNodes) if (n.nodeType === 1 && (n.matches(LAYER_SELECTOR) || n.querySelector(LAYER_SELECTOR))) { schedule(); return; }
          for (const n of m.removedNodes) if (n.nodeType === 1 && n.id === 'modal-ab-dialog') { schedule(); return; }
        }
      }
    });
    mo.observe(doc.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['class', 'style'] });
  }

  // Escape en escritorio = atrás.
  doc.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !openLayers().length) return;
    e.preventDefault();
    if (B().navigation.current() === NAV_ID) global.history.back(); else { closeTop(); schedule(); }
  });

  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', startObserver);
  else startObserver();

  global.UI = UI;
})(window);
