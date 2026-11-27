import test from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, createHash, createHmac, randomBytes } from 'node:crypto';
import { getMediaKeys, proto } from '@whiskeysockets/baileys';

import { config } from '../src/config.js';
import { buildStickerExif, injectWebpExif, inspectWebp, readWebpExif } from '../src/exif.js';
import { waveformFromPcm } from '../src/media.js';
import {
  createAudioStreamingSidecar,
  formatWaveformBars,
  getEmbeddedStickerAudio,
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

test('EXIF y Config: usa por defecto descripción "Made by" y autor "@Lyan" + calcula firstFrameLength', () => {
  assert.equal(config.stickerPack, 'Made by');
  assert.equal(config.stickerAuthor, '@Lyan');

  const rawWebp = makeMinimalAnimatedWebp(512, 512);
  const exif = buildStickerExif(); // usa los valores por defecto ("Made by" / "@Lyan")

  const stamped = injectWebpExif(rawWebp, exif, { width: 512, height: 512 });
  const info = inspectWebp(stamped);

  assert.equal(info.width, 512);
  assert.equal(info.height, 512);
  assert.equal(info.animated, true);
  assert.equal(info.durationMs, 120);
  assert.ok(typeof info.firstFrameLength === 'number' && info.firstFrameLength > 0);

  const meta = readWebpExif(stamped);
  assert.ok(meta);
  assert.equal(meta['sticker-pack-name'], 'Made by');
  assert.equal(meta['sticker-pack-publisher'], '@Lyan');
  assert.deepEqual(meta.emojis, ['🔊']);
});

test('Waveform: calcula 64 barras PCM (0..100) y las formatea visualmente', () => {
  const pcm = Buffer.alloc(1600 * 2); // 1600 muestras int16
  for (let i = 0; i < 1600; i++) {
    const val = Math.round(Math.sin((i / 1600) * Math.PI) * 20000);
    pcm.writeInt16LE(val, i * 2);
  }

  const wf = waveformFromPcm(pcm, 64);
  assert.equal(wf.length, 64);
  assert.equal(Math.max(...wf), 100);

  const bars = formatWaveformBars(wf, 24);
  assert.equal([...bars].length, 24);
});

test('Protobuf: codifica y decodifica StickerMessage nativo con audioMessage (campo 26) + soporta desenvolver campo 134', () => {
  installSoundStickerProtoPatch();

  const fileSha256 = randomBytes(32);
  const audioSha256 = randomBytes(32);
  const mediaKey = randomBytes(32);
  const waveform = new Uint8Array(64).map((_, i) => (i * 2) % 100);

  const stickerMessage = {
    url: 'https://mmg.whatsapp.net/v/t62.15575-24/test.enc',
    directPath: '/v/t62.15575-24/test.enc',
    fileSha256,
    fileEncSha256: randomBytes(32),
    mediaKey,
    mimetype: 'image/webp',
    width: 512,
    height: 512,
    firstFrameLength: 78,
    isAnimated: true,
    emojis: ['🔊'],
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
    waveform,
  };

  // 1) Formato nativo oficial de WhatsApp Web / Android: Message.stickerMessage (26) -> StickerMessage.audioMessage (26)
  registerPendingAudioSticker(fileSha256.toString('base64'), audioMessage, {
    emojis: ['🔊'],
    wrapField134: false,
  });

  const clonedMsg = proto.Message.fromObject({
    stickerMessage: {
      ...stickerMessage,
      audioMessage,
    },
  });
  const directBytes = proto.Message.encode(clonedMsg).finish();
  const inspected = inspectSoundStickerWire(directBytes);

  assert.equal(inspected.hasField134, false);
  assert.equal(inspected.hasTopLevelSticker, true);
  assert.equal(inspected.emojis, '🔊');
  assert.ok(inspected.sticker);
  assert.equal(inspected.sticker.isAnimated, true);
  assert.ok(inspected.audioMessage);
  assert.equal(inspected.audioMessage.seconds, 5);
  assert.equal(inspected.audioMessage.mimetype, 'audio/ogg; codecs=opus');
  assert.equal(inspected.audioMessage.waveform.length, 64);

  // Al decodificar con proto.Message.decode se conserva stickerMessage.audioMessage para poder ver el sonido
  const decodedNative = proto.Message.decode(directBytes);
  const extractedNativeAudio = getEmbeddedStickerAudio(decodedNative);
  assert.ok(extractedNativeAudio);
  assert.equal(extractedNativeAudio.seconds, 5);

  // 2) Compatibilidad con stickers envueltos en Message.audioStickerMessage (campo 134)
  const wrappedSha = randomBytes(32);
  registerPendingAudioSticker(wrappedSha.toString('base64'), audioMessage, {
    emojis: ['🔊'],
    wrapField134: true,
  });
  const wrappedBytes = proto.Message.encode({
    stickerMessage: { ...stickerMessage, fileSha256: wrappedSha },
  }).finish();
  const inspectedWrapped = inspectSoundStickerWire(wrappedBytes);
  assert.equal(inspectedWrapped.hasField134, true);

  const decodedWrapped = proto.Message.decode(wrappedBytes);
  const extractedWrappedAudio = getEmbeddedStickerAudio(decodedWrapped);
  assert.ok(extractedWrappedAudio);
  assert.equal(extractedWrappedAudio.seconds, 5);

  // 3) Stickers normales sin audio siguen intactos
  const normalStickerSha = randomBytes(32);
  const normalBytes = proto.Message.encode({
    stickerMessage: { ...stickerMessage, fileSha256: normalStickerSha, emojis: [] },
  }).finish();
  const normalInspected = inspectSoundStickerWire(normalBytes);
  assert.equal(normalInspected.hasField134, false);
  assert.equal(normalInspected.hasTopLevelSticker, true);
  assert.equal(normalInspected.audioMessage, null);
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

test('Handler: detecta .s2 para crear stickers y .audio / .sonido / .s2 sobre stickers para ver su sonido', () => {
  // Video directo con caption .s2 ver
  const direct = parseCommandRequest(
    {
      videoMessage: {
        caption: '.s2 ver',
        mimetype: 'video/mp4',
      },
    },
    '.s2',
    '.audio'
  );
  assert.ok(direct);
  assert.equal(direct.action, 'create_sticker');
  assert.equal(direct.mediaKind, 'video');
  assert.equal(direct.fit, 'crop');
  assert.equal(direct.showSoundPreview, true);

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
    '.s2',
    '.audio'
  );
  assert.ok(quotedEphemeral);
  assert.equal(quotedEphemeral.action, 'create_sticker');
  assert.equal(quotedEphemeral.mediaKind, 'video');
  assert.equal(quotedEphemeral.fit, 'contain');

  // Responder .audio o .sonido a un sticker -> inspect_sound
  const inspectAudio = parseCommandRequest(
    {
      extendedTextMessage: {
        text: '.sonido',
        contextInfo: {
          quotedMessage: {
            stickerMessage: { mimetype: 'image/webp', isAnimated: true },
          },
        },
      },
    },
    '.s2',
    '.audio'
  );
  assert.ok(inspectAudio);
  assert.equal(inspectAudio.action, 'inspect_sound');
  assert.equal(inspectAudio.mediaKind, 'sticker');

  // Responder .s2 a un sticker -> también inspecciona el sonido del sticker
  const inspectViaS2 = parseCommandRequest(
    {
      extendedTextMessage: {
        text: '.s2',
        contextInfo: {
          quotedMessage: {
            stickerMessage: { mimetype: 'image/webp', isAnimated: true },
          },
        },
      },
    },
    '.s2',
    '.audio'
  );
  assert.ok(inspectViaS2);
  assert.equal(inspectViaS2.action, 'inspect_sound');
  assert.equal(inspectViaS2.mediaKind, 'sticker');

  // Comando .s2 sin video ni sticker adjunto/citado -> pide adjuntar video
  const missingMedia = parseCommandRequest({ conversation: '.s2' }, '.s2', '.audio');
  assert.ok(missingMedia);
  assert.equal(missingMedia.action, 'create_sticker');
  assert.equal(missingMedia.mediaNode, null);

  // Otro mensaje cualquiera -> se ignora
  const ignored = parseCommandRequest({ conversation: 'hola mundo' }, '.s2', '.audio');
  assert.equal(ignored, null);

  assert.ok(unwrapMessage({ ephemeralMessage: { message: { conversation: 'ok' } } }));
});
