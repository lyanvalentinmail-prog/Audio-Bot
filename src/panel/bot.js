import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import chalk from 'chalk';
import qrcode from 'qrcode';
import { ROOT, loadSettings } from '../settings.js';
import { sessionDir, readSession } from '../sessions.js';
import { EXIT_NEED_LINK } from '../bridge.js';

const MAX_LOGS = 1000;
const accent = chalk.hex('#FF7A1A');

export const bot = {
  child: null,
  runtime: null,
  logs: [],
  logSeq: 0,
  qrText: '',
  pairingCode: '',
  notice: '',
  session: '',
  startedAt: 0,
  events: new EventEmitter(),
};

let stopping = false;
let needLinkReason = '';
let lastOptions = {};
let restartTimer = null;
let crashes = [];

export const isRunning = () => bot.child !== null;

function addLog(line) {
  const clean = String(line || '')
    .replace(/\r/g, '')
    .replace(/\t/g, '    ')
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-ln-~]/g, '')
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, '')
    .replace(/[\u0000-\u0008\u000b-\u001a\u001c-\u001f\u007f]/g, '');
  bot.logs.push(clean);
  bot.logSeq++;
  if (bot.logs.length > MAX_LOGS) bot.logs.splice(0, bot.logs.length - MAX_LOGS);
}

export function clearBotLogs() {
  bot.logs = [];
  bot.logSeq = 0;
  bot.events.emit('update');
}

export function panelLog(text) {
  const time = new Date().toLocaleTimeString('es-ES', { hour12: false });
  addLog(`${accent('[ PANEL ]')} ${chalk.gray(time)} ${text}`);
  bot.events.emit('update');
}

function attach(stream) {
  if (!stream) return;
  let partial = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    const parts = (partial + chunk).split('\n');
    partial = parts.pop() ?? '';
    for (const part of parts) addLog(part);
    bot.events.emit('update');
  });
  stream.on('end', () => {
    if (partial) addLog(partial);
    partial = '';
  });
}

function onMessage(message) {
  if (
    message === 'restart' ||
    (message && typeof message === 'object' && message.type === 'restart')
  ) {
    panelLog('Reinicio solicitado…');
    void stopBot().then(() => startBot(lastOptions));
    return;
  }
  if (!message || typeof message !== 'object') return;

  if (message.type === 'runtime') {
    bot.runtime = message.runtime;
    if (message.runtime?.status === 'connected') {
      bot.qrText = '';
      bot.pairingCode = '';
      crashes = [];
    }
    bot.events.emit('update');
  } else if (message.type === 'qr') {
    qrcode
      .toString(message.qr, { type: 'terminal', small: true, errorCorrectionLevel: 'L' })
      .then((text) => {
        bot.qrText = text.replace(/\n+$/, '');
        bot.events.emit('qr');
        bot.events.emit('update');
      })
      .catch(() => {});
  } else if (message.type === 'pairing') {
    bot.pairingCode = message.code;
    bot.events.emit('update');
  } else if (message.type === 'need_link') {
    needLinkReason = message.reason;
  }
}

function scheduleRestart() {
  const now = Date.now();
  crashes = crashes.filter((t) => now - t < 120_000);
  crashes.push(now);

  if (crashes.length > 5) {
    crashes = [];
    bot.notice =
      'El bot se cerró varias veces seguidas. Revisa la consola antes de iniciarlo de nuevo.';
    panelLog(chalk.red('Demasiados reinicios seguidos; se detiene el reinicio automático.'));
    return;
  }

  panelLog('Reiniciando el bot en 3 segundos…');
  restartTimer = setTimeout(() => {
    restartTimer = null;
    if (!bot.child) startBot(lastOptions);
  }, 3000);
}

export function startBot(options = {}) {
  if (bot.child) return;
  if (restartTimer) {
    clearTimeout(restartTimer);
    restartTimer = null;
  }

  const settings = loadSettings();
  const linked = readSession(settings.activeSession).registered;

  bot.session = settings.activeSession;
  bot.runtime = null;
  bot.qrText = '';
  bot.pairingCode = '';
  bot.notice = '';
  bot.startedAt = Date.now();
  needLinkReason = '';
  stopping = false;
  lastOptions = linked ? {} : options;

  const env = {
    ...process.env,
    AUDIOBOT_SESSION_DIR: sessionDir(bot.session),
    FORCE_COLOR: String(chalk.level || 3),
  };
  delete env.AUDIOBOT_METHOD;
  delete env.AUDIOBOT_PHONE;
  if (lastOptions.method) env.AUDIOBOT_METHOD = lastOptions.method;
  if (lastOptions.phone) env.AUDIOBOT_PHONE = lastOptions.phone;

  panelLog(`Iniciando ${settings.botName} (sesión "${bot.session}")…`);

  let child;
  try {
    child = spawn(process.execPath, ['index.js'], {
      cwd: ROOT,
      env,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
  } catch (error) {
    panelLog(chalk.red(`No se pudo iniciar el bot: ${error?.message || error}`));
    return;
  }

  bot.child = child;
  attach(child.stdout);
  attach(child.stderr);
  child.on('message', onMessage);

  child.on('error', (error) => {
    panelLog(chalk.red(`Error del proceso del bot: ${error.message}`));
  });

  child.on('exit', (code, signal) => {
    if (bot.child !== child) return;
    const wasStopping = stopping;
    bot.child = null;
    bot.runtime = null;
    bot.qrText = '';
    bot.pairingCode = '';
    stopping = false;

    if (code === EXIT_NEED_LINK) {
      bot.notice = needLinkReason || 'La sesión no está vinculada. Usa "Start" para vincularla.';
      panelLog(chalk.yellow(bot.notice));
      bot.events.emit('need_link');
    } else if (wasStopping) {
      panelLog('Bot detenido.');
    } else {
      panelLog(
        chalk.red(`El bot se cerró (${signal ? 'señal ' + signal : 'código ' + code}).`)
      );
      if (loadSettings().autoRestart) {
        scheduleRestart();
      }
    }
    bot.events.emit('update');
  });
}

export function stopBot() {
  if (restartTimer) {
    clearTimeout(restartTimer);
    restartTimer = null;
  }
  const child = bot.child;
  if (!child) return Promise.resolve();

  stopping = true;
  return new Promise((resolve) => {
    const force = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // Ignorar si ya murió
      }
    }, 4000);
    child.once('exit', () => {
      clearTimeout(force);
      resolve();
    });
    try {
      child.kill('SIGTERM');
    } catch {
      clearTimeout(force);
      resolve();
    }
  });
}

export async function restartBot() {
  const options = lastOptions;
  await stopBot();
  startBot(options);
}

export function killBotNow() {
  if (restartTimer) clearTimeout(restartTimer);
  try {
    bot.child?.kill('SIGKILL');
  } catch {
    // Ignorar fallo
  }
}
