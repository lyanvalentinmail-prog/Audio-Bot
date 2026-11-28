import { downloadContentFromMessage } from '@whiskeysockets/baileys';
import { buildStickerExif, readWebpExif } from './exif.js';
import { convertVideoBufferToSoundSticker } from './media.js';
import { downloadPinterestVideoBuffer, extractPinterestUrl } from './pinterest.js';
import { loadSettings } from './settings.js';
import {
  downloadSoundFromSticker,
  formatWaveformBars,
  getEmbeddedStickerAudio,
  sendSoundSticker,
} from './soundSticker.js';
import { downloadTikTokVideoBuffer, extractTikTokUrl } from './tiktok.js';

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

function extractMessageText(msg) {
  if (!msg) return '';
  return (
    msg.videoMessage?.caption ||
    msg.imageMessage?.caption ||
    msg.documentMessage?.caption ||
    msg.extendedTextMessage?.text ||
    msg.conversation ||
    ''
  ).trim();
}

/**
 * Extrae el texto del mensaje y comprueba si invoca:
 * - `.s2` (crear sticker con audio desde video adjunto/citado o desde un enlace de TikTok / Pinterest, o ver el sonido si responde a un sticker)
 *   - `.s2 full` / `.s2 completo` para eliminar bordes negros y mantener el video completo con margen transparente
 *   - `.s2 <enlace de TikTok o Pinterest>` (o responder `.s2` a un mensaje con enlace) para descargarlo y hacerlo sticker con audio
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

  const rawText = extractMessageText(msg);
  if (!rawText) return null;

  const parts = rawText.split(/\s+/);
  const cmd = parts[0].toLowerCase();
  const mainTrigger = commandTrigger.toLowerCase();
  const pfx = Array.from(mainTrigger)[0] || '.';
  const inspectTriggers = new Set([
    ...INSPECT_ALIASES,
    `${pfx}audio`,
    `${pfx}sonido`,
    `${pfx}veraudio`,
    (audioCommandTrigger || '.audio').toLowerCase(),
  ]);

  const isMainCmd = cmd === mainTrigger;
  const isInspectCmd = inspectTriggers.has(cmd);

  if (!isMainCmd && !isInspectCmd) {
    return null;
  }

  const restRaw = parts.slice(1).join(' ');
  // Quitamos las URLs de TikTok/Pinterest antes de evaluar palabras clave para que palabras en el link no activen flags por accidente
  const directTikTokUrl = extractTikTokUrl(restRaw);
  const directPinterestUrl = directTikTokUrl ? null : extractPinterestUrl(restRaw);
  const flagsText = restRaw
    .replace(directTikTokUrl || '', ' ')
    .replace(directPinterestUrl || '', ' ')
    .toLowerCase();

  const fit = /\b(full|completo|entero|contain)\b/.test(flagsText) ? 'full' : 'crop';
  const showSoundPreview = /\b(ver|audio|sonido|onda)\b/.test(flagsText);

  const contextInfo =
    msg.extendedTextMessage?.contextInfo ||
    msg.videoMessage?.contextInfo ||
    msg.documentMessage?.contextInfo ||
    msg.stickerMessage?.contextInfo;

  const quoted = unwrapMessage(contextInfo?.quotedMessage);
  const quotedSticker = quoted?.stickerMessage || null;
  const quotedText = extractMessageText(quoted);
  const quotedTikTokUrl = extractTikTokUrl(quotedText);
  const quotedPinterestUrl = quotedTikTokUrl ? null : extractPinterestUrl(quotedText);

  // Comando dedicado a ver/extraer el sonido de un sticker (.audio / .sonido / .veraudio)
  if (isInspectCmd) {
    return {
      hasCommand: true,
      action: 'inspect_sound',
      mediaNode: quotedSticker || msg.stickerMessage || null,
      mediaKind: quotedSticker || msg.stickerMessage ? 'sticker' : null,
      tiktokUrl: null,
      pinterestUrl: null,
      fit,
      showSoundPreview: true,
    };
  }

  // 1) Enlace de TikTok pasado directamente junto al comando: `.s2 https://vm.tiktok.com/...`
  if (directTikTokUrl) {
    return {
      hasCommand: true,
      action: 'create_sticker',
      mediaNode: null,
      mediaKind: 'tiktok',
      tiktokUrl: directTikTokUrl,
      pinterestUrl: null,
      fit,
      showSoundPreview,
    };
  }

  // 1b) Enlace de Pinterest pasado directamente junto al comando: `.s2 https://pin.it/...` o `https://pinterest.com/pin/...`
  if (directPinterestUrl) {
    return {
      hasCommand: true,
      action: 'create_sticker',
      mediaNode: null,
      mediaKind: 'pinterest',
      tiktokUrl: null,
      pinterestUrl: directPinterestUrl,
      fit,
      showSoundPreview,
    };
  }

  // 2) Video adjunto directamente en el mismo mensaje con caption `.s2`
  if (msg.videoMessage) {
    return {
      hasCommand: true,
      action: 'create_sticker',
      mediaNode: msg.videoMessage,
      mediaKind: 'video',
      tiktokUrl: null,
      pinterestUrl: null,
      fit,
      showSoundPreview,
    };
  }

  // 3) Video enviado como documento con caption `.s2`
  if (isVideoDocument(msg.documentMessage)) {
    return {
      hasCommand: true,
      action: 'create_sticker',
      mediaNode: msg.documentMessage,
      mediaKind: 'document',
      tiktokUrl: null,
      pinterestUrl: null,
      fit,
      showSoundPreview,
    };
  }

  // 4) Respuesta (reply) a un mensaje previo que contiene un video o documento de video
  if (quoted?.videoMessage) {
    return {
      hasCommand: true,
      action: 'create_sticker',
      mediaNode: quoted.videoMessage,
      mediaKind: 'video',
      tiktokUrl: null,
      pinterestUrl: null,
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
      tiktokUrl: null,
      pinterestUrl: null,
      fit,
      showSoundPreview,
    };
  }

  // 5) Respuesta (reply) con `.s2` a un mensaje que contiene un enlace de TikTok o Pinterest
  if (quotedTikTokUrl) {
    return {
      hasCommand: true,
      action: 'create_sticker',
      mediaNode: null,
      mediaKind: 'tiktok',
      tiktokUrl: quotedTikTokUrl,
      pinterestUrl: null,
      fit,
      showSoundPreview,
    };
  }
  if (quotedPinterestUrl) {
    return {
      hasCommand: true,
      action: 'create_sticker',
      mediaNode: null,
      mediaKind: 'pinterest',
      tiktokUrl: null,
      pinterestUrl: quotedPinterestUrl,
      fit,
      showSoundPreview,
    };
  }

  // 6) Si responde `.s2` a un sticker existente, muestra y extrae el sonido de ese sticker
  if (quotedSticker) {
    return {
      hasCommand: true,
      action: 'inspect_sound',
      mediaNode: quotedSticker,
      mediaKind: 'sticker',
      tiktokUrl: null,
      pinterestUrl: null,
      fit,
      showSoundPreview,
    };
  }

  // El usuario escribió `.s2` pero no adjuntó ni citó un video, enlace de TikTok/Pinterest ni sticker
  return {
    hasCommand: true,
    action: 'create_sticker',
    mediaNode: null,
    mediaKind: null,
    tiktokUrl: null,
    pinterestUrl: null,
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
 * Cola con concurrencia controlada para procesar conversiones FFmpeg rápidamente sin saturar la RAM en Termux.
 */
export class CommandQueue {
  constructor(config, onEvent = null) {
    this.config = config;
    this.onEvent = onEvent;
    this.queue = [];
    this.activeCount = 0;
    this.maxConcurrency = Math.max(1, Number(config?.concurrency) || 2);
    this.cachedExifKey = '';
    this.exifPayload = null;
  }

  getExifPayload(pack, author) {
    const p = pack || this.config.stickerPack || 'Made by';
    const a = author || this.config.stickerAuthor || '@Lyan';
    const key = `${p}\u0000${a}`;
    if (this.cachedExifKey !== key || !this.exifPayload) {
      this.cachedExifKey = key;
      this.exifPayload = buildStickerExif({
        pack: p,
        author: a,
        emojis: ['🔊'],
      });
    }
    return this.exifPayload;
  }

  enqueue(sock, message, parsedRequest) {
    this.queue.push({ sock, message, parsedRequest });
    this.pump();
  }

  pump() {
    while (this.activeCount < this.maxConcurrency && this.queue.length > 0) {
      const next = this.queue.shift();
      if (!next) break;
      this.activeCount++;
      this.handleJob(next.sock, next.message, next.parsedRequest).finally(() => {
        this.activeCount--;
        this.pump();
      });
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
      this.onEvent?.('command_executed', { command: this.config.audioCommand });
    } catch (err) {
      this.onEvent?.('handler_error', { error: err?.message || String(err) });
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

    const liveSettings = loadSettings();
    const cmdLabel = `${liveSettings.prefix}s2`;
    const audioCmdLabel = `${liveSettings.prefix}audio`;

    if (parsedRequest.action === 'inspect_sound') {
      await this.handleInspectStickerSound(sock, message, parsedRequest.mediaNode);
      return;
    }

    if (!parsedRequest.mediaNode && !parsedRequest.tiktokUrl && !parsedRequest.pinterestUrl) {
      await sock.sendMessage(
        chatJid,
        {
          text:
            `🎬 *Uso del comando ${cmdLabel}*\n\n` +
            `• Envía un *video* con el texto *${cmdLabel}* en el comentario\n` +
            `• Responde a un *video* escribiendo *${cmdLabel}*\n` +
            `• Pega un enlace de *TikTok*: *${cmdLabel} https://vm.tiktok.com/...*\n` +
            `• Pega un enlace de *Pinterest*: *${cmdLabel} https://pin.it/...*\n\n` +
            `🔊 *Ver sonido de un sticker:*\n` +
            `• Toca el botón *🔊* en la esquina del sticker en WhatsApp, o\n` +
            `• Responde al sticker con *${audioCmdLabel}* (o *${liveSettings.prefix}sonido*) para ver su onda y escuchar el audio aparte.\n\n` +
            `💡 _Opciones:_ *${cmdLabel} full* (elimina bordes negros y mantiene encuadre completo transparente) | *${cmdLabel} ver* (envía también la nota de audio visible).`,
        },
        { quoted: message }
      );
      return;
    }

    const msgId = message.key?.id || `msg_${Date.now()}`;
    const startedAt = Date.now();
    const isTikTok = parsedRequest.mediaKind === 'tiktok' && Boolean(parsedRequest.tiktokUrl);
    const isPinterest =
      parsedRequest.mediaKind === 'pinterest' && Boolean(parsedRequest.pinterestUrl);
    const sourceLabel = isTikTok
      ? `TikTok (${parsedRequest.tiktokUrl})`
      : isPinterest
      ? `Pinterest (${parsedRequest.pinterestUrl})`
      : `video (${msgId})`;
    console.log(`[${cmdLabel}] Procesando ${sourceLabel} de ${chatJid}...`);
    // Lanzamos la reacción en segundo plano sin bloquear el arranque de descarga + FFmpeg
    void safeReact(sock, message, '⏳');

    try {
      let videoBuffer;
      if (isTikTok) {
        const downloaded = await downloadTikTokVideoBuffer(parsedRequest.tiktokUrl);
        videoBuffer = downloaded.buffer;
      } else if (isPinterest) {
        const downloaded = await downloadPinterestVideoBuffer(parsedRequest.pinterestUrl);
        videoBuffer = downloaded.buffer;
      } else {
        videoBuffer = await downloadMediaToBuffer(
          parsedRequest.mediaNode,
          parsedRequest.mediaKind
        );
      }

      if (!videoBuffer?.length) {
        throw new Error('No se pudo descargar el video o está vacío.');
      }

      const converted = await convertVideoBufferToSoundSticker(videoBuffer, {
        tmpDir: this.config.tmpDir,
        jobId: msgId,
        maxSeconds: liveSettings.maxSeconds || this.config.maxSeconds,
        maxWebpBytes: this.config.maxWebpBytes,
        exifPayload: this.getExifPayload(liveSettings.stickerPack, liveSettings.stickerAuthor),
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

      void safeReact(sock, message, '✅');
      this.onEvent?.('command_executed', { command: cmdLabel });
      const originTag = isTikTok ? 'tiktok' : isPinterest ? 'pinterest' : 'video';
      const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(2);
      console.log(
        `[${cmdLabel}] Sticker enviado en ${elapsedSec}s (${sent.messageId}) | origen=${originTag} | fit=${parsedRequest.fit} | audio=${sent.withAudio ? 'sí' : 'sin pista de audio'} | webp=${Math.round(converted.webpBuffer.length / 1024)}KB`
      );
    } catch (err) {
      this.onEvent?.('handler_error', { error: err?.message || String(err) });
      console.error(`[${cmdLabel}] Error en ${msgId}:`, err?.message || err);
      await safeReact(sock, message, '❌');
      const errorSubject = isTikTok
        ? 'el enlace de TikTok'
        : isPinterest
        ? 'el enlace de Pinterest'
        : 'el video';
      try {
        await sock.sendMessage(
          chatJid,
          {
            text: `❌ No se pudo convertir ${errorSubject} a sticker con audio:\n${err?.message || 'Error desconocido'}`,
          },
          { quoted: message }
        );
      } catch {
        // Ignorar fallos secundarios al reportar error
      }
    }
  }
}
