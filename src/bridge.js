/**
 * Puente IPC entre el proceso del bot (`index.js`) y el panel de terminal (`launcher.js`).
 */

export const EXIT_NEED_LINK = 10;

export const underPanel = () => typeof process.send === 'function';

export function sendToPanel(message) {
  if (!underPanel()) return;
  try {
    process.send(message);
  } catch {
    // Ignorar errores si el canal IPC se cerró
  }
}

export function initBridge(eventBus) {
  if (!underPanel()) return;

  const commandCount = new Map();
  const runtime = {
    status: 'starting',
    number: '',
    name: '',
    messages: 0,
    commands: 0,
    blocked: 0,
    errors: 0,
    topCommands: [],
    startedAt: Date.now(),
    connectedAt: 0,
    rss: 0,
    heapUsed: 0,
  };

  const push = () => {
    const mem = process.memoryUsage();
    runtime.rss = mem.rss;
    runtime.heapUsed = mem.heapUsed;
    runtime.topCommands = Array.from(commandCount.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5);
    sendToPanel({ type: 'runtime', runtime });
  };

  eventBus.on('bot_status', ({ payload }) => {
    const status = payload?.status;
    if (status === 'connected') {
      runtime.status = 'connected';
      runtime.connectedAt = Date.now();
      runtime.number = String(payload?.number || runtime.number);
      runtime.name = String(payload?.name || runtime.name);
    } else if (status === 'disconnected') {
      runtime.status = 'disconnected';
      runtime.connectedAt = 0;
    } else if (status === 'connecting') {
      runtime.status = 'connecting';
    }
    push();
  });

  eventBus.on('qr_generated', ({ payload }) => {
    runtime.status = 'qr';
    if (payload?.qr) sendToPanel({ type: 'qr', qr: String(payload.qr) });
    push();
  });

  eventBus.on('pairing_code', ({ payload }) => {
    runtime.status = 'pairing';
    if (payload?.code) sendToPanel({ type: 'pairing', code: String(payload.code) });
    push();
  });

  eventBus.on('message_received', () => {
    runtime.messages++;
  });

  eventBus.on('command_executed', ({ payload }) => {
    runtime.commands++;
    const name = String(payload?.command || '').toLowerCase();
    if (name) commandCount.set(name, (commandCount.get(name) || 0) + 1);
  });

  eventBus.on('access_blocked', () => {
    runtime.blocked++;
  });

  eventBus.on('handler_error', () => {
    runtime.errors++;
  });

  setInterval(push, 2000).unref();

  // Si el panel se cierra, el bot tampoco debe quedar huérfano en segundo plano
  process.on('disconnect', () => process.exit(0));
}
