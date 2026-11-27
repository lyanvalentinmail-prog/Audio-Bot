import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Ajustes dinámicos de Audio-Bot (guardados en `settings.json`, ignorado por git).
 * El panel TUI de `npm start` los edita al momento y el bot los recarga en caliente
 * sin necesidad de reiniciarlo.
 */

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const SETTINGS_FILE = path.join(ROOT, 'settings.json');
export const SESSIONS_DIR = path.join(ROOT, 'sessions');
export const TMP_DIR = path.join(ROOT, 'tmp');

export const LOG_MODES = ['detallado', 'compacto', 'apagado'];

export function cleanNumber(input) {
  let digits = String(input || '')
    .split('@')[0]
    .split(':')[0]
    .replace(/\D/g, '')
    .trim();
  if (digits.startsWith('0')) digits = digits.replace(/^0+/, '');
  return digits;
}

const stripMexAndArgVariant = (num) => {
  if (num.startsWith('521') && num.length >= 12) return '52' + num.slice(3);
  if (num.startsWith('549') && num.length >= 12) return '54' + num.slice(3);
  return num;
};

/**
 * Compara dos números de teléfono o JIDs tolerando variaciones regionales (`521`/`52`, `549`/`54`).
 */
export function isSamePhoneNumber(a, b) {
  const na = cleanNumber(a);
  const nb = cleanNumber(b);
  if (!na || !nb) return false;
  return na === nb || stripMexAndArgVariant(na) === stripMexAndArgVariant(nb);
}

export function isValidSessionName(name) {
  return typeof name === 'string' && /^[a-zA-Z0-9_-]{1,24}$/.test(name);
}

export function cleanPrefix(value) {
  const trimmed = String(value || '').trim();
  if (!trimmed) return '.';
  return Array.from(trimmed)[0];
}

export const defaultSettings = {
  botName: 'Audio-Bot',
  prefix: '.',
  ownerOnly: false,
  owners: [],
  excludedNumbers: [],
  stickerPack: process.env.STICKER_PACK || 'Made by',
  stickerAuthor: process.env.STICKER_AUTHOR || '@Lyan',
  maxSeconds: Number(process.env.MAX_SECONDS) > 0 ? Number(process.env.MAX_SECONDS) : 10,
  logMode: 'detallado',
  autoRestart: true,
  activeSession: 'principal',
};

let cachedSettings = null;
let cachedMtime = -1;

function sanitizeNumberList(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const item of list) {
    const clean = cleanNumber(item);
    if (clean.length >= 7 && clean.length <= 15 && !out.some((existing) => isSamePhoneNumber(existing, clean))) {
      out.push(clean);
    }
  }
  return out;
}

function normalizeSettings(raw = {}) {
  const s = {
    ...defaultSettings,
    ...(raw && typeof raw === 'object' ? raw : {}),
  };

  s.botName = String(s.botName || defaultSettings.botName).trim().slice(0, 40) || defaultSettings.botName;
  s.prefix = cleanPrefix(s.prefix);
  s.ownerOnly = Boolean(s.ownerOnly);
  s.owners = sanitizeNumberList(s.owners);
  s.excludedNumbers = sanitizeNumberList(s.excludedNumbers);
  s.stickerPack = String(s.stickerPack || defaultSettings.stickerPack).trim().slice(0, 60) || defaultSettings.stickerPack;
  s.stickerAuthor = String(s.stickerAuthor || defaultSettings.stickerAuthor).trim().slice(0, 60) || defaultSettings.stickerAuthor;

  const sec = Number(s.maxSeconds);
  s.maxSeconds = Number.isFinite(sec) && sec >= 2 && sec <= 30 ? Math.round(sec) : defaultSettings.maxSeconds;
  s.logMode = LOG_MODES.includes(s.logMode) ? s.logMode : defaultSettings.logMode;
  s.autoRestart = s.autoRestart !== undefined ? Boolean(s.autoRestart) : true;
  s.activeSession = isValidSessionName(s.activeSession) ? s.activeSession : 'principal';

  return s;
}

export function loadSettings(settingsFile = SETTINGS_FILE) {
  const isDefaultFile = settingsFile === SETTINGS_FILE;
  try {
    if (!fs.existsSync(settingsFile)) {
      const fresh = normalizeSettings({});
      if (isDefaultFile) {
        cachedSettings = fresh;
        cachedMtime = 0;
      }
      return structuredClone(fresh);
    }
    const stat = fs.statSync(settingsFile);
    if (isDefaultFile && cachedSettings && stat.mtimeMs === cachedMtime) {
      return structuredClone(cachedSettings);
    }
    const raw = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    const normalized = normalizeSettings(raw);
    if (isDefaultFile) {
      cachedSettings = normalized;
      cachedMtime = stat.mtimeMs;
    }
    return structuredClone(normalized);
  } catch {
    return normalizeSettings({});
  }
}

export function saveSettings(patch = {}, settingsFile = SETTINGS_FILE) {
  const current = loadSettings(settingsFile);
  const merged = normalizeSettings({ ...current, ...patch });
  const tmpFile = `${settingsFile}.${process.pid}.tmp`;
  fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
  fs.writeFileSync(tmpFile, JSON.stringify(merged, null, 2) + '\n', 'utf8');
  fs.renameSync(tmpFile, settingsFile);
  if (settingsFile === SETTINGS_FILE) {
    try {
      cachedMtime = fs.statSync(settingsFile).mtimeMs;
      cachedSettings = merged;
    } catch {
      cachedSettings = null;
      cachedMtime = -1;
    }
  }
  return structuredClone(merged);
}

export function resetSettings(keep = {}, settingsFile = SETTINGS_FILE) {
  return saveSettings({ ...defaultSettings, ...keep }, settingsFile);
}

export function getActiveSessionDir() {
  if (process.env.AUDIOBOT_SESSION_DIR) {
    return path.resolve(process.env.AUDIOBOT_SESSION_DIR);
  }
  const s = loadSettings();
  return path.join(SESSIONS_DIR, s.activeSession);
}

/**
 * Comprueba si un remitente tiene permiso para usar el bot según los Ajustes actuales:
 * - Los dueños (`owners` o el propio número vinculado del bot `fromMe`/`botNumber`) siempre tienen acceso.
 * - Si `ownerOnly` ("Solo el dueño") está activado -> rechaza a cualquiera que no sea dueño.
 * - Si el número aparece en `excludedNumbers` ("Excluidos") -> bloquea su uso del bot.
 */
export function evaluateSenderAccess({
  senderCandidates = [],
  fromMe = false,
  botNumber = '',
  botLid = '',
  settings = loadSettings(),
} = {}) {
  const candidates = senderCandidates.map(cleanNumber).filter(Boolean);

  const isBotSelf =
    Boolean(fromMe) ||
    (botNumber && candidates.some((num) => isSamePhoneNumber(num, botNumber))) ||
    (botLid && candidates.some((num) => isSamePhoneNumber(num, botLid)));

  const isConfiguredOwner =
    settings.owners.length > 0 &&
    candidates.some((num) => settings.owners.some((owner) => isSamePhoneNumber(num, owner)));

  const isOwner = isBotSelf || isConfiguredOwner;

  if (isOwner) {
    return { allowed: true, isOwner: true, reason: null };
  }

  if (settings.ownerOnly) {
    return { allowed: false, isOwner: false, reason: 'owner_only' };
  }

  const isExcluded =
    settings.excludedNumbers.length > 0 &&
    candidates.some((num) =>
      settings.excludedNumbers.some((blocked) => isSamePhoneNumber(num, blocked))
    );

  if (isExcluded) {
    return { allowed: false, isOwner: false, reason: 'excluded' };
  }

  return { allowed: true, isOwner: false, reason: null };
}
