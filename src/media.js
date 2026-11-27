import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { injectWebpExif, inspectWebp } from './exif.js';

/**
 * Escalera de compresión WebP ordenada de mayor a menor calidad/resolución:
 * [dimension_trabajo, calidad_webp, fps]
 * Si la dimensión es menor a 512, se escala hacia abajo para reducir detalle y luego a 512x512
 * para cumplir siempre con el lienzo estándar de stickers de WhatsApp.
 */
export const WEBP_LADDER = [
  [512, 60, 15],
  [512, 48, 12],
  [384, 50, 12],
  [384, 38, 10],
  [320, 35, 10],
  [256, 30, 8],
  [256, 20, 6],
];

export function runProcess(bin, args, timeoutMs = 120_000) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        if (err.code === 'ENOENT') {
          reject(
            new Error(
              `No se encontró "${bin}". En Termux instálalo con: pkg install ffmpeg`
            )
          );
          return;
        }
        const detail = (stderr || err.message || '').trim();
        reject(new Error(`${bin} falló: ${detail}`));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

/**
 * Verifica que ffmpeg esté disponible en el entorno.
 */
export async function checkFfmpeg(ffmpegBin = 'ffmpeg') {
  await runProcess(ffmpegBin, ['-version'], 15_000);
}

/**
 * Analiza el archivo multimedia usando ffprobe (o ffmpeg como respaldo si ffprobe no está).
 */
export async function probeMedia(filePath, ffprobeBin = 'ffprobe', ffmpegBin = 'ffmpeg') {
  try {
    const { stdout } = await runProcess(ffprobeBin, [
      '-v', 'error',
      '-show_entries', 'stream=codec_type,codec_name,width,height,duration',
      '-show_entries', 'format=duration',
      '-of', 'json',
      filePath,
    ]);
    const parsed = JSON.parse(stdout);
    const streams = parsed.streams || [];
    const hasVideo = streams.some((s) => s.codec_type === 'video');
    const hasAudio = streams.some((s) => s.codec_type === 'audio');
    const streamDur = streams
      .map((s) => parseFloat(s.duration || '0'))
      .find((d) => Number.isFinite(d) && d > 0);
    const formatDur = parseFloat(parsed.format?.duration || '0');
    const duration =
      (Number.isFinite(formatDur) && formatDur > 0 ? formatDur : streamDur) || 0;
    return { hasVideo, hasAudio, duration, streams };
  } catch {
    // Respaldo con `ffmpeg -i` por si ffprobe no estuviese disponible
    const info = await new Promise((resolve) => {
      execFile(ffmpegBin, ['-hide_banner', '-i', filePath], { timeout: 20_000 }, (_err, stdout, stderr) => {
        resolve(`${stdout || ''}\n${stderr || ''}`);
      });
    });
    const hasVideo = /Stream #\d+:\d+.*Video:/i.test(info);
    const hasAudio = /Stream #\d+:\d+.*Audio:/i.test(info);
    const durMatch = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/i.exec(info);
    let duration = 0;
    if (durMatch) {
      duration =
        Number(durMatch[1]) * 3600 +
        Number(durMatch[2]) * 60 +
        Number(durMatch[3]);
    }
    return { hasVideo, hasAudio, duration, streams: [] };
  }
}

function buildVideoFilter(detailSize, fps, fit = 'crop') {
  const steps = [`fps=${fps}`];

  if (fit === 'contain') {
    // Modo completo con bordes transparentes en 512x512
    steps.push(
      `scale=${detailSize}:${detailSize}:force_original_aspect_ratio=decrease:flags=lanczos`
    );
    if (detailSize < 512) {
      steps.push(`scale=512:512:force_original_aspect_ratio=decrease:flags=bicubic`);
    }
    steps.push(
      'format=rgba',
      'pad=512:512:(ow-iw)/2:(oh-ih)/2:color=black@0',
      'format=yuva420p',
      'setsar=1'
    );
  } else {
    // Modo recorte cuadrado centrado (512x512 completo sin bordes)
    steps.push(
      `scale=${detailSize}:${detailSize}:force_original_aspect_ratio=increase:flags=lanczos`,
      `crop=${detailSize}:${detailSize}`
    );
    if (detailSize < 512) {
      steps.push('scale=512:512:flags=bicubic');
    }
    steps.push('format=yuv420p', 'setsar=1');
  }

  return steps.join(',');
}

/**
 * Convierte un video a WebP animado 512x512 ajustando automáticamente calidad/FPS
 * para mantenerse dentro de `maxBytes` e inyecta los metadatos EXIF de WhatsApp.
 */
export async function videoToAnimatedWebp(inputPath, outputPath, options = {}) {
  const {
    maxSeconds = 10,
    maxBytes = 900_000,
    exifPayload = null,
    fit = 'crop',
    ffmpegBin = 'ffmpeg',
  } = options;

  const trimArgs = maxSeconds > 0 ? ['-t', String(maxSeconds)] : [];

  for (const [detailSize, quality, fps] of WEBP_LADDER) {
    const vf = buildVideoFilter(detailSize, fps, fit);
    await runProcess(ffmpegBin, [
      '-y',
      '-v', 'error',
      '-i', inputPath,
      ...trimArgs,
      '-vf', vf,
      '-loop', '0',
      '-c:v', 'libwebp',
      '-lossless', '0',
      '-q:v', String(quality),
      '-compression_level', '4',
      '-preset', 'default',
      '-an',
      '-f', 'webp',
      outputPath,
    ]);

    const rawBuf = await fs.readFile(outputPath);
    const stampedBuf = exifPayload
      ? injectWebpExif(rawBuf, exifPayload, { width: 512, height: 512 })
      : rawBuf;

    if (stampedBuf.length <= maxBytes) {
      const info = inspectWebp(stampedBuf);
      return {
        buffer: stampedBuf,
        width: info.width || 512,
        height: info.height || 512,
        durationMs: info.durationMs,
        firstFrameLength: info.firstFrameLength,
        animated: info.animated || info.frames > 1,
        quality,
        fps,
      };
    }
  }

  throw new Error(
    `El sticker animado supera el límite de ${Math.round(maxBytes / 1024)} KB incluso en la compresión máxima. Prueba con un video más corto.`
  );
}

/**
 * Calcula una forma de onda visual de 64 barras (0..100) a partir de muestras PCM s16le mono.
 * WhatsApp utiliza estas 64 barras para mostrar el indicador/onda de sonido del sticker y en notas de voz.
 */
export function waveformFromPcm(pcmBuf, bars = 64) {
  const buf = Buffer.isBuffer(pcmBuf) ? pcmBuf : Buffer.from(pcmBuf || []);
  const totalSamples = Math.floor(buf.length / 2);
  if (totalSamples === 0) {
    return new Uint8Array(bars);
  }

  const rmsLevels = new Float64Array(bars);
  let peak = 0;

  for (let bar = 0; bar < bars; bar++) {
    const start = Math.floor((bar * totalSamples) / bars);
    const end = Math.max(start + 1, Math.floor(((bar + 1) * totalSamples) / bars));
    let sumSq = 0;
    let count = 0;
    for (let i = start; i < Math.min(end, totalSamples); i++) {
      const sample = buf.readInt16LE(i * 2);
      sumSq += sample * sample;
      count++;
    }
    const rms = count > 0 ? Math.sqrt(sumSq / count) : 0;
    rmsLevels[bar] = rms;
    if (rms > peak) peak = rms;
  }

  const waveform = new Uint8Array(bars);
  if (peak > 0) {
    for (let i = 0; i < bars; i++) {
      waveform[i] = Math.max(0, Math.min(100, Math.round((rmsLevels[i] / peak) * 100)));
    }
  }
  return waveform;
}

/**
 * Extrae la pista de audio del video en formato Ogg/Opus mono 48 kHz + su forma de onda (waveform)
 * de 64 barras compatible con el indicador visual y reproductor nativo de Stickers con Audio de WhatsApp.
 */
export async function videoToStickerOpus(inputPath, outputPath, options = {}) {
  const { maxSeconds = 10, ffmpegBin = 'ffmpeg' } = options;
  const pcmPath = `${outputPath}.pcm`;

  // Dejar el audio apenas ~0.05s más corto que el tope absorbe el padding final de Opus
  const effectiveMax = maxSeconds > 0.2 ? Math.max(0.2, maxSeconds - 0.05) : maxSeconds;
  const trimArgs = effectiveMax > 0 ? ['-t', effectiveMax.toFixed(3)] : [];

  try {
    await runProcess(ffmpegBin, [
      '-y',
      '-v', 'error',
      '-i', inputPath,
      // Salida 1: Ogg/Opus mono 48 kHz
      ...trimArgs,
      '-map', '0:a:0',
      '-vn',
      '-sn',
      '-dn',
      '-ac', '1',
      '-ar', '48000',
      '-af', 'aresample=48000:first_pts=0,afade=t=in:st=0:d=0.02',
      '-c:a', 'libopus',
      '-b:a', '48k',
      '-vbr', 'on',
      '-application', 'audio',
      '-avoid_negative_ts', 'make_zero',
      '-map_metadata', '-1',
      '-f', 'ogg',
      outputPath,
      // Salida 2: PCM 8 kHz s16le para calcular las 64 barras del waveform visual
      ...trimArgs,
      '-map', '0:a:0',
      '-vn',
      '-ac', '1',
      '-ar', '8000',
      '-c:a', 'pcm_s16le',
      '-f', 's16le',
      pcmPath,
    ]);

    const [oggBuf, pcmBuf] = await Promise.all([
      fs.readFile(outputPath),
      fs.readFile(pcmPath).catch(() => Buffer.alloc(0)),
    ]);

    if (!oggBuf.length) {
      throw new Error('La pista de audio generada está vacía.');
    }

    const waveform = waveformFromPcm(pcmBuf, 64);
    return { audioBuffer: oggBuf, waveform };
  } finally {
    await fs.unlink(pcmPath).catch(() => {});
  }
}

/**
 * Pipeline completo: convierte un Buffer de video en WebP animado + pista Ogg/Opus + waveform.
 */
export async function convertVideoBufferToSoundSticker(videoBuffer, options = {}) {
  const {
    tmpDir,
    jobId = `job_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    maxSeconds = 10,
    maxWebpBytes = 900_000,
    exifPayload = null,
    fit = 'crop',
    ffmpegBin = 'ffmpeg',
    ffprobeBin = 'ffprobe',
  } = options;

  await fs.mkdir(tmpDir, { recursive: true });
  const safeId = jobId.replace(/[^a-zA-Z0-9_-]/g, '_');
  const inFile = path.join(tmpDir, `${safeId}.mp4`);
  const webpFile = path.join(tmpDir, `${safeId}.webp`);
  const oggFile = path.join(tmpDir, `${safeId}.ogg`);

  try {
    await fs.writeFile(inFile, videoBuffer);
    const probe = await probeMedia(inFile, ffprobeBin, ffmpegBin);
    if (!probe.hasVideo) {
      throw new Error('El archivo recibido no contiene una pista de video válida.');
    }

    const clipDuration =
      probe.duration > 0
        ? Math.min(probe.duration, maxSeconds > 0 ? maxSeconds : probe.duration)
        : maxSeconds;

    const webpResult = await videoToAnimatedWebp(inFile, webpFile, {
      maxSeconds,
      maxBytes: maxWebpBytes,
      exifPayload,
      fit,
      ffmpegBin,
    });

    const targetAudioSeconds =
      webpResult.durationMs > 0
        ? Math.min(maxSeconds > 0 ? maxSeconds : webpResult.durationMs / 1000, webpResult.durationMs / 1000)
        : clipDuration;

    const audioResult = probe.hasAudio
      ? await videoToStickerOpus(inFile, oggFile, {
          maxSeconds: targetAudioSeconds,
          ffmpegBin,
        }).catch(() => null)
      : null;

    const audioBuffer = audioResult?.audioBuffer || null;
    const waveform = audioResult?.waveform || null;

    const durationMs =
      webpResult.durationMs > 0
        ? webpResult.durationMs
        : Math.round(Math.max(1, clipDuration) * 1000);

    return {
      webpBuffer: webpResult.buffer,
      audioBuffer,
      waveform,
      hasAudio: Boolean(audioBuffer && audioBuffer.length > 0),
      durationMs,
      firstFrameLength: webpResult.firstFrameLength,
      width: webpResult.width,
      height: webpResult.height,
      animated: webpResult.animated,
    };
  } finally {
    await Promise.allSettled([
      fs.unlink(inFile),
      fs.unlink(webpFile),
      fs.unlink(oggFile),
    ]);
  }
}
