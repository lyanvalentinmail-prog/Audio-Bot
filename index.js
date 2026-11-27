import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import chalk from 'chalk';
import pino from 'pino';
import qrcode from 'qrcode';
import makeWASocket, {
  Browsers,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  useMultiFileAuthState,
} from '@whiskeysockets/baileys';

import { config } from './src/config.js';
import { checkFfmpeg } from './src/media.js';
import { installSoundStickerProtoPatch } from './src/soundSticker.js';
import { CommandQueue, parseCommandRequest } from './src/handler.js';
import { EXIT_NEED_LINK, initBridge, underPanel } from './src/bridge.js';
import {
  cleanNumber,
  evaluateSenderAccess,
  getActiveSessionDir,
  loadSettings,
} from './src/settings.js';
import { migrateLegacySession } from './src/sessions.js';
import { printMessageLog } from './src/printlog.js';

installSoundStickerProtoPatch();
migrateLegacySession();

export const eventBus = new EventEmitter();
eventBus.setMaxListeners(50);

function broadcast(event, payload = {}) {
  eventBus.emit(event, { payload, timestamp: Date.now() });
}

initBridge(eventBus);

const commandQueue = new CommandQueue(config, broadcast);
const processedIds = new Set();

let activeSock = null;
let reconnectTimer = null;
let shuttingDown = false;
let cachedPhoneNumber = process.env.AUDIOBOT_PHONE || config.phoneNumber;

const envMethod = (process.env.AUDIOBOT_METHOD || '').toLowerCase();
const forceQR = process.argv.includes('--qr') || envMethod === 'qr';
const forceCode =
  process.argv.includes('--code') || process.argv.includes('code') || envMethod === 'code';

function requestPanelLink(reason) {
  console.log(chalk.yellow(`[ SESSION ] ${reason}`));
  return new Promise(() => {
    const exit = () => process.exit(EXIT_NEED_LINK);
    if (!underPanel()) return exit();
    setTimeout(exit, 800);
    try {
      process.send({ type: 'need_link', reason }, exit);
    } catch {
      exit();
    }
  });
}

/**
 * Solicita el método y/o número de WhatsApp por consola si se ejecuta directo fuera del panel.
 */
async function resolveDirectAuthChoice() {
  if (forceQR) return { method: 'qr', phone: '' };

  const cliPhone = (
    process.argv.find((a) => /^\+?\d{8,15}$/.test(a.replace(/\D/g, ''))) || ''
  ).replace(/\D/g, '');
  if (cliPhone.length >= 8) {
    cachedPhoneNumber = cliPhone;
    return { method: 'code', phone: cachedPhoneNumber };
  }

  if (forceCode && cachedPhoneNumber.length >= 8) {
    return { method: 'code', phone: cachedPhoneNumber };
  }

  if (underPanel() || !process.stdin.isTTY) {
    await requestPanelLink(
      'La sesión no está vinculada. Usa "Start" en el panel (npm start), o ejecuta "npm run qr" / "npm run code".'
    );
  }

  const rl = readline.createInterface({ input, output });
  try {
    let useQr = false;
    if (!forceCode && !cachedPhoneNumber) {
      const lineM = '⋯ ⋯ ⋯ ⋯ ⋯ ⋯ ⋯ ⋯ ⋯ ⋯ ⋯ 》';
      console.log(chalk.white(`\n╭${lineM}`));
      const opt = (
        await rl.question(
          `┊ ${chalk.bold.cyan(' METODO DE VINCULACION ')}\n` +
            `┊ ${chalk.bold.white('⇢ Opcion 1:')} ${chalk.cyan('Codigo de 8 digitos (Pairing Code).')}\n` +
            `┊ ${chalk.bold.white('⇢ Opcion 2:')} ${chalk.cyan('Codigo QR.')}\n` +
            `╰${lineM}\n${chalk.bold.white('---> ')}`
        )
      ).trim();
      useQr = opt === '2';
    }

    if (useQr) {
      return { method: 'qr', phone: '' };
    }

    if (cachedPhoneNumber && cachedPhoneNumber.length >= 8) {
      return { method: 'code', phone: cachedPhoneNumber };
    }

    while (true) {
      const answer = await rl.question(
        chalk.bold.white(
          '\n📱 Ingresa tu número de WhatsApp con código de país (sin +, espacios ni guiones, ej: 59899123456): '
        )
      );
      const clean = cleanNumber(answer);
      if (clean.length >= 8 && clean.length <= 15) {
        cachedPhoneNumber = clean;
        return { method: 'code', phone: cachedPhoneNumber };
      }
      console.log(
        chalk.yellow(
          '⚠️  Número inválido. Debe contener solo dígitos incluyendo el código de país (8 a 15 dígitos).'
        )
      );
    }
  } finally {
    rl.close();
  }
}

function formatPairingCode(code) {
  if (!code) return '';
  const clean = String(code).trim();
  return clean.length === 8 ? `${clean.slice(0, 4)}-${clean.slice(4)}` : clean;
}

async function verifyEnvironment() {
  try {
    await checkFfmpeg(config.ffmpegBin);
  } catch (err) {
    console.warn(chalk.yellow(`\n⚠️  Aviso FFmpeg: ${err.message}`));
    console.warn(
      chalk.gray('   En Termux instálalo con: pkg update && pkg install ffmpeg -y\n')
    );
  }
}

async function startBot() {
  const sessionFolder = getActiveSessionDir();
  await fs.mkdir(sessionFolder, { recursive: true });

  const logger = pino({ level: config.logLevel });
  let { state, saveCreds } = await useMultiFileAuthState(sessionFolder);

  let version;
  try {
    const latest = await fetchLatestBaileysVersion();
    version = latest.version;
  } catch {
    version = undefined;
  }

  const isLinked = Boolean(state.creds.registered || state.creds.account);
  let linkMode = 'code';
  let phoneToPair = '';

  if (!isLinked) {
    const choice = await resolveDirectAuthChoice();
    linkMode = choice.method;
    phoneToPair = choice.phone;

    // Limpiar restos de intentos fallidos previos antes de pedir nuevo QR / código
    await fs.rm(sessionFolder, { recursive: true, force: true }).catch(() => {});
    await fs.mkdir(sessionFolder, { recursive: true });
    const freshAuth = await useMultiFileAuthState(sessionFolder);
    state = freshAuth.state;
    saveCreds = freshAuth.saveCreds;
  }

  broadcast('bot_status', { status: 'connecting' });

  const sock = makeWASocket({
    ...(version ? { version } : {}),
    logger,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
    browser: Browsers.ubuntu('Chrome'),
    printQRInTerminal: false,
    markOnlineOnConnect: false,
    syncFullHistory: false,
    generateHighQualityLinkPreview: false,
  });

  activeSock = sock;
  let pairingRequested = false;

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (!isLinked && qr) {
      if (linkMode === 'qr') {
        try {
          if (underPanel()) {
            console.log(
              chalk.bold.cyan(
                '[ QR ] Nuevo código QR generado. Escanéalo desde WhatsApp › Dispositivos vinculados.'
              )
            );
          } else {
            const qrTerminal = await qrcode.toString(qr, { type: 'terminal', small: true });
            console.log(chalk.bold.cyan('\n[ QR ] ESCANEA EL SIGUIENTE CÓDIGO QR:\n'));
            console.log(qrTerminal);
          }
          broadcast('qr_generated', { qr });
        } catch (err) {
          console.error(chalk.red('[ ERROR ] Error al generar QR:'), err?.message || err);
        }
      } else if (!pairingRequested && !sock.authState.creds.registered) {
        pairingRequested = true;
        try {
          const code = await sock.requestPairingCode(phoneToPair);
          const formatted = formatPairingCode(code);
          console.log(
            chalk.white.bgBlue(' CODIGO DE VINCULACION '),
            chalk.bold.white(`: ${formatted}`)
          );
          broadcast('pairing_code', { code: formatted });
        } catch (err) {
          pairingRequested = false;
          console.error(
            chalk.red('❌ Error al solicitar el Pairing Code:'),
            err?.message || err
          );
          if (underPanel()) {
            await fs.rm(sessionFolder, { recursive: true, force: true }).catch(() => {});
            await requestPanelLink(
              'No se pudo generar el código de vinculación. Verifica el número con código de país e inténtalo de nuevo.'
            );
          }
        }
      }
    }

    if (connection === 'open') {
      const settings = loadSettings();
      const rawUserId = sock.user?.id || '';
      const number = cleanNumber(rawUserId);
      console.log(
        chalk.bold.cyan(
          `\n✿ ${settings.botName} conectado (+${number || 'vinculado'}) · Comando: ${settings.prefix}s2 ✰\n`
        )
      );
      broadcast('bot_status', {
        status: 'connected',
        botName: settings.botName,
        number,
        name: sock.user?.name || '',
      });
    }

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const reason = lastDisconnect?.error?.message || 'Conexión cerrada';
      sock.ev.removeAllListeners();
      broadcast('bot_status', { status: 'disconnected', statusCode });

      if (shuttingDown) return;

      if (statusCode === DisconnectReason.loggedOut) {
        console.error(
          chalk.yellow(
            `\n🚪 Sesión cerrada desde WhatsApp (statusCode=${statusCode}). Limpiando vinculación...`
          )
        );
        await fs.rm(sessionFolder, { recursive: true, force: true }).catch(() => {});
        if (underPanel()) {
          await requestPanelLink('La sesión se cerró desde WhatsApp. Usa "Start" para vincularla.');
          return;
        }
        scheduleReconnect(2000);
        return;
      }

      console.log(
        chalk.gray(`🔄 Conexión cerrada (${reason}, código=${statusCode ?? 'N/A'}). Reconectando en 3s...`)
      );
      scheduleReconnect(3000);
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify' && type !== 'append') return;

    for (const m of messages) {
      if (!m?.message || !m.key?.remoteJid) continue;
      if (m.key.remoteJid === 'status@broadcast') continue;
      if (!config.allowSelf && m.key.fromMe) continue;

      if (type === 'append' && !m.key.fromMe) continue;

      const dedupeKey = `${m.key.remoteJid}:${m.key.id}`;
      if (processedIds.has(dedupeKey)) continue;

      broadcast('message_received', {});
      printMessageLog(m, sock).catch(() => {});

      const settings = loadSettings();
      const mainCmd = `${settings.prefix}s2`;
      const audioCmd = `${settings.prefix}audio`;

      const parsed = parseCommandRequest(m.message, mainCmd, audioCmd);
      if (!parsed) continue;

      processedIds.add(dedupeKey);
      if (processedIds.size > 1000) {
        const oldest = processedIds.values().next().value;
        processedIds.delete(oldest);
      }

      // Verificar permisos de Ajustes ("Solo el dueño" y lista de "Excluidos")
      const botNumber = cleanNumber(sock.user?.id || sock.authState?.creds?.me?.id);
      const botLid = cleanNumber(sock.user?.lid || sock.authState?.creds?.me?.lid);
      const senderCandidates = [
        m.key.participant,
        m.key.participantAlt,
        m.participant,
        !m.key.remoteJid.endsWith('@g.us') ? m.key.remoteJid : '',
        !m.key.remoteJid.endsWith('@g.us') ? m.key.remoteJidAlt : '',
      ].filter(Boolean);

      const access = evaluateSenderAccess({
        senderCandidates,
        fromMe: Boolean(m.key.fromMe),
        botNumber,
        botLid,
        settings,
      });

      if (!access.allowed) {
        broadcast('access_blocked', { reason: access.reason });
        const who = senderCandidates.map(cleanNumber).find(Boolean) || 'desconocido';
        console.log(
          chalk.yellow(
            `[ AJUSTES ] Uso bloqueado a +${who} (${access.reason === 'owner_only' ? 'Modo Solo el dueño' : 'Número excluido'})`
          )
        );
        continue;
      }

      commandQueue.enqueue(sock, m, parsed);
    }
  });
}

function scheduleReconnect(delayMs = 3000) {
  if (reconnectTimer || shuttingDown) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    startBot().catch((err) => {
      console.error('❌ Error al reconectar:', err);
      scheduleReconnect(5000);
    });
  }, delayMs);
}

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n🛑 Recibido ${signal}. Cerrando bot...`);
  if (reconnectTimer) clearTimeout(reconnectTimer);
  try {
    activeSock?.end(undefined);
  } catch {
    // Ignorar errores al cerrar socket
  }
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

console.log(chalk.cyan('🤖 Iniciando Audio-Bot (Stickers con Audio para WhatsApp)...'));
await verifyEnvironment();
await startBot();
