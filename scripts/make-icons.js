'use strict';

/**
 * 图标生成脚本：用 sharp 渲染 favicon.svg（黑色），
 * 产出 build/icon.png（512x512）与 build/icon.ico（16~256 多尺寸）。
 * 用法：node scripts/make-icons.js
 */

const sharp = require('sharp');
const path = require('node:path');
const fs = require('node:fs');

const BUILD = path.join(__dirname, '..', 'build');
const SVG_PATH = path.join(BUILD, 'favicon.svg');

async function main() {
  // 读取 SVG：固定黑色（去掉深浅色媒体查询），放大到 512x512 渲染
  let svg = fs.readFileSync(SVG_PATH, 'utf8');
  svg = svg.replace(/@media[^}]+\{[^}]*\}/g, '');
  svg = svg.replace(/width="50" height="50"/, 'width="512" height="512"');
  const svgBuffer = Buffer.from(svg);

  // 512x512 PNG
  await sharp(svgBuffer, { density: 96 }).png().toFile(path.join(BUILD, 'icon.png'));
  console.log('OK icon.png (512x512)');

  // 多尺寸 PNG → 打包进 ICO（内嵌 PNG 条目，Vista+ 支持）
  const sizes = [256, 128, 64, 48, 32, 16];
  const entries = [];
  const pngs = [];
  let offset = 6 + sizes.length * 16;
  for (const s of sizes) {
    const png = await sharp(svgBuffer, { density: 96 }).resize(s, s).png().toBuffer();
    entries.push({ w: s === 256 ? 0 : s, h: s === 256 ? 0 : s, size: png.length, offset });
    pngs.push(png);
    offset += png.length;
  }

  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type = icon
  header.writeUInt16LE(sizes.length, 4); // count

  const chunks = [header];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const ent = Buffer.alloc(16);
    ent.writeUInt8(e.w, 0);
    ent.writeUInt8(e.h, 1);
    ent.writeUInt8(0, 2); // color count
    ent.writeUInt8(0, 3); // reserved
    ent.writeUInt16LE(1, 4); // planes
    ent.writeUInt16LE(32, 6); // bit count
    ent.writeUInt32LE(e.size, 8);
    ent.writeUInt32LE(e.offset, 12);
    chunks.push(ent);
  }
  chunks.push(...pngs);
  fs.writeFileSync(path.join(BUILD, 'icon.ico'), Buffer.concat(chunks));
  console.log('OK icon.ico (sizes: ' + sizes.join(',') + ')');
}

main().catch((err) => {
  console.error('FAIL', err);
  process.exit(1);
});
