import { downloadContentFromMessage } from '@whiskeysockets/baileys';
import { buildStickerExif } from './exif.js';
import { convertVideoBufferToSoundSticker } from './media.js';
import { sendSoundSticker } from './soundSticker.js';

/**
 * Desenvuelve envoltorios comunes de WhatsApp (mensajes temporales, ver una vez, documentos con leyenda, etc.)
 */
export function unwrapMessage(message) {
  let current = message;
  for (let i = 0; i < 6 && current; i++) {
    if (current.ephemeralMessage?.message) {
      current = current.ephemeralMessage.message;
    } else if (current.viewOnceMessage?.message) {
      current = current.viewOnceMessage.message;
    } else if (current.viewOnceMessageV2?.message) {
      current = current.viewOnceMessageV2.message;
    } else if (current.viewOnceMessageV2Extension?.message) {
      current = current.viewOnceMessageV2Extension.message;
    } else if (current.documentWithCaptionMessage?.message) {
      current = current.documentWithCaptionMessage.message;
    } else if (current.editedMessage?.message?.protocolMessage?.editedMessage) {
      current = current.editedMessage.message.protocolMessage.editedMessage;
    } else {
      break;
    }
  }
  return current;
}

function isVideoDocument(docMsg) {
  if (!docMsg) return false;
  const mime = (docMsg.mimetype || '').toLowerCase();
  const name = (docMsg.fileName || '').toLowerCase();
  return (
    mime.startsWith('video/') ||
    /\.(mp4|mov|mkv|webm|avi|3gp|m4v)$/i.test(name)
  );
}

/**
 * Extrae el texto del mensaje y comprueba si invoca el comando `.s2`
 * (admite modificadores opcionales como `.s2 full` / `.s2 completo` para no recortar bordes).
 */
export function parseCommandRequest(rawMessage, commandTrigger = '.s2') {
  const msg = unwrapMessage(rawMessage);
  if (!msg) return null;

  const rawText = (
    msg.videoMessage?.caption ||
    msg.documentMessage?.caption ||
    msg.extendedTextMessage?.text ||
    msg.conversation ||
    ''
  ).trim();

  if (!rawText) return null;

  const parts = rawText.split(/\s+/);
  const cmd = parts[0].toLowerCase();
  if (cmd !== commandTrigger.toLowerCase()) {
    return null;
  }

  const argsText = parts.slice(1).join(' ').toLowerCase();
  const fit = /\b(full|completo|entero|contain)\b/.test(argsText) ? 'contain' : 'crop';

  // 1) Video adjunto directamente en el mismo mensaje con caption `.s2`
  if (msg.videoMessage) {
    return {
      hasCommand: true,
      mediaNode: msg.videoMessage,
      mediaKind: 'video',
      fit,
    };
  }

  // 2) Video enviado como documento con caption `.s2`
  if (isVideoDocument(msg.documentMessage)) {
    return {
      hasCommand: true,
      mediaNode: msg.documentMessage,
      mediaKind: 'document',
      fit,
    };
  }

  // 3) Respuesta (reply) a un mensaje previo que contiene un video o documento de video
  const contextInfo =
    msg.extendedTextMessage?.contextInfo ||
    msg.videoMessage?.contextInfo ||
    msg.documentMessage?.contextInfo;

  const quoted = unwrapMessage(contextInfo?.quotedMessage);
  if (quoted?.videoMessage) {
    return {
      hasCommand: true,
      mediaNode: quoted.videoMessage,
      mediaKind: 'video',
      fit,
    };
  }
  if (isVideoDocument(quoted?.documentMessage)) {
    return {
      hasCommand: true,
      mediaNode: quoted.documentMessage,
      mediaKind: 'document',
      fit,
    };
  }

  // El usuario escribió `.s2` pero no adjuntó ni citó un video
  return {
    hasCommand: true,
    mediaNode: null,
    mediaKind: null,
    fit,
  };
}

async function downloadMediaToBuffer(mediaNode, mediaKind = 'video') {
  const stream = await downloadContentFromMessage(mediaNode, mediaKind);
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function safeReact(sock, message, emoji) {
  try {
    await sock.sendMessage(message.key.remoteJid, {
      react: { text: emoji, key: message.key },
    });
  } catch {
    // Ignorar errores de reacción si el chat no lo permite
  }
}

/**
 * Cola secuencial para procesar conversiones FFmpeg de una en una sin saturar la CPU/RAM en Termux.
 */
export class CommandQueue {
  constructor(config) {
    this.config = config;
    this.queue = [];
    this.busy = false;
    this.exifPayload = buildStickerExif({
      pack: config.stickerPack,
      author: config.stickerAuthor,
      emojis: ['🔊'],
    });
  }

  enqueue(sock, message, parsedRequest) {
    this.queue.push({ sock, message, parsedRequest });
    this.pump();
  }

  async pump() {
    if (this.busy) return;
    const next = this.queue.shift();
    if (!next) return;

    this.busy = true;
    try {
      await this.handleJob(next.sock, next.message, next.parsedRequest);
    } finally {
      this.busy = false;
      this.pump();
    }
  }

  async handleJob(sock, message, parsedRequest) {
    const chatJid = message.key?.remoteJid;
    if (!chatJid) return;

    if (!parsedRequest.mediaNode) {
      await sock.sendMessage(
        chatJid,
        {
          text:
            `🎬 *Uso del comando ${this.config.command}*\n\n` +
            `• Envía un *video* con el texto *${this.config.command}* en el comentario, o\n` +
            `• Responde a un *video* escribiendo *${this.config.command}*\n\n` +
            `💡 _Opcional:_ escribe *${this.config.command} full* para mantener bordes completos sin recortar a cuadrado.`,
        },
        { quoted: message }
      );
      return;
    }

    const msgId = message.key?.id || `msg_${Date.now()}`;
    console.log(`[.s2] Procesando video (${msgId}) de ${chatJid}...`);
    await safeReact(sock, message, '⏳');

    try {
      const videoBuffer = await downloadMediaToBuffer(
        parsedRequest.mediaNode,
        parsedRequest.mediaKind
      );

      if (!videoBuffer.length) {
        throw new Error('No se pudo descargar el video o está vacío.');
      }

      const converted = await convertVideoBufferToSoundSticker(videoBuffer, {
        tmpDir: this.config.tmpDir,
        jobId: msgId,
        maxSeconds: this.config.maxSeconds,
        maxWebpBytes: this.config.maxWebpBytes,
        exifPayload: this.exifPayload,
        fit: parsedRequest.fit,
        ffmpegBin: this.config.ffmpegBin,
        ffprobeBin: this.config.ffprobeBin,
      });

      const sent = await sendSoundSticker(sock, chatJid, {
        webpBuffer: converted.webpBuffer,
        audioBuffer: converted.audioBuffer,
        durationMs: converted.durationMs,
        width: converted.width,
        height: converted.height,
        quoted: message,
      });

      await safeReact(sock, message, '✅');
      console.log(
        `[.s2] Sticker enviado (${sent.messageId}) | audio=${sent.withAudio ? 'sí' : 'sin pista de audio'} | webp=${Math.round(converted.webpBuffer.length / 1024)}KB`
      );
    } catch (err) {
      console.error(`[.s2] Error en ${msgId}:`, err?.message || err);
      await safeReact(sock, message, '❌');
      try {
        await sock.sendMessage(
          chatJid,
          {
            text: `❌ No se pudo convertir el video a sticker con audio:\n${err?.message || 'Error desconocido'}`,
          },
          { quoted: message }
        );
      } catch {
        // Ignorar fallos secundarios al reportar error
      }
    }
  }
}
