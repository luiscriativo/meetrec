#!/usr/bin/env node
/**
 * Gera a imagem de "social preview" do repositório (1280×640): é ela que aparece
 * quando alguém cola o link do GitHub no WhatsApp, Slack, Teams, Discord, X, LinkedIn…
 *
 * Uso (precisa do sharp: npm i -D sharp):
 *   node scripts/social-preview.js --icon assets/icon.png --name "MeetRec" \
 *     --tagline "Grave, transcreva e resuma reuniões" --from "#7C5CFF" --to "#FF5C7A" \
 *     [--chips "Windows,macOS,Linux"] [--screenshot docs/screenshots/home.png] \
 *     [--out docs/social-preview.png]
 *
 * Depois: GitHub → Settings → General → Social preview → Edit → Upload an image.
 * (O GitHub não aceita esse upload pela API; é um passo manual de 10 segundos.)
 */
'use strict';

const fs = require('fs');
const path = require('path');

const args = {};
for (let i = 2; i < process.argv.length; i += 2) args[process.argv[i].replace(/^--/, '')] = process.argv[i + 1];
const name = args.name || 'App';
const tagline = args.tagline || '';
const from = args.from || '#7C5CFF';
const to = args.to || '#FF5C7A';
const out = args.out || 'docs/social-preview.png';
const chips = (args.chips || 'Windows,macOS,Linux').split(',').map((s) => s.trim()).filter(Boolean);

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// Quebra a frase em até 2 linhas (~34 caracteres cada)
function wrap(text, max = 34) {
  const words = text.split(/\s+/); const lines = [''];
  for (const w of words) {
    const cur = lines[lines.length - 1];
    if ((cur + ' ' + w).trim().length > max && cur) lines.push(w); else lines[lines.length - 1] = (cur + ' ' + w).trim();
  }
  return lines.slice(0, 2);
}

(async () => {
  let sharp;
  try { sharp = require(path.resolve('node_modules/sharp')); } catch { sharp = require('sharp'); }
  const W = 1280, H = 640;
  const hasShot = args.screenshot && fs.existsSync(args.screenshot);
  const textX = 96;
  const lines = wrap(tagline, hasShot ? 26 : 38);
  let chipX = textX;
  const chipSvg = chips.map((c) => {
    const w = 26 + c.length * 13;
    const s = `<rect x="${chipX}" y="470" width="${w}" height="44" rx="22" fill="rgba(255,255,255,.16)"/><text x="${chipX + w / 2}" y="499" font-size="21" font-weight="600" fill="#fff" text-anchor="middle">${esc(c)}</text>`;
    chipX += w + 12;
    return s;
  }).join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
    <defs>
      <linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${from}"/><stop offset="1" stop-color="${to}"/></linearGradient>
      <radialGradient id="glow" cx="0.15" cy="0.1" r="0.8"><stop offset="0" stop-color="#fff" stop-opacity=".22"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient>
    </defs>
    <rect width="${W}" height="${H}" fill="url(#g)"/>
    <rect width="${W}" height="${H}" fill="url(#glow)"/>
    <g font-family="Segoe UI, Helvetica Neue, Arial, sans-serif">
      <text x="${textX + 136}" y="208" font-size="76" font-weight="800" fill="#fff" letter-spacing="-1.5">${esc(name)}</text>
      ${lines.map((l, i) => `<text x="${textX}" y="${318 + i * 54}" font-size="42" font-weight="500" fill="#fff" fill-opacity=".92">${esc(l)}</text>`).join('')}
      ${chipSvg}
    </g>
  </svg>`;

  const layers = [];
  if (args.icon && fs.existsSync(args.icon)) {
    const icon = await sharp(args.icon).resize(112, 112).png().toBuffer();
    layers.push({ input: icon, left: textX, top: 120 });
  }
  if (hasShot) {
    const sw = 560, sh = 380;
    const shot = await sharp(args.screenshot).resize(sw, sh, { fit: 'cover', position: 'top' }).png().toBuffer();
    const mask = Buffer.from(`<svg width="${sw}" height="${sh}"><rect width="${sw}" height="${sh}" rx="18" fill="#fff"/></svg>`);
    const rounded = await sharp(shot).composite([{ input: mask, blend: 'dest-in' }]).png().toBuffer();
    const shadow = Buffer.from(`<svg width="${sw + 60}" height="${sh + 60}"><rect x="30" y="38" width="${sw}" height="${sh}" rx="18" fill="#000" fill-opacity=".28"/></svg>`);
    const blurred = await sharp(shadow).blur(14).png().toBuffer();
    layers.push({ input: blurred, left: W - sw - 70 - 30, top: (H - sh) / 2 - 30 });
    layers.push({ input: rounded, left: W - sw - 70, top: (H - sh) / 2 });
  }

  fs.mkdirSync(path.dirname(out), { recursive: true });
  await sharp(Buffer.from(svg)).composite(layers).png({ compressionLevel: 9 }).toFile(out);
  console.log(`✓ Social preview gerado em ${out} (${W}×${H}).`);
  console.log('  Envie em: GitHub → Settings → General → Social preview → Edit → Upload an image.');
})().catch((e) => { console.error(e.message); process.exit(1); });
