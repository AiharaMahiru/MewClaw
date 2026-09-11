/** 从品牌插件的 FAVICON_SVG 生成桌面用 SVG 与多尺寸 Windows ICO。 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const sizes = [16, 20, 24, 28, 30, 32, 36, 40, 48, 60, 64, 72, 80, 96, 128, 256];
const candidateRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const brandSource = resolve(candidateRoot, 'mewclaw-brand/src/index.ts');
const brandBuild = resolve(candidateRoot, 'mewclaw-brand/build');
const svgOutput = resolve(brandBuild, 'favicon.svg');
const icoOutput = resolve(brandBuild, 'app-icon.ico');

function extractSvg(source) {
  const match = source.match(/export const FAVICON_SVG = `([\s\S]*?)`;/u);
  if (!match) throw new Error('MewClaw icon: FAVICON_SVG was not found');
  return match[1]
    .replaceAll('var(--bg)', '#ffffff')
    .replaceAll('var(--ink)', '#181717');
}

function encodeDib(rgba, size) {
  const xorBytes = size * size * 4;
  const maskRowBytes = Math.ceil(size / 32) * 4;
  const dib = Buffer.alloc(40 + xorBytes + maskRowBytes * size);
  dib.writeUInt32LE(40, 0);
  dib.writeInt32LE(size, 4);
  dib.writeInt32LE(size * 2, 8);
  dib.writeUInt16LE(1, 12);
  dib.writeUInt16LE(32, 14);
  dib.writeUInt32LE(xorBytes, 20);
  const pixelsOffset = 40;
  const maskOffset = pixelsOffset + xorBytes;
  for (let y = 0; y < size; y += 1) {
    const sourceRow = y * size * 4;
    const destinationRow = pixelsOffset + (size - y - 1) * size * 4;
    const destinationMaskRow = maskOffset + (size - y - 1) * maskRowBytes;
    for (let x = 0; x < size; x += 1) {
      const source = sourceRow + x * 4;
      const destination = destinationRow + x * 4;
      dib[destination] = rgba[source + 2];
      dib[destination + 1] = rgba[source + 1];
      dib[destination + 2] = rgba[source];
      dib[destination + 3] = rgba[source + 3];
      if (rgba[source + 3] === 0) dib[destinationMaskRow + Math.floor(x / 8)] |= 0x80 >> (x % 8);
    }
  }
  return dib;
}

function encodeIco(frames) {
  const header = Buffer.alloc(6 + frames.length * 16);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(frames.length, 4);
  let offset = header.length;
  for (const [index, frame] of frames.entries()) {
    const entry = 6 + index * 16;
    header[entry] = frame.size === 256 ? 0 : frame.size;
    header[entry + 1] = frame.size === 256 ? 0 : frame.size;
    header.writeUInt16LE(1, entry + 4);
    header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(frame.data.length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    offset += frame.data.length;
  }
  return Buffer.concat([header, ...frames.map(frame => frame.data)]);
}

const source = await readFile(brandSource, 'utf8');
const svg = extractSvg(source);
await mkdir(brandBuild, { recursive: true });
await writeFile(svgOutput, `${svg}\n`);

const frames = await Promise.all(sizes.map(async size => {
  const pipeline = sharp(Buffer.from(svg), { density: 300, failOn: 'warning' })
    .resize(size, size, { fit: 'fill', kernel: sharp.kernel.lanczos3 })
    .toColourspace('srgb')
    .ensureAlpha();
  const [{ data, info }, png] = await Promise.all([
    pipeline.clone().raw({ depth: 'uchar' }).toBuffer({ resolveWithObject: true }),
    pipeline.clone().png({ compressionLevel: 9, progressive: false, palette: false }).toBuffer(),
  ]);
  if (info.width !== size || info.height !== size || info.channels !== 4) {
    throw new Error(`MewClaw icon: invalid ${size}x${size} RGBA frame`);
  }
  return { size, data: size === 256 ? png : encodeDib(data, size) };
}));

await writeFile(icoOutput, encodeIco(frames));
console.log(`MewClaw brand icon generated: ${svgOutput} and ${icoOutput}`);
