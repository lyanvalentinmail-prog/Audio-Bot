import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import fs from 'node:fs/promises';
import pino from 'pino';
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

installSoundStickerProtoPatch();

const commandQueue = new CommandQueue(config);
const processedIds = new Set();

let activeSock = null;
let reconnectTimer = null;
let shuttingDown = false;
let cachedPhoneNumber = config.phoneNumber;

/**
 * Solicita el número de WhatsApp por consola si aún no hay sesión vinculada
 * ni se definió PHONE_NUMBER en .env / argumentos CLI.
 */
async function resolvePhoneNumber() {
  // Permitir también pasarlo como argumento: `node index.js 59899123456`
  const cliArg = (process.argv[2] || '').replace(/\D/g, '');
  if (cliArg.length >= 8) {
    cachedPhoneNumber = cliArg;
    return cachedPhoneNumber;
  }

  if (cachedPhoneNumber && cachedPhoneNumber.length >= 8) {
    return cachedPhoneNumber;
  }

  const rl = readline.createInterface({ input, output });
  try {
    while (true) {
      const answer = await rl.question(
        '\n📱 Ingresa tu número de WhatsApp con código de país (sin +, espacios ni guiones, ej: 59899123456): '
      );
      const clean = answer.replace(/\D/g, '');
      if (clean.length >= 8 && clean.length <= 15) {
        cachedPhoneNumber = clean;
        return cachedPhoneNumber;
      }
      console.log('⚠️  Número inválido. Debe contener solo dígitos incluyendo el código de país (8 a 15 dígitos).');
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
    console.warn('\n⚠️  Aviso FFmpeg:', err.message);
    console.warn('   El bot puede vincularse, pero necesitarás FFmpeg instalado para usar .s2');
    console.warn('   En Termux ejecuta: pkg update && pkg install ffmpeg -y\n');
  }
}

async function startBot() {
  const logger = pino({ level: config.logLevel });
  const { state, saveCreds } = await useMultiFileAuthState(config.authDir);

  let version;
  try {
    const latest = await fetchLatestBaileysVersion();
    version = latest.version;
  } catch {
    // Si falla la consulta HTTP de versión, Baileys usará su versión integrada por defecto
    version = undefined;
  }

  const needsPairing = !state.creds.registered;
  let phoneToPair = null;
  if (needsPairing) {
    phoneToPair = await resolvePhoneNumber();
  }

  const sock = makeWASocket({
    ...(version ? { version } : {}),
    logger,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
    // Ubuntu + Chrome es requerido por WhatsApp Web para generar Pairing Codes válidos
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

    // Cuando Baileys emite el primer evento de emparejamiento (`qr` o conexión abierta sin registrar),
    // el handshake Noise ya está listo para solicitar el Pairing Code de 8 caracteres.
    if (needsPairing && !pairingRequested && !sock.authState.creds.registered && (qr || connection === 'connecting')) {
      if (qr) {
        pairingRequested = true;
        try {
          const code = await sock.requestPairingCode(phoneToPair);
          const formatted = formatPairingCode(code);
          console.log('\n╔══════════════════════════════════════════════════╗');
          console.log('║           🔗 CÓDIGO DE VINCULACIÓN               ║');
          console.log(`║                 ${formatted.padEnd(16, ' ')}               ║`);
          console.log('╚══════════════════════════════════════════════════╝');
          console.log('👉 En WhatsApp ve a: Ajustes > Dispositivos vinculados >');
          console.log('   Vincular un dispositivo > "Vincular con el número de teléfono"');
          console.log(`   e introduce el código: ${formatted}\n`);
        } catch (err) {
          pairingRequested = false;
          console.error('❌ Error al solicitar el Pairing Code:', err?.message || err);
        }
      }
    }

    if (connection === 'open') {
      const userId = sock.user?.id || 'desconocido';
      console.log(`\n✅ Conectado a WhatsApp como: ${userId}`);
      console.log(`🎬 Comando activo: ${config.command} (convierte videos en stickers con audio)\n`);
    }

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const reason = lastDisconnect?.error?.message || 'Conexión cerrada';
      sock.ev.removeAllListeners();

      if (shuttingDown) return;

      if (statusCode === DisconnectReason.loggedOut) {
        console.error(
          `\n🚪 Sesión cerrada desde WhatsApp (statusCode=${statusCode}).\n` +
          `   Eliminando sesión en "${config.authDir}" para volver a vincular...`
        );
        await fs.rm(config.authDir, { recursive: true, force: true }).catch(() => {});
        scheduleReconnect(2000);
        return;
      }

      console.log(`🔄 Conexión cerrada (${reason}, código=${statusCode ?? 'N/A'}). Reconectando en 3s...`);
      scheduleReconnect(3000);
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify' && type !== 'append') return;

    for (const m of messages) {
      if (!m?.message || !m.key?.remoteJid) continue;
      if (m.key.remoteJid === 'status@broadcast') continue;
      if (!config.allowSelf && m.key.fromMe) continue;

      // En 'append' solo procesamos mensajes propios recién enviados para evitar reprocesar historial antiguo
      if (type === 'append' && !m.key.fromMe) continue;

      const dedupeKey = `${m.key.remoteJid}:${m.key.id}`;
      if (processedIds.has(dedupeKey)) continue;

      const parsed = parseCommandRequest(m.message, config.command);
      if (!parsed) continue;

      processedIds.add(dedupeKey);
      if (processedIds.size > 1000) {
        const oldest = processedIds.values().next().value;
        processedIds.delete(oldest);
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

console.log('🤖 Iniciando Audio-Bot (Stickers con Audio para WhatsApp)...');
await verifyEnvironment();
await startBot();
