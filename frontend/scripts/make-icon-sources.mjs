// scripts/make-icon-sources.mjs — Genera las imágenes fuente que necesita @capacitor/assets
// a partir del logo de la app.  Uso:  npm run assets:sources -- assets/logo.png
//
// Salida en resources/ (no en assets/, que es la carpeta de imágenes de la web):
//   icon-only.png        1024×1024  icono completo (Android < 8 y fallback)
//   icon-foreground.png  1024×1024  logo dentro de la zona segura (66 %) sobre transparente
//   icon-background.png  1024×1024  fondo sólido de la marca
//   splash.png           2732×2732  logo centrado sobre fondo de marca
//   splash-dark.png      2732×2732  ídem para modo oscuro
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = resolve(root, process.argv[2] || 'assets/logo.png');
const out = join(root, 'resources');
const BG = '#050505';
const TRANSPARENT = { r: 0, g: 0, b: 0, alpha: 0 };

if (!existsSync(src)) {
  console.error('[assets] No existe la imagen origen:', src);
  console.error('[assets] Uso: npm run assets:sources -- ruta/al/logo.png  (PNG o JPG, idealmente ≥ 1024 px)');
  process.exit(1);
}
mkdirSync(out, { recursive: true });

async function canvas(size, background, logoPx) {
  const logo = await sharp(src).resize(logoPx, logoPx, { fit: 'contain', background: TRANSPARENT }).png().toBuffer();
  return sharp({ create: { width: size, height: size, channels: 4, background } })
    .composite([{ input: logo, gravity: 'centre' }])
    .png();
}

try {
  await sharp(src).resize(1024, 1024, { fit: 'cover' }).flatten({ background: BG }).png().toFile(join(out, 'icon-only.png'));
  await (await canvas(1024, TRANSPARENT, 660)).toFile(join(out, 'icon-foreground.png'));
  await sharp({ create: { width: 1024, height: 1024, channels: 4, background: BG } }).png().toFile(join(out, 'icon-background.png'));
  await (await canvas(2732, BG, 900)).toFile(join(out, 'splash.png'));
  await (await canvas(2732, BG, 900)).toFile(join(out, 'splash-dark.png'));
  console.log('[assets] Fuentes generadas en', out);
  console.log('[assets] Siguiente paso: npm run assets:android');
} catch (e) {
  console.error('[assets] Error generando las imágenes:', e);
  process.exit(1);
}
