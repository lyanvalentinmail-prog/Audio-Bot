import { createCipheriv, createHash, createHmac, timingSafeEqual } from 'node:crypto';
import pino from 'pino';
import protobuf from 'protobufjs';
import {
  generateWAMessageFromContent,
  getMediaKeys,
  prepareWAMessageMedia,
  proto,
} from '@whiskeysockets/baileys';

const FIELD_AUDIO_STICKER_WRAPPER = 134; // Message.audioStickerMessage (FutureProofMessage)
const FIELD_FUTURE_PROOF_MESSAGE = 1;    // FutureProofMessage.message (Message)
const FIELD_STICKER_MESSAGE = 26;        // Message.stickerMessage (StickerMessage)
const FIELD_STICKER_AUDIO = 26;          // StickerMessage.audioMessage (AudioMessage)
const SIDECAR_CHUNK = 64 * 1024;

const silentLogger = pino({ level: 'silent' });

/**
 * Mapa temporal indexado por fileSha256 (base64) del sticker WebP.
 * Permite que el hook de `proto.Message.encode` empaquete el campo 134 tanto en el mensaje
 * principal como en la copia `deviceSentMessage` sincronizada con el propio teléfono
 * y en eventuales reintentos de cifrado Signal, sin afectar el resto de mensajes normales.
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
  { emoji = '🔊', ttlMs = 10 * 60 * 1000 } = {}
) {
  cleanupExpired();
  pendingAudioStickers.set(webpSha256B64, {
    audioMessage,
    emoji,
    expiresAt: Date.now() + ttlMs,
  });
}

/**
 * Instala el codificador Protobuf para la nueva función de Stickers con Audio de WhatsApp:
 *
 * Message {
 *   134 (FutureProofMessage / audioStickerMessage): {
 *     1 (Message): {
 *       26 (StickerMessage): {
 *         ...campos estándar de StickerMessage...,
 *         24 (premium): 0,
 *         25 (emojis): "🔊",
 *         26 (AudioMessage): { ...pista Ogg/Opus subida... }
 *       }
 *     }
 *   }
 * }
 */
export function installSoundStickerProtoPatch() {
  if (protoEncoderInstalled) return;
  protoEncoderInstalled = true;

  const originalEncode = proto.Message.encode.bind(proto.Message);

  proto.Message.encode = function patchedMessageEncode(message, writer) {
    const w = writer ?? protobuf.Writer.create();
    const sticker = message?.stickerMessage;

    if (sticker?.fileSha256) {
      const shaB64 = Buffer.from(sticker.fileSha256).toString('base64');
      const pending = pendingAudioStickers.get(shaB64);

      if (pending && pending.expiresAt >= Date.now()) {
        // Codificamos el resto de campos de Message (p. ej. messageContextInfo),
        // omitiendo stickerMessage en la raíz para envolverlo en el campo 134.
        const rest = {};
        for (const key of Object.keys(message)) {
          if (key !== 'stickerMessage') {
            rest[key] = message[key];
          }
        }
        originalEncode(rest, w);

        // Campo 134 (wireType 2): (134 << 3) | 2 = 1074
        w.uint32((FIELD_AUDIO_STICKER_WRAPPER << 3) | 2).fork();
        // FutureProofMessage.message = campo 1 (wireType 2): (1 << 3) | 2 = 10
        w.uint32((FIELD_FUTURE_PROOF_MESSAGE << 3) | 2).fork();
        // Inner Message.stickerMessage = campo 26 (wireType 2): (26 << 3) | 2 = 210
        w.uint32((FIELD_STICKER_MESSAGE << 3) | 2).fork();

        // Campos estándar de StickerMessage
        proto.Message.StickerMessage.encode(sticker, w);

        // Campo 24 (premium = 0, varint): (24 << 3) | 0 = 192
        w.uint32((24 << 3) | 0).int32(0);

        // Campo 25 (emojis, string): (25 << 3) | 2 = 202
        if (pending.emoji) {
          w.uint32((25 << 3) | 2).string(pending.emoji);
        }

        // Campo 26 (StickerMessage.audioMessage, wireType 2): (26 << 3) | 2 = 210
        proto.Message.AudioMessage.encode(
          pending.audioMessage,
          w.uint32((FIELD_STICKER_AUDIO << 3) | 2).fork()
        ).ldelim();

        // Cerramos StickerMessage (26), Inner Message (1) y FutureProofMessage (134)
        w.ldelim().ldelim().ldelim();
        return w;
      }
    }

    return originalEncode(message, w);
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
 * Sube el WebP animado y el audio Ogg/Opus a los servidores multimedia de WhatsApp
 * y envía el mensaje como Sticker con Audio nativo (o sticker animado normal si el video no tenía sonido).
 */
export async function sendSoundSticker(sock, jid, {
  webpBuffer,
  audioBuffer,
  durationMs = 3000,
  width = 512,
  height = 512,
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

  const seconds = Math.max(1, Math.ceil(durationMs / 1000));

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

  audioMessage.streamingSidecar = await createAudioStreamingSidecar(
    audioBuffer,
    audioMessage.mediaKey,
    audioMessage.fileEncSha256
  );

  stickerMessage.isAnimated = true;
  stickerMessage.width = width;
  stickerMessage.height = height;

  const waMsg = generateWAMessageFromContent(
    jid,
    { stickerMessage },
    {
      userJid: sock.user.id,
      quoted,
    }
  );

  const webpSha256B64 = Buffer.from(stickerMessage.fileSha256).toString('base64');
  registerPendingAudioSticker(webpSha256B64, audioMessage, { emoji: '🔊' });

  await sock.relayMessage(jid, waMsg.message, { messageId: waMsg.key.id });
  return { messageId: waMsg.key.id, withAudio: true };
}

/**
 * Decodifica e inspecciona bytes Protobuf crudos de un `proto.Message` para verificar
 * la estructura del campo 134 (`audioStickerMessage`) y el campo 26 (`audioMessage`).
 */
export function inspectSoundStickerWire(bytes) {
  const reader = protobuf.Reader.create(bytes);
  let field134Bytes = null;
  let hasTopLevelSticker = false;

  while (reader.pos < reader.len) {
    const tag = reader.uint32();
    const fieldNo = tag >>> 3;
    const wireType = tag & 7;
    if (fieldNo === FIELD_AUDIO_STICKER_WRAPPER && wireType === 2) {
      field134Bytes = reader.bytes();
    } else if (fieldNo === FIELD_STICKER_MESSAGE && wireType === 2) {
      hasTopLevelSticker = true;
      reader.skipType(wireType);
    } else {
      reader.skipType(wireType);
    }
  }

  if (!field134Bytes) {
    return { hasField134: false, hasTopLevelSticker };
  }

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

  if (!innerMsgBytes) {
    return { hasField134: true, hasTopLevelSticker };
  }

  const rInner = protobuf.Reader.create(innerMsgBytes);
  let stickerBytes = null;
  while (rInner.pos < rInner.len) {
    const tag = rInner.uint32();
    const fieldNo = tag >>> 3;
    const wireType = tag & 7;
    if (fieldNo === FIELD_STICKER_MESSAGE && wireType === 2) {
      stickerBytes = rInner.bytes();
    } else {
      rInner.skipType(wireType);
    }
  }

  if (!stickerBytes) {
    return { hasField134: true, hasTopLevelSticker };
  }

  const sticker = proto.Message.StickerMessage.decode(stickerBytes);
  let premium;
  let emojis;
  let audioMessage;

  const rSticker = protobuf.Reader.create(stickerBytes);
  while (rSticker.pos < rSticker.len) {
    const tag = rSticker.uint32();
    const fieldNo = tag >>> 3;
    const wireType = tag & 7;
    if (fieldNo === 24 && wireType === 0) {
      premium = rSticker.int32();
    } else if (fieldNo === 25 && wireType === 2) {
      emojis = rSticker.string();
    } else if (fieldNo === FIELD_STICKER_AUDIO && wireType === 2) {
      audioMessage = proto.Message.AudioMessage.decode(rSticker.bytes());
    } else {
      rSticker.skipType(wireType);
    }
  }

  return {
    hasField134: true,
    hasTopLevelSticker,
    sticker,
    premium,
    emojis,
    audioMessage,
  };
}
