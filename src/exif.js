import { randomUUID } from 'node:crypto';

// Cabecera TIFF mínima de 22 bytes utilizada por WhatsApp (tag 0x5741).
// Los bytes 14..17 guardan la longitud uint32 LE del JSON UTF-8.
const WA_EXIF_HEADER = Buffer.from([
  0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00,
  0x01, 0x00, 0x41, 0x57, 0x07, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x16, 0x00, 0x00, 0x00,
]);

const VP8X_EXIF_FLAG = 0x08;
const VP8X_ALPHA_FLAG = 0x10;
const VP8X_ANIM_FLAG = 0x02;

/**
 * Construye el payload EXIF con metadatos de paquete y autor compatible con WhatsApp.
 */
export function buildStickerExif({
  pack = 'Made by',
  author = '@Lyan',
  packId = randomUUID(),
  emojis = ['🔊'],
} = {}) {
  const metadata = {
    'sticker-pack-id': packId,
    'sticker-pack-name': pack,
    'sticker-pack-publisher': author,
    emojis,
  };
  const jsonBuf = Buffer.from(JSON.stringify(metadata), 'utf8');
  const header = Buffer.from(WA_EXIF_HEADER);
  header.writeUInt32LE(jsonBuf.length, 14);
  return Buffer.concat([header, jsonBuf]);
}

function buildRiffChunk(fourcc, payload) {
  const header = Buffer.alloc(8);
  header.write(fourcc, 0, 4, 'ascii');
  header.writeUInt32LE(payload.length, 4);
  const pad = payload.length % 2 === 1 ? Buffer.from([0x00]) : Buffer.alloc(0);
  return Buffer.concat([header, payload, pad]);
}

function buildVp8xChunk({ width, height, hasAlpha = false, hasAnim = false, hasExif = true }) {
  const payload = Buffer.alloc(10);
  let flags = 0;
  if (hasExif) flags |= VP8X_EXIF_FLAG;
  if (hasAlpha) flags |= VP8X_ALPHA_FLAG;
  if (hasAnim) flags |= VP8X_ANIM_FLAG;
  payload[0] = flags;
  const w = Math.max(1, width) - 1;
  const h = Math.max(1, height) - 1;
  payload.writeUIntLE(w, 4, 3);
  payload.writeUIntLE(h, 7, 3);
  return buildRiffChunk('VP8X', payload);
}

/**
 * Inspecciona los chunks RIFF/WEBP de un buffer WebP (dimensiones, animación y duración).
 */
export function inspectWebp(webpBuf) {
  if (
    !Buffer.isBuffer(webpBuf) ||
    webpBuf.length < 12 ||
    webpBuf.toString('ascii', 0, 4) !== 'RIFF' ||
    webpBuf.toString('ascii', 8, 12) !== 'WEBP'
  ) {
    throw new Error('Buffer WebP inválido: falta cabecera RIFF/WEBP.');
  }

  let offset = 12;
  let width = 0;
  let height = 0;
  let animated = false;
  let frames = 0;
  let durationMs = 0;
  let firstFrameLength = null;

  while (offset + 8 <= webpBuf.length) {
    const fourcc = webpBuf.toString('ascii', offset, offset + 4);
    const size = webpBuf.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (body + size > webpBuf.length) {
      throw new Error(`Chunk WebP truncado ("${fourcc}") en offset ${offset}.`);
    }
    const nextOffset = body + size + (size % 2);

    if (fourcc === 'VP8X') {
      if (size < 10) throw new Error('Chunk VP8X malformado.');
      animated = (webpBuf[body] & VP8X_ANIM_FLAG) !== 0;
      width = webpBuf.readUIntLE(body + 4, 3) + 1;
      height = webpBuf.readUIntLE(body + 7, 3) + 1;
    } else if (fourcc === 'ANMF') {
      frames++;
      if (firstFrameLength === null) {
        firstFrameLength = nextOffset;
      }
      if (size >= 15) {
        durationMs += webpBuf.readUIntLE(body + 12, 3);
      }
    } else if ((fourcc === 'VP8 ' || fourcc === 'VP8L') && !width) {
      if (fourcc === 'VP8L' && size >= 5) {
        const bits = webpBuf.readUInt32LE(body + 1);
        width = (bits & 0x3fff) + 1;
        height = ((bits >> 14) & 0x3fff) + 1;
      } else if (fourcc === 'VP8 ' && size >= 10) {
        width = webpBuf.readUInt16LE(body + 6) & 0x3fff;
        height = webpBuf.readUInt16LE(body + 8) & 0x3fff;
      }
      frames = 1;
    }

    offset = nextOffset;
  }

  if (!animated && frames === 0) frames = 1;
  return { width, height, animated, frames, durationMs, firstFrameLength };
}

/**
 * Inyecta o reemplaza el bloque EXIF en un archivo WebP sin requerir webpmux ni Python.
 */
export function injectWebpExif(webpBuf, exifPayload, { width = 512, height = 512 } = {}) {
  const info = inspectWebp(webpBuf);
  const finalWidth = info.width || width;
  const finalHeight = info.height || height;

  const chunks = [];
  let hasVp8x = false;
  let hasAlpha = false;
  let hasAnim = false;
  let offset = 12;

  while (offset + 8 <= webpBuf.length) {
    const fourcc = webpBuf.toString('ascii', offset, offset + 4);
    const size = webpBuf.readUInt32LE(offset + 4);
    const dataStart = offset + 8;
    const dataEnd = dataStart + size;
    const paddedEnd = dataEnd + (size % 2);

    if (fourcc !== 'EXIF') {
      const payload = Buffer.from(webpBuf.subarray(dataStart, dataEnd));
      if (fourcc === 'VP8X') {
        payload[0] |= VP8X_EXIF_FLAG;
        hasVp8x = true;
      } else if (fourcc === 'ALPH' || fourcc === 'VP8L') {
        hasAlpha = true;
      } else if (fourcc === 'ANIM') {
        hasAnim = true;
      }
      chunks.push(buildRiffChunk(fourcc, payload));
    }

    offset = paddedEnd;
  }

  if (!hasVp8x) {
    chunks.unshift(
      buildVp8xChunk({
        width: finalWidth,
        height: finalHeight,
        hasAlpha,
        hasAnim,
        hasExif: true,
      })
    );
  }

  chunks.push(buildRiffChunk('EXIF', exifPayload));

  const body = Buffer.concat(chunks);
  const riffHeader = Buffer.alloc(12);
  riffHeader.write('RIFF', 0, 4, 'ascii');
  riffHeader.writeUInt32LE(4 + body.length, 4);
  riffHeader.write('WEBP', 8, 4, 'ascii');

  return Buffer.concat([riffHeader, body]);
}

/**
 * Lee los metadatos JSON inyectados en el EXIF del WebP (útil para tests).
 */
export function readWebpExif(webpBuf) {
  const idx = webpBuf.indexOf('EXIF', 12, 'ascii');
  if (idx < 0) return null;
  const size = webpBuf.readUInt32LE(idx + 4);
  const payload = webpBuf.subarray(idx + 8, idx + 8 + size);
  if (payload.length < 22) return null;
  const jsonLen = payload.readUInt32LE(14);
  return JSON.parse(payload.subarray(22, 22 + jsonLen).toString('utf8'));
}
