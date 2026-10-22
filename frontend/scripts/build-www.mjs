// scripts/build-www.mjs — Copia la web a www/ (webDir de Capacitor). Uso: npm run build:www
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'www');
const items = ['index.html', '404.html', 'privacy.html', 'terms.html', 'manifest.json', 'sw.js', 'tonconnect-manifest.json', 'css', 'js', 'assets'];

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
for (const item of items) {
  const src = join(root, item);
  if (!existsSync(src)) { console.warn('[build-www] omitido (no existe):', item); continue; }
  cpSync(src, join(out, item), { recursive: true });
}
console.log('[build-www] listo →', out);
