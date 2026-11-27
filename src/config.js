import fs from 'node:fs';
import path from 'node:path';

/**
 * Carga variables desde un archivo .env local sin requerir dependencias adicionales.
 */
export function loadDotEnv(envPath = path.resolve(process.cwd(), '.env')) {
  if (!fs.existsSync(envPath)) return;
  const content = fs.readFileSync(envPath, 'utf8');
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eqIndex = line.indexOf('=');
    if (eqIndex <= 0) continue;
    const key = line.slice(0, eqIndex).trim();
    let value = line.slice(eqIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

function parseBool(val, fallback) {
  if (val === undefined || val === '') return fallback;
  return !['false', '0', 'no', 'off'].includes(String(val).trim().toLowerCase());
}

function parseNumber(val, fallback) {
  const n = Number(val);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

loadDotEnv();

export const config = {
  phoneNumber: (process.env.PHONE_NUMBER || '').replace(/\D/g, ''),
  command: (process.env.COMMAND || '.s2').trim().toLowerCase(),
  audioCommand: (process.env.AUDIO_COMMAND || '.audio').trim().toLowerCase(),
  stickerPack: process.env.STICKER_PACK || 'Made by',
  stickerAuthor: process.env.STICKER_AUTHOR || '@Lyan',
  maxSeconds: parseNumber(process.env.MAX_SECONDS, 10),
  maxWebpBytes: parseNumber(process.env.MAX_WEBP_BYTES, 900_000),
  allowSelf: parseBool(process.env.ALLOW_SELF, true),
  authDir: path.resolve(process.cwd(), process.env.AUTH_DIR || './auth_info'),
  tmpDir: path.resolve(process.cwd(), process.env.TMP_DIR || './tmp'),
  ffmpegBin: process.env.FFMPEG_BIN || 'ffmpeg',
  ffprobeBin: process.env.FFPROBE_BIN || 'ffprobe',
  logLevel: process.env.LOG_LEVEL || 'silent',
};
