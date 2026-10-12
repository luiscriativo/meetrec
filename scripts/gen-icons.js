// Gera os ícones PNG do app e da bandeja a partir de SVG (rode: npm run icons)
const sharp = require('sharp');
const path = require('path');
const out = (f) => path.join(__dirname, '..', 'assets', f);

const appIcon = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#7C5CFF"/><stop offset="1" stop-color="#FF5C7A"/>
    </linearGradient>
  </defs>
  <rect x="16" y="16" width="480" height="480" rx="120" fill="url(#g)"/>
  <g fill="#fff">
    <rect x="118" y="206" width="36" height="100" rx="18"/>
    <rect x="182" y="156" width="36" height="200" rx="18"/>
    <rect x="246" y="116" width="36" height="280" rx="18"/>
    <rect x="310" y="176" width="36" height="160" rx="18"/>
    <rect x="374" y="226" width="20" height="60" rx="10" opacity=".8"/>
  </g>
</svg>`;

const trayIcon = (bg, inner) => `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <circle cx="32" cy="32" r="30" fill="${bg}"/>${inner}
</svg>`;
const bars = `<g fill="#fff"><rect x="15" y="26" width="6" height="12" rx="3"/><rect x="24" y="19" width="6" height="26" rx="3"/><rect x="33" y="14" width="6" height="36" rx="3"/><rect x="42" y="22" width="6" height="20" rx="3"/></g>`;
const dot = `<circle cx="32" cy="32" r="13" fill="#fff"/>`;
const dots = `<g fill="#fff"><circle cx="19" cy="32" r="5"/><circle cx="32" cy="32" r="5"/><circle cx="45" cy="32" r="5"/></g>`;
const pause = `<g fill="#fff"><rect x="21" y="18" width="8" height="28" rx="3"/><rect x="35" y="18" width="8" height="28" rx="3"/></g>`;

(async () => {
  await sharp(Buffer.from(appIcon)).resize(1024, 1024).png().toFile(out('icon.png'));
  await sharp(Buffer.from(appIcon)).resize(256, 256).png().toFile(out('icon-256.png'));
  const trays = {
    'tray-idle': trayIcon('#7C5CFF', bars),
    'tray-recording': trayIcon('#F0384F', dot),
    'tray-paused': trayIcon('#F59E0B', pause),
    'tray-processing': trayIcon('#3B82F6', dots),
  };
  for (const [name, svg] of Object.entries(trays)) {
    await sharp(Buffer.from(svg)).resize(16, 16).png().toFile(out(`${name}.png`));
    await sharp(Buffer.from(svg)).resize(32, 32).png().toFile(out(`${name}@2x.png`));
  }
  console.log('Ícones gerados em assets/');
})();

// Ícones da extensão do navegador
(async () => {
  for (const s of [16, 32, 48, 128]) {
    await sharp(Buffer.from(appIcon)).resize(s, s).png().toFile(path.join(__dirname, '..', 'extension', 'icons', `icon${s}.png`));
  }
})();
