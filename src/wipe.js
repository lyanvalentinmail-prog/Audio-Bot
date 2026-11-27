import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ROOT, SETTINGS_FILE, SESSIONS_DIR, TMP_DIR, isValidSessionName, loadSettings, resetSettings } from './settings.js';
import { dirUsage } from './sessions.js';

export const WIPE_PRESETS = {
  all: {
    sessions: true,
    settings: true,
    temp: true,
  },
  keepSession: {
    sessions: false,
    settings: true,
    temp: true,
    keepOwners: true,
    keepActiveSession: true,
  },
  settings: {
    settings: true,
  },
  temp: {
    temp: true,
  },
};

const PROTECTED_ROOT_NAMES = new Set([
  '.git',
  'node_modules',
  'src',
  'test',
  'package.json',
  'package-lock.json',
  'index.js',
  'launcher.js',
  'termux-setup.sh',
  'README.md',
  '.gitignore',
  '.env',
  '.env.example',
]);

function isSafeTarget(root, target) {
  const absRoot = path.resolve(root);
  const absTarget = path.resolve(target);
  if (absTarget === absRoot) return false;
  if (!absTarget.startsWith(absRoot + path.sep)) return false;
  const rel = path.relative(absRoot, absTarget);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return false;
  const top = rel.split(path.sep)[0];
  if (PROTECTED_ROOT_NAMES.has(top)) return false;
  return true;
}

function statSize(filePath) {
  try {
    const st = fs.statSync(filePath);
    return st.isFile() ? st.size : 0;
  } catch {
    return 0;
  }
}

function listRootTempFiles(root) {
  const out = [];
  try {
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      if (entry.name.endsWith('.log') || /^settings\.json\.\d+\.tmp$/.test(entry.name)) {
        out.push(path.join(root, entry.name));
      }
    }
  } catch {
    // Ignorar errores de lectura
  }
  return out;
}

export function inspectBotData(root = ROOT) {
  const absRoot = path.resolve(root);
  const sessionsDir = path.join(absRoot, 'sessions');
  const legacyAuthDir = path.join(absRoot, 'auth_info');
  const settingsFile = path.join(absRoot, 'settings.json');
  const tmpDir = path.join(absRoot, 'tmp');
  const logsDir = path.join(absRoot, 'logs');

  const sessionNames = [];
  try {
    for (const entry of fs.readdirSync(sessionsDir, { withFileTypes: true })) {
      if (entry.isDirectory() && isValidSessionName(entry.name)) {
        sessionNames.push(entry.name);
      }
    }
  } catch {
    // Carpeta inexistente
  }

  const sessUsage = dirUsage(sessionsDir);
  const legacyUsage = dirUsage(legacyAuthDir);
  if (legacyUsage.files > 0) sessionNames.push('auth_info (legado)');
  const sessionsBytes = sessUsage.size + legacyUsage.size;
  const sessionsFiles = sessUsage.files + legacyUsage.files;

  const settingsExists = fs.existsSync(settingsFile);
  const settingsBytes = statSize(settingsFile);

  const tmpUsage = dirUsage(tmpDir);
  const logsUsage = dirUsage(logsDir);
  const rootLogs = listRootTempFiles(absRoot);
  let rootLogBytes = 0;
  for (const f of rootLogs) rootLogBytes += statSize(f);
  const tempBytes = tmpUsage.size + logsUsage.size + rootLogBytes;
  const tempFiles = tmpUsage.files + logsUsage.files + rootLogs.length;

  const totalBytes = sessionsBytes + settingsBytes + tempBytes;
  const hasAnyData =
    sessionsFiles > 0 || sessionNames.length > 0 || settingsExists || tempFiles > 0;

  return {
    sessions: {
      exists: sessionsFiles > 0 || sessionNames.length > 0,
      bytes: sessionsBytes,
      files: sessionsFiles,
      count: sessionNames.length,
      names: sessionNames,
    },
    settings: {
      exists: settingsExists,
      bytes: settingsBytes,
    },
    temp: {
      exists: tempFiles > 0,
      bytes: tempBytes,
      files: tempFiles,
    },
    totalBytes,
    hasAnyData,
  };
}

function removeTarget(root, target, label, removed, failed) {
  if (!isSafeTarget(root, target) || !fs.existsSync(target)) return 0;
  let bytes = 0;
  try {
    const st = fs.statSync(target);
    bytes = st.isDirectory() ? dirUsage(target).size : st.size;
  } catch {
    // Ignorar fallo al leer tamaño
  }
  try {
    fs.rmSync(target, { recursive: true, force: true });
    if (fs.existsSync(target)) {
      if (label) failed.push(label);
      return 0;
    }
    if (label && !removed.includes(label)) removed.push(label);
    return bytes;
  } catch {
    if (label) failed.push(label);
    return 0;
  }
}

export function wipeBotData(options = {}, root = ROOT) {
  const absRoot = path.resolve(root);
  const removed = [];
  const failed = [];
  let freedBytes = 0;

  if (options.sessions) {
    freedBytes += removeTarget(absRoot, path.join(absRoot, 'sessions'), 'Sesiones', removed, failed);
    freedBytes += removeTarget(absRoot, path.join(absRoot, 'auth_info'), 'Sesiones', removed, failed);
  }

  if (options.settings) {
    const settingsFile = path.join(absRoot, 'settings.json');
    if (options.keepOwners || options.keepActiveSession) {
      try {
        const current = loadSettings(settingsFile);
        const keep = {};
        if (options.keepOwners) {
          keep.owners = current.owners;
          keep.excludedNumbers = current.excludedNumbers;
          keep.ownerOnly = current.ownerOnly;
        }
        if (options.keepActiveSession) {
          keep.activeSession = current.activeSession;
        }
        resetSettings(keep, settingsFile);
        removed.push('Ajustes (restablecidos)');
      } catch {
        failed.push('Ajustes');
      }
    } else {
      freedBytes += removeTarget(absRoot, settingsFile, 'Ajustes (settings.json)', removed, failed);
    }
  }

  if (options.temp) {
    let tmpRemoved = false;
    for (const dirName of ['tmp', 'logs']) {
      const p = path.join(absRoot, dirName);
      if (fs.existsSync(p)) {
        const before = failed.length;
        freedBytes += removeTarget(absRoot, p, '', removed, failed);
        if (failed.length === before) tmpRemoved = true;
      }
    }
    for (const logFile of listRootTempFiles(absRoot)) {
      const before = failed.length;
      freedBytes += removeTarget(absRoot, logFile, '', removed, failed);
      if (failed.length === before) tmpRemoved = true;
    }
    if (tmpRemoved) removed.push('Caché y registros');
  }

  return {
    ok: failed.length === 0,
    removed: removed.filter(Boolean),
    failed: Array.from(new Set(failed.filter(Boolean))),
    freedBytes,
  };
}

export function collectSystemStats() {
  const sess = dirUsage(SESSIONS_DIR);
  const tmp = dirUsage(TMP_DIR);
  const project = dirUsage(ROOT, new Set(['node_modules', '.git', 'sessions', 'auth_info', 'tmp']));
  const memTotal = os.totalmem();
  const memFree = os.freemem();

  let diskTotal = 0;
  let diskFree = 0;
  try {
    if (typeof fs.statfsSync === 'function') {
      const st = fs.statfsSync(ROOT);
      diskTotal = st.bsize * st.blocks;
      diskFree = st.bsize * st.bavail;
    }
  } catch {
    // En plataformas sin statfsSync omitimos barra de disco
  }

  return {
    storage: {
      sessions: sess.size,
      temp: tmp.size,
      project: project.size,
      settings: fs.existsSync(SETTINGS_FILE) ? statSize(SETTINGS_FILE) : 0,
      diskTotal,
      diskFree,
    },
    system: {
      memTotal,
      memUsed: Math.max(0, memTotal - memFree),
      load: os.loadavg()[0] || 0,
      cpus: os.cpus()?.length || 1,
      node: process.version,
      platform: `${os.platform()} ${os.arch()}`,
    },
  };
}
