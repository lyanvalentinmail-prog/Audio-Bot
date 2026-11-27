import { downloadContentFromMessage } from '@whiskeysockets/baileys';
import { buildStickerExif, readWebpExif } from './exif.js';
import { convertVideoBufferToSoundSticker } from './media.js';
import {
  downloadSoundFromSticker,
  formatWaveformBars,
  getEmbeddedStickerAudio,
  sendSoundSticker,
} from './soundSticker.js';

const INSPECT_ALIASES = new Set(['.audio', '.sonido', '.veraudio']);

/**
 * Desenvuelve envoltorios comunes de WhatsApp (mensajes temporales, ver una vez, documentos con leyenda, campo 134, etc.)
 */
export function unwrapMessage(message) {
  let current = message;
  for (let i = 0; i < 7 && current; i++) {
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
    } else if (current.audioStickerMessage?.message) {
      current = current.audioStickerMessage.message;
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
 * Extrae el texto del mensaje y comprueba si invoca:
 * - `.s2` (crear sticker con audio desde video, o ver el sonido si responde a un sticker)
 *   - `.s2 full` / `.s2 completo` para no recortar bordes
 *   - `.s2 ver` / `.s2 audio` para además adjuntar vista previa reproducible del sonido
 * - `.audio` / `.sonido` / `.veraudio` (ver la onda de sonido, metadatos y escuchar el audio de un sticker)
 */
export function parseCommandRequest(
  rawMessage,
  commandTrigger = '.s2',
  audioCommandTrigger = '.audio'
) {
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
  const mainTrigger = commandTrigger.toLowerCase();
  const inspectTriggers = new Set([
    ...INSPECT_ALIASES,
    (audioCommandTrigger || '.audio').toLowerCase(),
  ]);

  const isMainCmd = cmd === mainTrigger;
  const isInspectCmd = inspectTriggers.has(cmd);

  if (!isMainCmd && !isInspectCmd) {
    return null;
  }

  const argsText = parts.slice(1).join(' ').toLowerCase();
  const fit = /\b(full|completo|entero|contain)\b/.test(argsText) ? 'contain' : 'crop';
  const showSoundPreview = /\b(ver|audio|sonido|onda)\b/.test(argsText);

  const contextInfo =
    msg.extendedTextMessage?.contextInfo ||
    msg.videoMessage?.contextInfo ||
    msg.documentMessage?.contextInfo ||
    msg.stickerMessage?.contextInfo;

  const quoted = unwrapMessage(contextInfo?.quotedMessage);
  const quotedSticker = quoted?.stickerMessage || null;

  // Comando dedicado a ver/extraer el sonido de un sticker (.audio / .sonido / .veraudio)
  if (isInspectCmd) {
    return {
      hasCommand: true,
      action: 'inspect_sound',
      mediaNode: quotedSticker || msg.stickerMessage || null,
      mediaKind: quotedSticker || msg.stickerMessage ? 'sticker' : null,
      fit,
      showSoundPreview: true,
    };
  }

  // 1) Video adjunto directamente en el mismo mensaje con caption `.s2`
  if (msg.videoMessage) {
    return {
      hasCommand: true,
      action: 'create_sticker',
      mediaNode: msg.videoMessage,
      mediaKind: 'video',
      fit,
      showSoundPreview,
    };
  }

  // 2) Video enviado como documento con caption `.s2`
  if (isVideoDocument(msg.documentMessage)) {
    return {
      hasCommand: true,
      action: 'create_sticker',
      mediaNode: msg.documentMessage,
      mediaKind: 'document',
      fit,
      showSoundPreview,
    };
  }

  // 3) Respuesta (reply) a un mensaje previo que contiene un video o documento de video
  if (quoted?.videoMessage) {
    return {
      hasCommand: true,
      action: 'create_sticker',
      mediaNode: quoted.videoMessage,
      mediaKind: 'video',
      fit,
      showSoundPreview,
    };
  }
  if (isVideoDocument(quoted?.documentMessage)) {
    return {
      hasCommand: true,
      action: 'create_sticker',
      mediaNode: quoted.documentMessage,
      mediaKind: 'document',
      fit,
      showSoundPreview,
    };
  }

  // 4) Si responde `.s2` a un sticker existente, muestra y extrae el sonido de ese sticker
  if (quotedSticker) {
    return {
      hasCommand: true,
      action: 'inspect_sound',
      mediaNode: quotedSticker,
      mediaKind: 'sticker',
      fit,
      showSoundPreview: true,
    };
  }

  // El usuario escribió `.s2` pero no adjuntó ni citó un video ni un sticker
  return {
    hasCommand: true,
    action: 'create_sticker',
    mediaNode: null,
    mediaKind: null,
    fit,
    showSoundPreview,
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

  async handleInspectStickerSound(sock, message, stickerNode) {
    const chatJid = message.key?.remoteJid;
    if (!chatJid) return;

    if (!stickerNode) {
      await sock.sendMessage(
        chatJid,
        {
          text:
            `🔊 *Ver sonido de un sticker*\n\n` +
            `• Responde a cualquier *sticker con audio* escribiendo *${this.config.audioCommand}* (o *.sonido*) para ver su onda de sonido, duración, autor y escuchar su pista de audio.`,
        },
        { quoted: message }
      );
      return;
    }

    await safeReact(sock, message, '🔎');

    try {
      const embeddedAudio = getEmbeddedStickerAudio(stickerNode);
      let exifMeta = null;
      try {
        const webpBuf = await downloadMediaToBuffer(stickerNode, 'sticker');
        exifMeta = readWebpExif(webpBuf);
      } catch {
        // Si el WebP ya expiró en CDN igual intentamos leer el audio
      }

      const packName = exifMeta?.['sticker-pack-name'] || 'Sin descripción';
      const packAuthor = exifMeta?.['sticker-pack-publisher'] || 'Desconocido';

      if (!embeddedAudio) {
        await safeReact(sock, message, 'ℹ️');
        await sock.sendMessage(
          chatJid,
          {
            text:
              `🔇 *Este sticker no tiene pista de sonido*\n\n` +
              `📦 *Descripción:* ${packName}\n` +
              `✍️ *Autor:* ${packAuthor}\n` +
              `🎞️ *Animado:* ${stickerNode.isAnimated ? 'Sí' : 'No'}`,
          },
          { quoted: message }
        );
        return;
      }

      const { audioBuffer, audioMessage } = await downloadSoundFromSticker(embeddedAudio);
      const seconds = Number(audioMessage.seconds || 1);
      const sizeKb = Math.max(1, Math.round(audioBuffer.length / 1024));
      const mime = audioMessage.mimetype || 'audio/ogg; codecs=opus';
      const bars = formatWaveformBars(audioMessage.waveform, 24);
      const wfBytes =
        audioMessage.waveform && audioMessage.waveform.length > 0
          ? Uint8Array.from(audioMessage.waveform)
          : new Uint8Array(64).fill(50);

      await sock.sendMessage(
        chatJid,
        {
          text:
            `🔊 *Sonido del Sticker*\n\n` +
            `📊 *Onda:* \`${bars}\`\n` +
            `⏱️ *Duración:* ${seconds}s (${sizeKb} KB)\n` +
            `🎵 *Formato:* ${mime}\n` +
            `📦 *Descripción:* ${packName}\n` +
            `✍️ *Autor:* ${packAuthor}`,
        },
        { quoted: message }
      );

      await sock.sendMessage(
        chatJid,
        {
          audio: audioBuffer,
          mimetype: 'audio/ogg; codecs=opus',
          ptt: true,
          seconds,
          waveform: wfBytes,
        },
        { quoted: message }
      );

      await safeReact(sock, message, '🔊');
    } catch (err) {
      await safeReact(sock, message, '❌');
      await sock.sendMessage(
        chatJid,
        {
          text: `❌ No se pudo extraer el sonido del sticker:\n${err?.message || 'Error desconocido'}`,
        },
        { quoted: message }
      );
    }
  }

  async handleJob(sock, message, parsedRequest) {
    const chatJid = message.key?.remoteJid;
    if (!chatJid) return;

    if (parsedRequest.action === 'inspect_sound') {
      await this.handleInspectStickerSound(sock, message, parsedRequest.mediaNode);
      return;
    }

    if (!parsedRequest.mediaNode) {
      await sock.sendMessage(
        chatJid,
        {
          text:
            `🎬 *Uso del comando ${this.config.command}*\n\n` +
            `• Envía un *video* con el texto *${this.config.command}* en el comentario, o\n` +
            `• Responde a un *video* escribiendo *${this.config.command}*\n\n` +
            `🔊 *Ver sonido de un sticker:*\n` +
            `• Toca el botón *🔊* en la esquina del sticker en WhatsApp, o\n` +
            `• Responde al sticker con *${this.config.audioCommand}* (o *.sonido*) para ver su onda y escuchar el audio aparte.\n\n` +
            `💡 _Opciones:_ *${this.config.command} full* (sin recortar bordes) | *${this.config.command} ver* (envía también la nota de audio visible).`,
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
        waveform: converted.waveform,
        durationMs: converted.durationMs,
        firstFrameLength: converted.firstFrameLength,
        width: converted.width,
        height: converted.height,
        sendAudioPreview: Boolean(parsedRequest.showSoundPreview),
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
