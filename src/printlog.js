import chalk from 'chalk';
import { loadSettings } from './settings.js';
import { unwrapMessage } from './handler.js';

const groupSubjectCache = new Map();

async function resolveChatName(sock, chatJid) {
  if (!chatJid?.endsWith('@g.us')) return 'Privado';
  const cached = groupSubjectCache.get(chatJid);
  if (cached && Date.now() - cached.ts < 5 * 60_000) {
    return cached.subject;
  }
  try {
    const meta = await sock.groupMetadata(chatJid);
    const subject = meta?.subject || 'Grupo';
    groupSubjectCache.set(chatJid, { subject, ts: Date.now() });
    return subject;
  } catch {
    return 'Grupo';
  }
}

function getMessageType(unwrapped) {
  if (!unwrapped || typeof unwrapped !== 'object') return 'desconocido';
  const keys = Object.keys(unwrapped).filter(
    (k) => k !== 'messageContextInfo' && k !== 'senderKeyDistributionMessage'
  );
  return keys[0] || 'desconocido';
}

function getMessageBody(unwrapped) {
  if (!unwrapped) return '';
  return (
    unwrapped.videoMessage?.caption ||
    unwrapped.imageMessage?.caption ||
    unwrapped.documentMessage?.caption ||
    unwrapped.extendedTextMessage?.text ||
    unwrapped.conversation ||
    ''
  ).trim();
}

export async function printMessageLog(rawMsg, sock) {
  const settings = loadSettings();
  if (settings.logMode === 'apagado') return;

  const chatJid = rawMsg?.key?.remoteJid;
  if (!chatJid || chatJid === 'status@broadcast') return;

  const unwrapped = unwrapMessage(rawMsg.message);
  const mtype = getMessageType(unwrapped);
  if (['protocolMessage', 'senderKeyDistributionMessage', 'keepAliveMessage', 'reactionMessage'].includes(mtype)) {
    return;
  }

  const isGroup = chatJid.endsWith('@g.us');
  const senderJid = rawMsg.key?.fromMe
    ? sock?.user?.id || chatJid
    : rawMsg.key?.participantAlt || rawMsg.key?.participant || rawMsg.key?.remoteJidAlt || chatJid;

  const pushName = rawMsg.pushName || String(senderJid || '').split('@')[0] || 'Usuario';
  const body = getMessageBody(unwrapped);

  if (settings.logMode === 'compacto') {
    const time = new Date(
      rawMsg.messageTimestamp ? Number(rawMsg.messageTimestamp) * 1000 : Date.now()
    ).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit', hour12: false });
    const where = isGroup ? await resolveChatName(sock, chatJid) : 'Privado';
    const shortType = mtype.replace(/Message$/i, '');
    const text = body ? body.replace(/\s+/g, ' ').slice(0, 120) : `[${shortType || 'mensaje'}]`;
    console.log(
      `${chalk.gray(time)} ${chalk.cyan(pushName)} ${chalk.gray('@ ' + where)}${chalk.gray(':')} ${chalk.white(text)}`
    );
    return;
  }

  const cyan = chalk.cyan;
  const darkCyan = chalk.hex('#008B8B');
  const white = chalk.white;

  const chatName = await resolveChatName(sock, chatJid);
  const botJid = sock?.user?.id || '';
  const botName = sock?.user?.name || settings.botName || 'Audio-Bot';
  const me = botJid ? '+' + botJid.split('@')[0].split(':')[0] : 'Bot';

  const date = new Date(
    rawMsg.messageTimestamp ? Number(rawMsg.messageTimestamp) * 1000 : Date.now()
  ).toLocaleDateString('es-ES', { day: 'numeric', month: 'long', year: 'numeric' });

  const rawType = mtype
    .replace(/Message$/i, '')
    .replace('audio', unwrapped?.audioMessage?.ptt ? 'PTT' : 'audio');
  const typeClean = rawType.charAt(0).toUpperCase() + rawType.slice(1);

  console.log(
    `${cyan.bold('╭────────────────────────────────···')}\n` +
      `${cyan.bold('│')} ${darkCyan('Bot:')} ${white(me)} ~ ${white(botName)}\n` +
      `${cyan.bold('│')} ${darkCyan('Fecha:')} ${white(date)}\n` +
      `${cyan.bold('│')} ${darkCyan('Usuario:')} ${white(senderJid)}\n` +
      `${cyan.bold('│')} ${darkCyan('Nombre:')} ${white(pushName)}\n` +
      `${cyan.bold('│')} ${darkCyan('Chat:')} ${white(isGroup ? 'Grupal ~ ' + chatName : 'Privado')}\n` +
      `${cyan.bold('│')} ${darkCyan('Tipo:')} ${white(typeClean)}\n` +
      `${cyan.bold('╰───────────────────···')}`
  );

  const mediaShort = mtype.replace(/Message$/i, '').toLowerCase();
  if (['image', 'video', 'sticker', 'audio', 'document'].includes(mediaShort)) {
    console.log(`${darkCyan('  multimedia:')} ${white(mediaShort)}${body ? '' : '\n'}`);
  }
  if (body) {
    console.log(`  ${white(body)}\n`);
  }
}
