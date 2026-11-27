import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createCipheriv, createHash, createHmac, randomBytes } from 'node:crypto';
import { getMediaKeys, proto } from '@whiskeysockets/baileys';

import { config } from '../src/config.js';
import { buildStickerExif, injectWebpExif, inspectWebp, readWebpExif } from '../src/exif.js';
import { buildVideoFilter, parseCropdetectOutput, waveformFromPcm } from '../src/media.js';
import { downloadTikTokVideoBuffer, extractTikTokUrl } from '../src/tiktok.js';
import { evaluateSenderAccess, loadSettings, saveSettings } from '../src/settings.js';
import { fit as tuiFit, pad as tuiPad, width as tuiWidth } from '../src/panel/tui.js';
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
  assert.equal(quotedEphemeral.fit, 'full');

  // Enlace de TikTok directo: .s2 https://vm.tiktok.com/ZMxyz123/
  const tiktokDirect = parseCommandRequest(
    { conversation: '.s2 https://vm.tiktok.com/ZMxyz123/' },
    '.s2',
    '.audio'
  );
  assert.ok(tiktokDirect);
  assert.equal(tiktokDirect.action, 'create_sticker');
  assert.equal(tiktokDirect.mediaKind, 'tiktok');
  assert.equal(tiktokDirect.tiktokUrl, 'https://vm.tiktok.com/ZMxyz123/');
  assert.equal(tiktokDirect.fit, 'crop');

  // Enlace de TikTok citado con .s2 full
  const tiktokQuotedFull = parseCommandRequest(
    {
      extendedTextMessage: {
        text: '.s2 full',
        contextInfo: {
          quotedMessage: {
            conversation: 'Mira esto https://www.tiktok.com/@usuario/video/7391234567890123456!',
          },
        },
      },
    },
    '.s2',
    '.audio'
  );
  assert.ok(tiktokQuotedFull);
  assert.equal(tiktokQuotedFull.action, 'create_sticker');
  assert.equal(tiktokQuotedFull.mediaKind, 'tiktok');
  assert.equal(
    tiktokQuotedFull.tiktokUrl,
    'https://www.tiktok.com/@usuario/video/7391234567890123456'
  );
  assert.equal(tiktokQuotedFull.fit, 'full');

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

test('Filtro .s2 full: recorta bordes negros (cropdetect) y preserva canal alfa RGBA sin franjas negras', () => {
  const sampleLogs = [
    '[Parsed_cropdetect_1 @ 0x1] x1:0 x2:719 y1:240 y2:1039 w:720 h:800 x:0 y:240 pts:1 crop=720:800:0:240',
    '[Parsed_cropdetect_1 @ 0x1] x1:0 x2:719 y1:240 y2:1039 w:720 h:800 x:0 y:240 pts:2 crop=720:800:0:240',
    '[Parsed_cropdetect_1 @ 0x1] x1:0 x2:719 y1:238 y2:1041 w:720 h:804 x:0 y:238 pts:3 crop=720:804:0:238',
    '[Parsed_cropdetect_1 @ 0x1] x1:0 x2:719 y1:240 y2:1039 w:720 h:800 x:0 y:240 pts:4 crop=720:800:0:240',
  ].join('\n');

  const detected = parseCropdetectOutput(sampleLogs, 720, 1280);
  assert.equal(detected, 'crop=720:800:0:240');

  // Si el área detectada es prácticamente todo el fotograma, no recorta innecesariamente
  const fullFrameLog = 'pts:1 crop=718:1278:0:2';
  assert.equal(parseCropdetectOutput(fullFrameLog, 720, 1280), null);

  // El filtro full incluye el pre-crop contra bordes negros y relleno transparente RGBA (sin yuva420p)
  const vfFull = buildVideoFilter(512, 12, 'full', detected);
  assert.ok(vfFull.includes('crop=720:800:0:240'));
  assert.ok(vfFull.includes('format=rgba'));
  assert.ok(vfFull.includes('color=0x00000000'));
  assert.ok(!vfFull.includes('yuva420p'));
});

test('TikTok: extrae enlaces válidos y descarga el MP4 sin marca de agua mediante el resolvedor', async () => {
  assert.equal(
    extractTikTokUrl('.s2 https://vt.tiktok.com/ZS8abc123/'),
    'https://vt.tiktok.com/ZS8abc123/'
  );
  assert.equal(extractTikTokUrl('sin enlace aquí'), null);

  const fakeMp4 = Buffer.alloc(2048, 0x11);
  const calls = [];

  const mockFetch = async (url) => {
    calls.push(String(url));
    if (String(url).includes('vt.tiktok.com')) {
      return {
        ok: false,
        status: 302,
        headers: new Map([
          ['location', 'https://www.tiktok.com/@lyan/video/7400000000000000000?is_from_webapp=1'],
        ]),
      };
    }
    if (String(url).includes('tikwm.com/api')) {
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            code: 0,
            data: {
              id: '7400000000000000000',
              title: 'Prueba TikTok',
              duration: 7,
              play: '/video/media/play/7400000000000000000.mp4',
              author: { unique_id: 'lyan' },
            },
          };
        },
      };
    }
    if (String(url).includes('/video/media/play/')) {
      return {
        ok: true,
        status: 200,
        headers: new Map([['content-length', String(fakeMp4.length)]]),
        async arrayBuffer() {
          return fakeMp4.buffer.slice(fakeMp4.byteOffset, fakeMp4.byteOffset + fakeMp4.byteLength);
        },
      };
    }
    throw new Error(`URL inesperada en mock: ${url}`);
  };

  const result = await downloadTikTokVideoBuffer('https://vt.tiktok.com/ZS8abc123/', {
    fetchImpl: mockFetch,
  });

  assert.equal(result.buffer.length, 2048);
  assert.equal(result.provider, 'tikwm-post');
  assert.equal(result.author, 'lyan');
  assert.ok(calls.some((u) => u.includes('tikwm.com/api')));
});

test('Ajustes y TUI: modo "Solo el dueño" y números "Excluidos" funcionan en caliente', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'audiobot-settings-'));
  const settingsFile = path.join(tmpDir, 'settings.json');

  try {
    // Valores iniciales: público, sin excluidos
    const initial = loadSettings(settingsFile);
    assert.equal(initial.ownerOnly, false);
    assert.deepEqual(initial.excludedNumbers, []);
    assert.equal(initial.stickerPack, 'Made by');
    assert.equal(initial.stickerAuthor, '@Lyan');

    // Añadir números excluidos y dueños
    const saved = saveSettings(
      {
        ownerOnly: false,
        owners: ['+598 99 111 222'],
        excludedNumbers: ['+598 99 777 888', '5215512345678@s.whatsapp.net'],
      },
      settingsFile
    );

    assert.deepEqual(saved.owners, ['59899111222']);
    assert.deepEqual(saved.excludedNumbers, ['59899777888', '5215512345678']);

    // Un número excluido NO puede usar el bot
    const blockedCheck = evaluateSenderAccess({
      senderCandidates: ['59899777888@s.whatsapp.net'],
      fromMe: false,
      botNumber: '59899000000',
      settings: saved,
    });
    assert.equal(blockedCheck.allowed, false);
    assert.equal(blockedCheck.reason, 'excluded');

    // También detecta variante regional mexicana (52 vs 521)
    const mexBlocked = evaluateSenderAccess({
      senderCandidates: ['525512345678@s.whatsapp.net'],
      fromMe: false,
      botNumber: '59899000000',
      settings: saved,
    });
    assert.equal(mexBlocked.allowed, false);
    assert.equal(mexBlocked.reason, 'excluded');

    // Un usuario normal no excluido sí puede usarlo cuando Solo el dueño = false
    const regularUser = evaluateSenderAccess({
      senderCandidates: ['59899333444@s.whatsapp.net'],
      fromMe: false,
      botNumber: '59899000000',
      settings: saved,
    });
    assert.equal(regularUser.allowed, true);

    // Al activar "Solo el dueño", bloquea al usuario normal pero permite al dueño y al propio bot
    const ownerOnlySettings = saveSettings({ ownerOnly: true }, settingsFile);
    const blockedByOwnerMode = evaluateSenderAccess({
      senderCandidates: ['59899333444@s.whatsapp.net'],
      fromMe: false,
      botNumber: '59899000000',
      settings: ownerOnlySettings,
    });
    assert.equal(blockedByOwnerMode.allowed, false);
    assert.equal(blockedByOwnerMode.reason, 'owner_only');

    const ownerAllowed = evaluateSenderAccess({
      senderCandidates: ['59899111222@s.whatsapp.net'],
      fromMe: false,
      botNumber: '59899000000',
      settings: ownerOnlySettings,
    });
    assert.equal(ownerAllowed.allowed, true);
    assert.equal(ownerAllowed.isOwner, true);

    const selfAllowed = evaluateSenderAccess({
      senderCandidates: ['99999999@lid'],
      fromMe: true,
      botNumber: '59899000000',
      settings: ownerOnlySettings,
    });
    assert.equal(selfAllowed.allowed, true);

    // Utilidades de ancho/recorte ANSI del panel TUI
    assert.equal(tuiWidth('\u001b[32mAjustes\u001b[0m'), 7);
    assert.equal(tuiWidth(tuiPad('Ajustes', 12)), 12);
    assert.equal(tuiWidth(tuiFit('Ajustes del panel', 7)), 7);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});
