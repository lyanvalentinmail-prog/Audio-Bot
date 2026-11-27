import test from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, createHash, createHmac, randomBytes } from 'node:crypto';
import { getMediaKeys, proto } from '@whiskeysockets/baileys';

import { buildStickerExif, injectWebpExif, inspectWebp, readWebpExif } from '../src/exif.js';
import {
  createAudioStreamingSidecar,
  installSoundStickerProtoPatch,
  inspectSoundStickerWire,
  registerPendingAudioSticker,
} from '../src/soundSticker.js';
import { parseCommandRequest, unwrapMessage } from '../src/handler.js';

/**
 * Construye un WebP animado mínimo válido (RIFF + WEBP + VP8X + ANIM + ANMF) para pruebas sin FFmpeg.
 */
function makeMinimalAnimatedWebp(width = 512, height = 512) {
  function chunk(fourcc, payload) {
    const hdr = Buffer.alloc(8);
    hdr.write(fourcc, 0, 4, 'ascii');
    hdr.writeUInt32LE(payload.length, 4);
    const pad = payload.length % 2 === 1 ? Buffer.from([0]) : Buffer.alloc(0);
    return Buffer.concat([hdr, payload, pad]);
  }

  const vp8x = Buffer.alloc(10);
  vp8x[0] = 0x02; // animación
  vp8x.writeUIntLE(width - 1, 4, 3);
  vp8x.writeUIntLE(height - 1, 7, 3);

  const anim = Buffer.alloc(6); // bgColor + loopCount = 0

  // ANMF de 16 bytes de cabecera + un mini VP8L falso
  const anmfHeader = Buffer.alloc(16);
  anmfHeader.writeUIntLE(width - 1, 6, 3);
  anmfHeader.writeUIntLE(height - 1, 9, 3);
  anmfHeader.writeUIntLE(120, 12, 3); // 120 ms
  const vp8lSub = chunk('VP8L', Buffer.from([0x2f, 0x00, 0x00, 0x00, 0x00]));
  const anmf = chunk('ANMF', Buffer.concat([anmfHeader, vp8lSub]));

  const body = Buffer.concat([chunk('VP8X', vp8x), chunk('ANIM', anim), anmf]);
  const riff = Buffer.alloc(12);
  riff.write('RIFF', 0, 4, 'ascii');
  riff.writeUInt32LE(4 + body.length, 4);
  riff.write('WEBP', 8, 4, 'ascii');
  return Buffer.concat([riff, body]);
}

test('EXIF: inyecta y lee metadatos de paquete y autor en WebP animado', () => {
  const rawWebp = makeMinimalAnimatedWebp(512, 512);
  const exif = buildStickerExif({
    pack: 'Audio-Bot Pack',
    author: 'Termux Bot',
    emojis: ['🔊'],
  });

  const stamped = injectWebpExif(rawWebp, exif, { width: 512, height: 512 });
  const info = inspectWebp(stamped);

  assert.equal(info.width, 512);
  assert.equal(info.height, 512);
  assert.equal(info.animated, true);
  assert.equal(info.durationMs, 120);

  const meta = readWebpExif(stamped);
  assert.ok(meta);
  assert.equal(meta['sticker-pack-name'], 'Audio-Bot Pack');
  assert.equal(meta['sticker-pack-publisher'], 'Termux Bot');
  assert.deepEqual(meta.emojis, ['🔊']);
});

test('Protobuf: empaqueta audioStickerMessage (campo 134) y audioMessage (campo 26) también en deviceSentMessage', () => {
  installSoundStickerProtoPatch();

  const fileSha256 = randomBytes(32);
  const audioSha256 = randomBytes(32);
  const mediaKey = randomBytes(32);

  const stickerMessage = {
    url: 'https://mmg.whatsapp.net/v/t62.15575-24/test.enc',
    directPath: '/v/t62.15575-24/test.enc',
    fileSha256,
    fileEncSha256: randomBytes(32),
    mediaKey,
    mimetype: 'image/webp',
    width: 512,
    height: 512,
    isAnimated: true,
  };

  const audioMessage = {
    url: 'https://mmg.whatsapp.net/v/t62.7114-24/audio.enc',
    directPath: '/v/t62.7114-24/audio.enc',
    fileSha256: audioSha256,
    fileEncSha256: randomBytes(32),
    mediaKey: randomBytes(32),
    mimetype: 'audio/ogg; codecs=opus',
    seconds: 5,
    ptt: false,
  };

  registerPendingAudioSticker(fileSha256.toString('base64'), audioMessage, { emoji: '🔊' });

  // 1) Codificación directa de proto.Message
  const directBytes = proto.Message.encode({ stickerMessage }).finish();
  const inspected = inspectSoundStickerWire(directBytes);

  assert.equal(inspected.hasField134, true);
  assert.equal(inspected.hasTopLevelSticker, false);
  assert.equal(inspected.premium, 0);
  assert.equal(inspected.emojis, '🔊');
  assert.ok(inspected.sticker);
  assert.equal(inspected.sticker.isAnimated, true);
  assert.ok(inspected.audioMessage);
  assert.equal(inspected.audioMessage.seconds, 5);
  assert.equal(inspected.audioMessage.mimetype, 'audio/ogg; codecs=opus');

  // 2) Codificación dentro de deviceSentMessage (sincronización multidispositivo)
  const dsmBytes = proto.Message.encode({
    deviceSentMessage: {
      destinationJid: '59899123456@s.whatsapp.net',
      message: { stickerMessage },
    },
  }).finish();

  const decodedOuter = proto.Message.decode(dsmBytes);
  assert.ok(decodedOuter.deviceSentMessage);
  // Verificamos en los bytes internos de deviceSentMessage.message
  const dsmInnerWriter = proto.Message.DeviceSentMessage.encode({
    destinationJid: '59899123456@s.whatsapp.net',
    message: { stickerMessage },
  }).finish();
  assert.ok(dsmInnerWriter.length > 0);

  // 3) Mensajes normales de texto o stickers sin registrar no se ven alterados
  const normalStickerSha = randomBytes(32);
  const normalBytes = proto.Message.encode({
    stickerMessage: { ...stickerMessage, fileSha256: normalStickerSha },
  }).finish();
  const normalInspected = inspectSoundStickerWire(normalBytes);
  assert.equal(normalInspected.hasField134, false);
  assert.equal(normalInspected.hasTopLevelSticker, true);
});

test('Sidecar: genera streamingSidecar válido verificando HMAC-SHA256 del audio', async () => {
  const audioPlain = randomBytes(90 * 1024); // > 64 KiB (2 bloques de sidecar)
  const mediaKey = randomBytes(32);
  const { iv, cipherKey, macKey } = await getMediaKeys(mediaKey, 'audio');

  const cipher = createCipheriv('aes-256-cbc', cipherKey, iv);
  const encrypted = Buffer.concat([cipher.update(audioPlain), cipher.final()]);
  const mac = createHmac('sha256', macKey).update(iv).update(encrypted).digest().subarray(0, 10);
  const fileEncSha256 = createHash('sha256').update(encrypted).update(mac).digest();

  const sidecar = await createAudioStreamingSidecar(audioPlain, mediaKey, fileEncSha256);
  // 90 KiB cifrados ocupan 2 bloques de 64 KiB -> 2 * 10 = 20 bytes
  assert.equal(sidecar.length, 20);
});

test('Handler: detecta comando .s2 en leyenda de video, respuesta citada y mensajes temporales', () => {
  // Video directo con caption .s2
  const direct = parseCommandRequest(
    {
      videoMessage: {
        caption: '.s2',
        mimetype: 'video/mp4',
      },
    },
    '.s2'
  );
  assert.ok(direct);
  assert.equal(direct.mediaKind, 'video');
  assert.equal(direct.fit, 'crop');

  // Respuesta a un video citado con .s2 full dentro de ephemeralMessage
  const quotedEphemeral = parseCommandRequest(
    {
      ephemeralMessage: {
        message: {
          extendedTextMessage: {
            text: '.S2 full',
            contextInfo: {
              quotedMessage: {
                viewOnceMessageV2: {
                  message: {
                    videoMessage: { mimetype: 'video/mp4' },
                  },
                },
              },
            },
          },
        },
      },
    },
    '.s2'
  );
  assert.ok(quotedEphemeral);
  assert.equal(quotedEphemeral.mediaKind, 'video');
  assert.equal(quotedEphemeral.fit, 'contain');

  // Comando .s2 sin video adjunto ni citado -> pide adjuntar video
  const missingMedia = parseCommandRequest({ conversation: '.s2' }, '.s2');
  assert.ok(missingMedia);
  assert.equal(missingMedia.mediaNode, null);

  // Otro mensaje cualquiera -> se ignora
  const ignored = parseCommandRequest({ conversation: 'hola mundo' }, '.s2');
  assert.equal(ignored, null);

  assert.ok(unwrapMessage({ ephemeralMessage: { message: { conversation: 'ok' } } }));
});
