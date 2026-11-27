import { createCipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import pino from 'pino';
import protobuf from 'protobufjs';
import {
  downloadContentFromMessage,
  generateWAMessageFromContent,
  getMediaKeys,
  prepareWAMessageMedia,
  proto,
} from '@whiskeysockets/baileys';

const FIELD_AUDIO_STICKER_WRAPPER = 134; // Message.audioStickerMessage (FutureProofMessage, opcional)
const FIELD_FUTURE_PROOF_MESSAGE = 1;    // FutureProofMessage.message (Message)
const FIELD_STICKER_MESSAGE = 26;        // Message.stickerMessage (StickerMessage)
const FIELD_STICKER_PREMIUM = 24;        // StickerMessage.premium (bool/varint)
const FIELD_STICKER_EMOJIS = 25;         // StickerMessage.emojis (repeated string)
const FIELD_STICKER_AUDIO = 26;          // StickerMessage.audioMessage (AudioMessage)
const SIDECAR_CHUNK = 64 * 1024;
const WAVEFORM_BAR_CHARS = '▁▂▃▄▅▆▇█';

const silentLogger = pino({ level: 'silent' });

/**
 * Mapa temporal indexado por fileSha256 (base64) del sticker WebP.
 * Garantiza que incluso si `StickerMessage.fromObject` clona el objeto o Baileys
 * empaqueta `deviceSentMessage` / reintentos Signal, la pista `audioMessage` y `emojis`
 * siempre viajen adheridas al `StickerMessage`.
 */
const pendingAudioStickers = new Map();
let protoEncoderInstalled = false;

function cleanupExpired() {
  const now = Date.now();
  for (const [key, entry] of pendingAudioStickers.entries()) {
    if (entry.expiresAt < now) {
      pendingAudioStickers.delete(key);
    }
  }
}

export function registerPendingAudioSticker(
  webpSha256B64,
  audioMessage,
  { emojis = ['🔊'], wrapField134 = false, ttlMs = 10 * 60 * 1000 } = {}
) {
  cleanupExpired();
  const normalizedEmojis = Array.isArray(emojis)
    ? emojis.filter(Boolean)
    : emojis
      ? [String(emojis)]
      : ['🔊'];

  pendingAudioStickers.set(webpSha256B64, {
    audioMessage,
    emojis: normalizedEmojis,
    wrapField134: Boolean(wrapField134),
    expiresAt: Date.now() + ttlMs,
  });
}

function getPendingForSticker(sticker) {
  if (!sticker?.fileSha256) return null;
  const shaB64 = Buffer.from(sticker.fileSha256).toString('base64');
  const pending = pendingAudioStickers.get(shaB64);
  if (!pending || pending.expiresAt < Date.now()) {
    if (pending) pendingAudioStickers.delete(shaB64);
    return null;
  }
  return pending;
}

function extractStickerExtrasFromBytes(bytes) {
  const reader = protobuf.Reader.create(bytes);
  let audioMessage = null;
  const emojis = [];
  let premium;

  while (reader.pos < reader.len) {
    const tag = reader.uint32();
    const fieldNo = tag >>> 3;
    const wireType = tag & 7;

    if (fieldNo === FIELD_STICKER_AUDIO && wireType === 2) {
      audioMessage = proto.Message.AudioMessage.decode(reader.bytes());
    } else if (fieldNo === FIELD_STICKER_EMOJIS && wireType === 2) {
      emojis.push(reader.string());
    } else if (fieldNo === FIELD_STICKER_PREMIUM && wireType === 0) {
      premium = reader.int32();
    } else {
      reader.skipType(wireType);
    }
  }

  return { audioMessage, emojis, premium };
}

/**
 * Parchea `StickerMessage` y `Message` en tiempo de ejecución para soportar
 * Stickers con Sonido de WhatsApp (tanto al enviar como al recibir/inspeccionar):
 *
 * Formato nativo oficial (WhatsApp Web & Android 2.26.41.6):
 * Message {
 *   26 (stickerMessage): StickerMessage {
 *     ...campos estándar de StickerMessage...,
 *     25 (emojis): ["🔊"],
 *     26 (audioMessage): AudioMessage {
 *       url, directPath, mediaKey, fileEncSha256, fileSha256, fileLength,
 *       mediaKeyTimestamp, mimetype: "audio/ogg; codecs=opus", seconds, ptt: false,
 *       streamingSidecar, waveform (64 barras)
 *     }
 *   }
 * }
 *
 * También soporta decodificar y opcionalmente envolver `Message.audioStickerMessage` (campo 134).
 */
export function installSoundStickerProtoPatch() {
  if (protoEncoderInstalled) return;
  protoEncoderInstalled = true;

  const SM = proto.Message.StickerMessage;
  SM.prototype.audioMessage = null;
  SM.prototype.emojis = [];

  const origStickerEncode = SM.encode.bind(SM);
  const origStickerDecode = SM.decode.bind(SM);
  const origStickerFromObject = SM.fromObject.bind(SM);
  const origStickerToObject = SM.toObject.bind(SM);

  SM.encode = function patchedStickerEncode(m, writer) {
    const w = origStickerEncode(m, writer);
    const pending = getPendingForSticker(m);
    const audioMsg = m?.audioMessage || pending?.audioMessage || null;
    const rawEmojis =
      Array.isArray(m?.emojis) && m.emojis.length > 0
        ? m.emojis
        : typeof m?.emojis === 'string' && m.emojis
          ? [m.emojis]
          : pending?.emojis || [];

    for (const emoji of rawEmojis) {
      if (emoji) {
        // Campo 25 (emojis, repeated string): (25 << 3) | 2 = 202
        w.uint32((FIELD_STICKER_EMOJIS << 3) | 2).string(String(emoji));
      }
    }

    if (audioMsg) {
      // Campo 26 (StickerMessage.audioMessage, AudioMessage): (26 << 3) | 2 = 210
      proto.Message.AudioMessage.encode(
        audioMsg,
        w.uint32((FIELD_STICKER_AUDIO << 3) | 2).fork()
      ).ldelim();
    }

    return w;
  };

  SM.decode = function patchedStickerDecode(reader, length, end) {
    const r = reader instanceof protobuf.Reader ? reader : protobuf.Reader.create(reader);
    const startPos = r.pos;
    const endPos = length === undefined ? r.len : startPos + length;
    const rawSlice = r.buf.subarray(startPos, endPos);

    const decoded = origStickerDecode(r, length, end);
    try {
      const extras = extractStickerExtrasFromBytes(rawSlice);
      if (extras.audioMessage) {
        decoded.audioMessage = extras.audioMessage;
      }
      if (extras.emojis.length > 0) {
        decoded.emojis = extras.emojis;
      }
      if (extras.premium !== undefined) {
        decoded.premium = extras.premium;
      }
    } catch {
      // Ignoramos errores de campos opcionales desconocidos para no romper stickers normales
    }
    return decoded;
  };

  SM.fromObject = function patchedStickerFromObject(d) {
    if (!d) return origStickerFromObject(d);
    const m = origStickerFromObject(d);
    if (d.audioMessage != null && typeof d.audioMessage === 'object') {
      m.audioMessage = proto.Message.AudioMessage.fromObject(d.audioMessage);
    }
    if (Array.isArray(d.emojis) && d.emojis.length > 0) {
      m.emojis = d.emojis.map(String);
    } else if (typeof d.emojis === 'string' && d.emojis) {
      m.emojis = [d.emojis];
    }
    return m;
  };

  SM.toObject = function patchedStickerToObject(m, o) {
    const d = origStickerToObject(m, o);
    if (m?.audioMessage != null) {
      d.audioMessage = proto.Message.AudioMessage.toObject(m.audioMessage, o);
    }
    if (Array.isArray(m?.emojis) && m.emojis.length > 0) {
      d.emojis = m.emojis.slice();
    }
    return d;
  };

  const origMsgEncode = proto.Message.encode.bind(proto.Message);
  const origMsgDecode = proto.Message.decode.bind(proto.Message);

  proto.Message.encode = function patchedMessageEncode(message, writer) {
    const w = writer ?? protobuf.Writer.create();
    const sticker = message?.stickerMessage;
    const pending = getPendingForSticker(sticker);

    // Solo si se solicita explícitamente wrapField134 envolvemos en Message.audioStickerMessage (134).
    // Por defecto enviamos StickerMessage raíz (campo 26) + StickerMessage.audioMessage (campo 26),
    // que es exactamente lo que envían y muestran WhatsApp Web y WhatsApp Android/iOS oficialmente.
    if (sticker && pending?.wrapField134) {
      const rest = {};
      for (const key of Object.keys(message)) {
        if (key !== 'stickerMessage') {
          rest[key] = message[key];
        }
      }
      origMsgEncode(rest, w);

      w.uint32((FIELD_AUDIO_STICKER_WRAPPER << 3) | 2).fork();
      w.uint32((FIELD_FUTURE_PROOF_MESSAGE << 3) | 2).fork();
      w.uint32((FIELD_STICKER_MESSAGE << 3) | 2).fork();
      SM.encode(sticker, w);
      w.ldelim().ldelim().ldelim();
      return w;
    }

    return origMsgEncode(message, w);
  };

  proto.Message.decode = function patchedMessageDecode(reader, length, end) {
    const r = reader instanceof protobuf.Reader ? reader : protobuf.Reader.create(reader);
    const startPos = r.pos;
    const endPos = length === undefined ? r.len : startPos + length;
    const rawSlice = r.buf.subarray(startPos, endPos);

    const decoded = origMsgDecode(r, length, end);

    // Si algún otro bot envió el sticker envuelto en el campo 134 (`audioStickerMessage`),
    // lo desenvolvemos automáticamente para poder ver y extraer su sonido sin problemas.
    if (!decoded.stickerMessage && rawSlice.length > 0) {
      try {
        const scan = protobuf.Reader.create(rawSlice);
        while (scan.pos < scan.len) {
          const tag = scan.uint32();
          const fieldNo = tag >>> 3;
          const wireType = tag & 7;
          if (fieldNo === FIELD_AUDIO_STICKER_WRAPPER && wireType === 2) {
            const fp = proto.Message.FutureProofMessage.decode(scan.bytes());
            if (fp?.message) {
              decoded.audioStickerMessage = fp;
              if (fp.message.stickerMessage && !decoded.stickerMessage) {
                decoded.stickerMessage = fp.message.stickerMessage;
              }
            }
          } else {
            scan.skipType(wireType);
          }
        }
      } catch {
        // Ignoramos errores al escanear campo opcional 134
      }
    }

    return decoded;
  };
}

/**
 * Calcula el `streamingSidecar` del audio cifrado (bloques HMAC-SHA256 truncados a 10 bytes
 * cada 64 KiB) verificando integridad frente al `fileEncSha256` subido por Baileys.
 */
export async function createAudioStreamingSidecar(audioBuffer, mediaKey, fileEncSha256) {
  const { iv, cipherKey, macKey } = await getMediaKeys(Buffer.from(mediaKey), 'audio');
  if (!iv || !cipherKey || !macKey) {
    throw new Error('No se pudieron derivar las claves criptográficas del audio.');
  }

  const cipher = createCipheriv('aes-256-cbc', cipherKey, iv);
  const encrypted = Buffer.concat([cipher.update(audioBuffer), cipher.final()]);
  const mac = createHmac('sha256', macKey).update(iv).update(encrypted).digest().subarray(0, 10);
  const hash = createHash('sha256').update(encrypted).update(mac).digest();

  if (hash.length !== fileEncSha256.length || !timingSafeEqual(hash, Buffer.from(fileEncSha256))) {
    throw new Error('El hash del audio cifrado no coincide con el archivo subido.');
  }

  const parts = [];
  for (let start = 0; start < encrypted.length; start += SIDECAR_CHUNK) {
    const prevBlock = start === 0 ? iv : encrypted.subarray(start - 16, start);
    const chunk = encrypted.subarray(start, start + SIDECAR_CHUNK);
    parts.push(
      createHmac('sha256', macKey).update(prevBlock).update(chunk).digest().subarray(0, 10)
    );
  }
  return Buffer.concat(parts);
}

/**
 * Renderiza una barra gráfica Unicode legible en WhatsApp a partir de un `waveform` (0..100).
 */
export function formatWaveformBars(waveform, targetBars = 24) {
  if (!waveform || waveform.length === 0) {
    return '▁▂▃▄▅▆▅▄▃▂▁▂▃▅▆▇▆▄▃▂▁▂▃▄';
  }
  const src = Uint8Array.from(waveform);
  let maxVal = 0;
  for (let i = 0; i < src.length; i++) {
    if (src[i] > maxVal) maxVal = src[i];
  }
  const scale = maxVal > 0 ? maxVal : 100;
  let out = '';
  for (let i = 0; i < targetBars; i++) {
    const idx = Math.min(src.length - 1, Math.floor((i * src.length) / targetBars));
    const ratio = Math.max(0, Math.min(1, src[idx] / scale));
    const charIdx = Math.min(
      WAVEFORM_BAR_CHARS.length - 1,
      Math.floor(ratio * (WAVEFORM_BAR_CHARS.length - 1))
    );
    out += WAVEFORM_BAR_CHARS[charIdx];
  }
  return out;
}

/**
 * Extrae el `AudioMessage` incrustado dentro de un `StickerMessage` (ya sea directo en campo 26
 * o envuelto en `audioStickerMessage` campo 134).
 */
export function getEmbeddedStickerAudio(stickerOrMessage) {
  if (!stickerOrMessage) return null;
  if (stickerOrMessage.audioMessage?.mediaKey || stickerOrMessage.audioMessage?.directPath) {
    return stickerOrMessage.audioMessage;
  }
  const innerSticker =
    stickerOrMessage.stickerMessage ||
    stickerOrMessage.audioStickerMessage?.message?.stickerMessage ||
    null;
  if (innerSticker?.audioMessage?.mediaKey || innerSticker?.audioMessage?.directPath) {
    return innerSticker.audioMessage;
  }
  return null;
}

/**
 * Descarga y descifra los bytes de audio Ogg/Opus incrustados dentro de un Sticker con Sonido.
 */
export async function downloadSoundFromSticker(stickerOrAudioMsg) {
  const audioMsg = stickerOrAudioMsg?.mediaKey && stickerOrAudioMsg?.mimetype?.includes('audio')
    ? stickerOrAudioMsg
    : getEmbeddedStickerAudio(stickerOrAudioMsg);

  if (!audioMsg) {
    throw new Error('Este sticker no contiene ninguna pista de sonido incrustada.');
  }

  const stream = await downloadContentFromMessage(audioMsg, 'audio');
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  return {
    audioBuffer: Buffer.concat(chunks),
    audioMessage: audioMsg,
  };
}

/**
 * Sube el WebP animado y el audio Ogg/Opus a los servidores multimedia de WhatsApp
 * y envía el mensaje como Sticker con Audio nativo (con icono de parlante 🔊, duración y waveform).
 */
export async function sendSoundSticker(sock, jid, {
  webpBuffer,
  audioBuffer,
  waveform = null,
  durationMs = 3000,
  firstFrameLength = null,
  width = 512,
  height = 512,
  emojis = ['🔊'],
  wrapField134 = false,
  sendAudioPreview = false,
  quoted,
}) {
  if (!sock.user?.id) {
    throw new Error('El socket de WhatsApp todavía no está autenticado.');
  }

  installSoundStickerProtoPatch();

  // Si el video original no tenía pista de audio, enviamos como sticker animado estándar
  if (!audioBuffer || audioBuffer.length === 0) {
    const sent = await sock.sendMessage(
      jid,
      { sticker: webpBuffer, isAnimated: true, width, height },
      quoted ? { quoted } : undefined
    );
    return { messageId: sent?.key?.id, withAudio: false };
  }

  const uploadOpts = {
    upload: sock.waUploadToServer,
    logger: silentLogger,
    mediaUploadTimeoutMs: 60_000,
  };

  const seconds = Math.max(1, Math.round(durationMs / 1000));
  const wfBytes =
    waveform && waveform.length > 0 ? Uint8Array.from(waveform) : new Uint8Array(64).fill(45);

  const [visualMedia, audioMedia] = await Promise.all([
    prepareWAMessageMedia(
      {
        sticker: webpBuffer,
        isAnimated: true,
        width,
        height,
      },
      uploadOpts
    ),
    prepareWAMessageMedia(
      {
        audio: audioBuffer,
        mimetype: 'audio/ogg; codecs=opus',
        seconds,
        ptt: false,
      },
      uploadOpts
    ),
  ]);

  const stickerMessage = visualMedia?.stickerMessage;
  const audioMessage = audioMedia?.audioMessage;

  if (!stickerMessage?.fileSha256 || !audioMessage?.mediaKey || !audioMessage?.fileEncSha256) {
    throw new Error('Error al preparar o subir las pistas del sticker con audio.');
  }

  audioMessage.mimetype = 'audio/ogg; codecs=opus';
  audioMessage.seconds = seconds;
  audioMessage.ptt = false;
  audioMessage.waveform = wfBytes;
  audioMessage.streamingSidecar = await createAudioStreamingSidecar(
    audioBuffer,
    audioMessage.mediaKey,
    audioMessage.fileEncSha256
  );

  stickerMessage.isAnimated = true;
  stickerMessage.width = width;
  stickerMessage.height = height;
  stickerMessage.stickerSentTs = Date.now();
  if (typeof firstFrameLength === 'number' && firstFrameLength > 0) {
    stickerMessage.firstFrameLength = firstFrameLength;
  }
  stickerMessage.emojis = Array.isArray(emojis) ? emojis : ['🔊'];
  stickerMessage.audioMessage = audioMessage;

  const senderJid =
    jid.endsWith('@lid') && sock.user?.lid ? sock.user.lid : sock.user.id;

  const waMsg = generateWAMessageFromContent(
    jid,
    {
      stickerMessage,
      messageContextInfo: {
        messageSecret: randomBytes(32),
      },
    },
    {
      userJid: senderJid,
      quoted,
    }
  );

  const webpSha256B64 = Buffer.from(stickerMessage.fileSha256).toString('base64');
  registerPendingAudioSticker(webpSha256B64, audioMessage, {
    emojis: stickerMessage.emojis,
    wrapField134,
  });

  await sock.relayMessage(jid, waMsg.message, { messageId: waMsg.key.id });

  if (sendAudioPreview) {
    await sock.sendMessage(
      jid,
      {
        audio: audioBuffer,
        mimetype: 'audio/ogg; codecs=opus',
        ptt: true,
        seconds,
        waveform: wfBytes,
      },
      { quoted: waMsg }
    );
  }

  return { messageId: waMsg.key.id, withAudio: true, seconds, waveform: wfBytes };
}

/**
 * Decodifica e inspecciona bytes Protobuf crudos de un `proto.Message` para verificar
 * tanto el formato nativo `Message.stickerMessage` (campo 26 -> `StickerMessage.audioMessage` campo 26)
 * como el envoltorio opcional `Message.audioStickerMessage` (campo 134).
 */
export function inspectSoundStickerWire(bytes) {
  installSoundStickerProtoPatch();
  const reader = protobuf.Reader.create(bytes);
  let field134Bytes = null;
  let topStickerBytes = null;

  while (reader.pos < reader.len) {
    const tag = reader.uint32();
    const fieldNo = tag >>> 3;
    const wireType = tag & 7;
    if (fieldNo === FIELD_AUDIO_STICKER_WRAPPER && wireType === 2) {
      field134Bytes = reader.bytes();
    } else if (fieldNo === FIELD_STICKER_MESSAGE && wireType === 2) {
      topStickerBytes = reader.bytes();
    } else {
      reader.skipType(wireType);
    }
  }

  let targetStickerBytes = topStickerBytes;

  if (!targetStickerBytes && field134Bytes) {
    const r134 = protobuf.Reader.create(field134Bytes);
    let innerMsgBytes = null;
    while (r134.pos < r134.len) {
      const tag = r134.uint32();
      const fieldNo = tag >>> 3;
      const wireType = tag & 7;
      if (fieldNo === FIELD_FUTURE_PROOF_MESSAGE && wireType === 2) {
        innerMsgBytes = r134.bytes();
      } else {
        r134.skipType(wireType);
      }
    }

    if (innerMsgBytes) {
      const rInner = protobuf.Reader.create(innerMsgBytes);
      while (rInner.pos < rInner.len) {
        const tag = rInner.uint32();
        const fieldNo = tag >>> 3;
        const wireType = tag & 7;
        if (fieldNo === FIELD_STICKER_MESSAGE && wireType === 2) {
          targetStickerBytes = rInner.bytes();
        } else {
          rInner.skipType(wireType);
        }
      }
    }
  }

  if (!targetStickerBytes) {
    return {
      hasField134: Boolean(field134Bytes),
      hasTopLevelSticker: Boolean(topStickerBytes),
    };
  }

  const sticker = proto.Message.StickerMessage.decode(targetStickerBytes);
  const extras = extractStickerExtrasFromBytes(targetStickerBytes);

  return {
    hasField134: Boolean(field134Bytes),
    hasTopLevelSticker: Boolean(topStickerBytes),
    sticker,
    premium: extras.premium,
    emojis: extras.emojis.length === 1 ? extras.emojis[0] : extras.emojis,
    audioMessage: extras.audioMessage,
  };
}
