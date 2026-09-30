#!/usr/bin/env node
// Empacota a pasta extension/ num .zip pronto para a Chrome Web Store ou distribuição interna.
// Uso: node scripts/pack-extension.js
// Saída: extension-vX.Y.Z.zip na raiz do projeto.
// Requer Node.js 20+ (fs.cp, ReadableStream via node:stream/web). Sem dependências extras.

import { createWriteStream, readFileSync } from 'node:fs';
import { mkdir, readdir, rm, cp } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const ROOT = resolve(__dirname, '..');
const EXT_DIR = join(ROOT, 'extension');
const TMP = join(ROOT, '.pack-tmp');

// Lê a versão do manifest
const manifest = JSON.parse(readFileSync(join(EXT_DIR, 'manifest.json'), 'utf8'));
const version = manifest.version;
const outFile = join(ROOT, `extension-v${version}.zip`);

// Padrões a excluir
const EXCLUDE = [
  '.DS_Store',
  'Thumbs.db',
  '.gitignore',
  '*.map',
  'test',
  'tests',
  '__tests__',
  '*.test.js',
  '*.spec.js',
];

function isExcluded(name) {
  if (EXCLUDE.includes(name)) return true;
  if (name.startsWith('.')) return true;
  for (const p of EXCLUDE) {
    if (p.startsWith('*') && name.endsWith(p.slice(1))) return true;
  }
  return false;
}

async function collectFiles(dir, base = dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const e of entries) {
    if (isExcluded(e.name)) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      files.push(...await collectFiles(full, base));
    } else {
      files.push({ abs: full, rel: relative(base, full).replace(/\\/g, '/') });
    }
  }
  return files;
}

// Escrita ZIP mínima (sem dependências externas).
// Formato: ZIP local file headers + central directory + end of central directory.
function dosDateTime(d) {
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  return { date, time };
}

function crc32(buf) {
  const table = crc32.table || (crc32.table = (() => {
    const t = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let j = 0; j < 8; j++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[i] = c;
    }
    return t;
  })());
  let crc = 0xFFFFFFFF;
  for (const byte of buf) crc = table[(crc ^ byte) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function writeU16LE(buf, off, v) { buf.writeUInt16LE(v >>> 0, off); }
function writeU32LE(buf, off, v) { buf.writeUInt32LE(v >>> 0, off); }

function localFileHeader(nameBytes, content, crc, dt) {
  const hdr = Buffer.alloc(30 + nameBytes.length);
  writeU32LE(hdr, 0, 0x04034B50);  // signature
  writeU16LE(hdr, 4, 20);          // version needed
  writeU16LE(hdr, 6, 0);           // flags
  writeU16LE(hdr, 8, 0);           // compression: stored
  writeU16LE(hdr, 10, dt.time);
  writeU16LE(hdr, 12, dt.date);
  writeU32LE(hdr, 14, crc);
  writeU32LE(hdr, 18, content.length);  // compressed
  writeU32LE(hdr, 22, content.length);  // uncompressed
  writeU16LE(hdr, 26, nameBytes.length);
  writeU16LE(hdr, 28, 0);          // extra length
  nameBytes.copy(hdr, 30);
  return hdr;
}

function centralDirEntry(nameBytes, crc, size, offset, dt) {
  const e = Buffer.alloc(46 + nameBytes.length);
  writeU32LE(e, 0, 0x02014B50);   // signature
  writeU16LE(e, 4, 20);           // version made by
  writeU16LE(e, 6, 20);           // version needed
  writeU16LE(e, 8, 0);            // flags
  writeU16LE(e, 10, 0);           // stored
  writeU16LE(e, 12, dt.time);
  writeU16LE(e, 14, dt.date);
  writeU32LE(e, 16, crc);
  writeU32LE(e, 20, size);
  writeU32LE(e, 24, size);
  writeU16LE(e, 28, nameBytes.length);
  writeU16LE(e, 30, 0);           // extra
  writeU16LE(e, 32, 0);           // comment
  writeU16LE(e, 34, 0);           // disk
  writeU16LE(e, 36, 0);           // internal attr
  writeU32LE(e, 38, 0);           // external attr
  writeU32LE(e, 42, offset);      // relative offset
  nameBytes.copy(e, 46);
  return e;
}

function endOfCentralDir(count, cdSize, cdOffset) {
  const e = Buffer.alloc(22);
  writeU32LE(e, 0, 0x06054B50);
  writeU16LE(e, 4, 0); writeU16LE(e, 6, 0);
  writeU16LE(e, 8, count); writeU16LE(e, 10, count);
  writeU32LE(e, 12, cdSize);
  writeU32LE(e, 16, cdOffset);
  writeU16LE(e, 20, 0);
  return e;
}

async function buildZip(files, dest) {
  const now = new Date();
  const dt = dosDateTime(now);
  const ws = createWriteStream(dest);
  const write = (buf) => new Promise((ok, err) => ws.write(buf, (e) => e ? err(e) : ok()));

  let offset = 0;
  const entries = [];

  for (const { abs, rel } of files) {
    const content = readFileSync(abs);
    const nameBytes = Buffer.from(rel, 'utf8');
    const crc = crc32(content);
    const hdr = localFileHeader(nameBytes, content, crc, dt);
    const localOffset = offset;
    await write(hdr);
    await write(content);
    offset += hdr.length + content.length;
    entries.push({ nameBytes, crc, size: content.length, offset: localOffset });
  }

  const cdStart = offset;
  let cdSize = 0;
  for (const e of entries) {
    const cd = centralDirEntry(e.nameBytes, e.crc, e.size, e.offset, dt);
    await write(cd);
    cdSize += cd.length;
  }

  await write(endOfCentralDir(entries.length, cdSize, cdStart));
  await new Promise((ok, err) => ws.end((e) => e ? err(e) : ok()));
}

// ─── main ───────────────────────────────────────────────────────────────────

console.log(`Empacotando extensão v${version}…`);

await rm(TMP, { recursive: true, force: true });
await mkdir(TMP, { recursive: true });

const files = await collectFiles(EXT_DIR);
console.log(`  ${files.length} arquivo(s) encontrado(s).`);

await buildZip(files, outFile);

await rm(TMP, { recursive: true, force: true });

// Checksum SHA-256 para auditoria
const zip = readFileSync(outFile);
const sha = createHash('sha256').update(zip).digest('hex');
const kb = (zip.length / 1024).toFixed(1);

console.log(`\n✓ Gerado: ${outFile}`);
console.log(`  Tamanho: ${kb} KB`);
console.log(`  SHA-256: ${sha}`);
console.log(`\nPróximo passo: faça upload em chrome.google.com/webstore/devconsole`);
