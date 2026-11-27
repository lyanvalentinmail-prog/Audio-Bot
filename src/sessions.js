import fs from 'node:fs';
import path from 'node:path';
import { ROOT, SESSIONS_DIR, isValidSessionName, loadSettings } from './settings.js';

/**
 * Gestión multisesión para Audio-Bot (`sessions/<nombre>/`).
 * Migra automáticamente cualquier sesión existente en `auth_info/` hacia `sessions/principal/`
 * para no perder la vinculación previa al actualizar.
 */

export function dirUsage(dir, skip = new Set()) {
  const usage = { size: 0, files: 0, modified: 0 };
  const stack = [dir];

  while (stack.length) {
    const current = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (skip.has(entry.name)) continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      try {
        const st = fs.statSync(full);
        usage.size += st.size;
        usage.files++;
        if (st.mtimeMs > usage.modified) usage.modified = st.mtimeMs;
      } catch {
        // Ignorar archivos efímeros eliminados durante el recorrido
      }
    }
  }
  return usage;
}

export const sessionDir = (name) => path.join(SESSIONS_DIR, name);

export function migrateLegacySession() {
  const legacyCandidates = [path.join(ROOT, 'auth_info'), path.join(ROOT, 'Session')];
  const target = sessionDir('principal');
  for (const legacy of legacyCandidates) {
    try {
      if (!fs.existsSync(path.join(legacy, 'creds.json')) || fs.existsSync(target)) {
        continue;
      }
      fs.mkdirSync(SESSIONS_DIR, { recursive: true });
      fs.renameSync(legacy, target);
      return true;
    } catch {
      // Continuar con el siguiente candidato
    }
  }
  return false;
}

export function readSession(name, activeName) {
  const dir = sessionDir(name);
  const info = {
    name,
    dir,
    active: name === (activeName ?? loadSettings().activeSession),
    exists: fs.existsSync(dir),
    registered: false,
    number: '',
    pushName: '',
    files: 0,
    size: 0,
    modified: 0,
  };
  if (!info.exists) return info;

  try {
    const creds = JSON.parse(fs.readFileSync(path.join(dir, 'creds.json'), 'utf8'));
    info.registered = Boolean(creds?.registered || creds?.account);
    info.number = String(creds?.me?.id || '')
      .split('@')[0]
      .split(':')[0];
    info.pushName = String(creds?.me?.name || '');
  } catch {
    // creds.json aún no existe o está vacío
  }

  Object.assign(info, dirUsage(dir));
  return info;
}

export function listSessions() {
  const active = loadSettings().activeSession;
  const names = new Set([active]);

  try {
    for (const entry of fs.readdirSync(SESSIONS_DIR, { withFileTypes: true })) {
      if (entry.isDirectory() && isValidSessionName(entry.name)) {
        names.add(entry.name);
      }
    }
  } catch {
    // Aún no existe la carpeta sessions/
  }

  return Array.from(names)
    .sort((a, b) => (a === active ? -1 : b === active ? 1 : a.localeCompare(b)))
    .map((name) => readSession(name, active));
}

export function deleteSession(name) {
  if (!isValidSessionName(name)) return false;
  const dir = sessionDir(name);
  if (path.dirname(dir) !== SESSIONS_DIR) return false;
  try {
    fs.rmSync(dir, { recursive: true, force: true });
    return !fs.existsSync(dir);
  } catch {
    return false;
  }
}
