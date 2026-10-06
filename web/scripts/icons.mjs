// Renders the app icons in public/ from the SVG masters in design/. Run via scripts/icons.sh.
// Outputs are committed, so builds never need this. Renderer: @resvg/resvg-js (MPL-2.0, devDependency).
import { Resvg } from '@resvg/resvg-js';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const web = fileURLToPath(new URL('..', import.meta.url));
const src = (name) => `${web}design/${name}`;
const out = (name) => `${web}public/${name}`;

/** Icons are served from our origin and shown everywhere: plain shapes only, nothing that loads or runs. */
const FORBIDDEN = [
  /<script/i,
  /<foreignObject/i,
  /<image/i,
  /<style/i,
  /\son[a-z]+\s*=/i,
  /href\s*=\s*["'](?!#)/i,
  /url\(\s*(?!#)/i,
  /@import/i,
];

function load(name) {
  const svg = readFileSync(src(name), 'utf8');
  const bad = FORBIDDEN.find((re) => re.test(svg));
  if (bad) throw new Error(`${name}: forbidden SVG content (${bad}) — icons must be static shapes only`);
  return svg;
}

const png = (svg, size) => new Resvg(svg, { fitTo: { mode: 'width', value: size } }).render().asPng();

/** ICO container holding PNG images (supported by every browser that still asks for favicon.ico). */
function ico(images) {
  const header = Buffer.alloc(6 + 16 * images.length);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(images.length, 4);
  let offset = header.length;
  images.forEach(({ size, data }, i) => {
    const e = 6 + 16 * i;
    header.writeUInt8(size >= 256 ? 0 : size, e); // width
    header.writeUInt8(size >= 256 ? 0 : size, e + 1); // height
    header.writeUInt16LE(1, e + 4); // colour planes
    header.writeUInt16LE(32, e + 6); // bits per pixel
    header.writeUInt32LE(data.length, e + 8);
    header.writeUInt32LE(offset, e + 12);
    offset += data.length;
  });
  return Buffer.concat([header, ...images.map((i) => i.data)]);
}

const full = load('logo.svg');
const small = load('logo-small.svg');
// iOS applies its own rounded mask to home-screen icons, so give it the full-bleed artwork (no tile clip).
const fullBleed = full.replace(' clip-path="url(#tile)"', '');

const outputs = {
  'logo.svg': Buffer.from(full),
  'favicon.svg': Buffer.from(small),
  'favicon.ico': ico([16, 32, 48].map((size) => ({ size, data: png(small, size) }))),
  'apple-touch-icon.png': png(fullBleed, 180),
};
for (const [name, data] of Object.entries(outputs)) writeFileSync(out(name), data);

// Browsers and Cloudflare cache icons by URL (favicons especially stubbornly): reference them with a content hash
// so a changed logo is always fetched fresh.
const version = (name) => createHash('sha256').update(outputs[name]).digest('hex').slice(0, 10);
const REFERENCES = ['src/index.html', 'src/app/features/home/home.html'];
for (const file of REFERENCES) {
  const path = `${web}${file}`;
  const html = readFileSync(path, 'utf8').replace(
    /\b(logo\.svg|favicon\.svg|favicon\.ico|apple-touch-icon\.png)(\?v=[0-9a-f]+)?(?=")/g,
    (_, name) => `${name}?v=${version(name)}`,
  );
  writeFileSync(path, html);
}
console.log('icons: logo.svg, favicon.svg, favicon.ico (16/32/48), apple-touch-icon.png (180); versioned links updated');
