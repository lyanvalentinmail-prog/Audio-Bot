/**
 * Panel de control TUI de Audio-Bot (estilo DenjiBot) para Termux y Linux.
 *
 * Atajos del menú principal:
 *   1 Start · 2 Consola del bot · 3 Sesiones · 4 Eliminar sesiones
 *   5 Actualizar bot (git pull) · 6 Ajustes · 7 Eliminar datos · 0 Salir
 *
 * Si se ejecuta sin una terminal interactiva (PM2, systemd, paneles de hosting)
 * o con `AUDIOBOT_NO_PANEL=1`, arranca directamente el bot (`index.js`).
 */

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { spawn } from 'node:child_process';

const cliArgs = new Set(process.argv.slice(2).map((a) => a.toLowerCase()));
const cliWipe =
  cliArgs.has('--wipe-all') || cliArgs.has('--reset-all') || cliArgs.has('--borrar-todo');

if (cliWipe) {
  await runCliWipe(cliArgs);
  process.exit(0);
}

const interactive =
  Boolean(process.stdin.isTTY && process.stdout.isTTY) && !process.env.AUDIOBOT_NO_PANEL;

if (!fs.existsSync(new URL('./node_modules/chalk', import.meta.url))) {
  console.error('\n Faltan las dependencias de Audio-Bot.\n Ejecuta primero:  npm install\n');
  process.exit(1);
}

if (!interactive) {
  await import('./index.js');
} else {
  await runPanel();
}

async function runCliWipe(flags) {
  const { inspectBotData, wipeBotData, WIPE_PRESETS } = await import('./src/wipe.js');
  const { fmtBytes } = await import('./src/panel/tui.js');
  const summary = inspectBotData();

  const mode =
    flags.has('--keep-session') || flags.has('--sin-sesion')
      ? 'keepSession'
      : flags.has('--settings') || flags.has('--ajustes')
        ? 'settings'
        : flags.has('--tmp') || flags.has('--cache')
          ? 'temp'
          : 'all';

  const labels = {
    all: 'TODOS los datos (sesiones, settings.json y caché temporal)',
    keepSession: 'caché y ajustes (conservando sesión activa, dueños y excluidos)',
    settings: 'archivo de ajustes (settings.json)',
    temp: 'archivos temporales y registros',
  };

  console.log('\n AUDIO-BOT › Eliminar datos\n');
  console.log(
    `  Sesiones   : ${summary.sessions.exists ? `${summary.sessions.count} (${fmtBytes(summary.sessions.bytes)})` : 'ninguna'}`
  );
  console.log(
    `  Ajustes    : ${summary.settings.exists ? fmtBytes(summary.settings.bytes) : 'por defecto'}`
  );
  console.log(
    `  Temporales : ${summary.temp.exists ? `${summary.temp.files} archivos (${fmtBytes(summary.temp.bytes)})` : 'limpio'}`
  );
  console.log(`  Total      : ${fmtBytes(summary.totalBytes)}\n`);

  if (!summary.hasAnyData) {
    console.log(' No hay datos guardados para eliminar.\n');
    return;
  }

  const autoYes = flags.has('--yes') || flags.has('-y') || flags.has('--force');
  if (!autoYes) {
    if (!process.stdin.isTTY) {
      console.error(
        ' Terminal no interactiva: añade --yes para confirmar (npm run reset -- --yes).\n'
      );
      process.exit(1);
    }
    console.log(` Se eliminará: ${labels[mode]}.`);
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = (
      await rl.question(' ¿Confirmar eliminación definitiva? (escribe SI para continuar): ')
    )
      .trim()
      .toLowerCase();
    rl.close();
    if (!['si', 'sí', 's', 'yes', 'y'].includes(answer)) {
      console.log('\n Operación cancelada.\n');
      return;
    }
  }

  const res = wipeBotData(WIPE_PRESETS[mode]);
  if (!res.ok) {
    console.error(`\n ✖ No se pudo eliminar todo: ${res.failed.join(', ')}\n`);
    process.exit(1);
  }
  const detail = res.removed.length ? res.removed.join(', ') : 'sin cambios';
  console.log(`\n ✔ Datos eliminados (${detail}) · ${fmtBytes(res.freedBytes)} liberados.\n`);
}

async function runPanel() {
  const {
    c,
    draw,
    scheduleDraw,
    initTerminal,
    restoreTerminal,
    show,
    select,
    prompt,
    confirm,
    message,
    fmtBytes,
    fmtNumber,
    fmtDuration,
    fmtAgo,
    bar,
    pad,
    rule,
    cols,
    rows,
    wrap,
  } = await import('./src/panel/tui.js');

  const { bot, isRunning, startBot, stopBot, restartBot, killBotNow, clearBotLogs, panelLog } =
    await import('./src/panel/bot.js');

  const {
    ROOT,
    LOG_MODES,
    loadSettings,
    saveSettings,
    resetSettings,
    cleanNumber,
    isSamePhoneNumber,
    isValidSessionName,
  } = await import('./src/settings.js');

  const { listSessions, readSession, deleteSession, migrateLegacySession } =
    await import('./src/sessions.js');

  const { inspectBotData, wipeBotData, WIPE_PRESETS, collectSystemStats } =
    await import('./src/wipe.js');

  const version = (() => {
    try {
      return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version || '';
    } catch {
      return '';
    }
  })();

  let sysStats = collectSystemStats();
  let statsAt = Date.now();

  function refreshStats(maxAge = 5000) {
    if (Date.now() - statsAt < maxAge) return;
    sysStats = collectSystemStats();
    statsAt = Date.now();
  }

  const LOGO = [
    ' ╔═╗╦ ╦╔╦╗╦╔═╗  ╔╗ ╔═╗╔╦╗',
    ' ╠═╣║ ║ ║║║║ ║  ╠╩╗║ ║ ║ ',
    ' ╩ ╩╚═╝═╩╝╩╚═╝  ╚═╝╚═╝ ╩ ',
  ];

  const title = (section) => [
    ' ' + c.accentBold('AUDIO BOT') + c.dim(' › ') + c.bold(section),
    ' ' + rule(),
  ];

  const phone = (number) => (number ? '+' + number : '');

  const para = (text, color = c.white) =>
    wrap(text, cols() - 2).map((line) => ' ' + color(line));

  function statusText() {
    if (!isRunning()) return c.dim('○ Detenido');
    switch (bot.runtime?.status) {
      case 'connected':
        return c.green('● Conectado');
      case 'qr':
        return c.yellow('◐ Esperando QR');
      case 'pairing':
        return c.yellow('◐ Esperando código');
      case 'disconnected':
        return c.red('● Reconectando');
      default:
        return c.yellow('◐ Conectando…');
    }
  }

  function statusLine() {
    const parts = [statusText()];
    const rt = bot.runtime;
    if (rt?.status === 'connected') {
      if (rt.number) parts.push(c.white(phone(rt.number)));
      if (rt.connectedAt) parts.push(c.dim(fmtDuration(Date.now() - rt.connectedAt)));
    }
    return parts.join(c.dim(' · '));
  }

  const field = (label, value, size = 10) => ' ' + c.dim(pad(label, size)) + ' ' + value;

  function describeSession(session) {
    if (session.registered) {
      return [
        phone(session.number) || 'vinculada',
        fmtBytes(session.size),
        fmtAgo(session.modified),
      ].join(' · ');
    }
    return session.exists && session.files > 0 ? 'sin vincular' : 'vacía';
  }

  // ───────────────────────── menú principal ─────────────────────────

  function menuHeader() {
    const settings = loadSettings();
    const session = readSession(settings.activeSession);
    const accessSummary = settings.ownerOnly
      ? c.yellow('Solo el dueño')
      : settings.excludedNumbers.length > 0
        ? c.green('Público') + c.dim(` · ${settings.excludedNumbers.length} excluido(s)`)
        : c.green('Todos');

    const lines = [
      '',
      ...LOGO.map((line) => c.accentBold(line)),
      ' ' + c.dim(`Panel de control${version ? ' · v' + version : ''}`),
      '',
      field('Bot', c.bold(settings.botName) + c.dim(` (${settings.prefix}s2)`)),
      field('Estado', statusLine()),
      field(
        'Sesión',
        c.white(session.name) +
          c.dim(' · ') +
          (session.registered
            ? c.green('vinculada') + (session.number ? c.dim(' ' + phone(session.number)) : '')
            : c.yellow('sin vincular'))
      ),
      field('Acceso', accessSummary),
    ];

    if (!settings.owners.length) {
      lines.push('', ...para('! Sin dueño adicional configurado: Ajustes › Dueños', c.dim));
    }
    if (bot.notice) lines.push('', ...para('! ' + bot.notice, c.yellow));
    return lines;
  }

  function mainMenu() {
    refreshStats(0);
    return select({
      header: menuHeader,
      options: () => {
        const running = isRunning();
        const s = loadSettings();
        const settingsHint = [
          s.ownerOnly ? 'Solo dueño' : 'Público',
          s.excludedNumbers.length ? `${s.excludedNumbers.length} excluidos` : '',
        ]
          .filter(Boolean)
          .join(' · ');

        const options = [
          {
            label: 'Start',
            hint: running ? 'Reiniciar o detener' : 'Iniciar (QR o código)',
            value: 'start',
            key: '1',
          },
          {
            label: 'Consola del bot',
            hint: 'Logs y dashboard',
            value: 'console',
            key: '2',
          },
          {
            label: 'Sesiones',
            hint: 'Ver, crear y elegir',
            value: 'sessions',
            key: '3',
          },
          {
            label: 'Eliminar sesiones',
            hint: 'Borrar vinculaciones',
            value: 'delete',
            key: '4',
          },
          {
            label: 'Actualizar bot',
            hint: 'git pull',
            value: 'update',
            key: '5',
          },
          {
            label: 'Ajustes',
            hint: settingsHint || 'Solo dueño, excluidos, sticker…',
            value: 'settings',
            key: '6',
          },
          {
            label: 'Eliminar datos',
            hint: 'Sesiones, ajustes o todo',
            value: 'wipe',
            key: '7',
          },
        ];
        if (running) {
          options.push({ label: 'Detener bot', hint: 'Apagar el bot', value: 'stop', key: '8' });
        }
        options.push({ label: 'Salir', hint: 'Cerrar el panel', value: 'quit', key: '0' });
        return options;
      },
      back: 'none',
      footer: '↑↓ mover · Enter elegir · 0-8 atajos',
      tick: 1000,
      onTick: () => refreshStats(10_000),
    });
  }

  // ───────────────────────── start ─────────────────────────

  async function askLinkOptions() {
    const session = readSession(loadSettings().activeSession);
    if (session.registered) return {};

    const method = await select({
      header: () => [
        ...title('Start'),
        ...para(`La sesión "${session.name}" todavía no está vinculada.`),
        ' ' + c.bold('¿Cómo quieres vincular WhatsApp?'),
      ],
      options: [
        { label: 'Código de 8 dígitos', hint: 'Pairing code (mismo móvil)', value: 'code', key: '1' },
        { label: 'Código QR', hint: 'Escanear con otro móvil', value: 'qr', key: '2' },
        { label: 'Volver', value: null, key: '0' },
      ],
      back: null,
    });
    if (!method) return null;
    if (method === 'qr') return { method };

    const number = await prompt({
      header: () => title('Start › Código de vinculación'),
      label: 'Número de WhatsApp del bot',
      hint: 'Con código de país, sin + ni espacios. Ej: 59899123456',
      maxLength: 24,
      validate: (value) => {
        const digits = cleanNumber(value);
        return digits.length >= 8 && digits.length <= 15
          ? null
          : 'Escribe un número válido (8 a 15 dígitos).';
      },
    });
    if (number === null) return null;
    return { method: 'code', phone: cleanNumber(number) };
  }

  async function startFlow() {
    if (isRunning()) {
      const choice = await select({
        header: () => [...title('Start'), ' El bot ya está en marcha: ' + statusLine()],
        options: [
          { label: 'Ver consola', value: 'console', key: '1' },
          { label: 'Reiniciar bot', value: 'restart', key: '2' },
          { label: 'Detener bot', value: 'stop', key: '3' },
          { label: 'Volver', value: 'back', key: '0' },
        ],
        back: 'back',
      });
      if (choice === 'back') return;
      if (choice === 'stop') {
        await stopBot();
        return;
      }
      if (choice === 'restart') await restartBot();
      return openConsole();
    }

    const options = await askLinkOptions();
    if (!options) return;
    startBot(options);
    return openConsole();
  }

  // ───────────────────────── consola y dashboard ─────────────────────────

  function miniStats() {
    const rt = bot.runtime;
    const settings = loadSettings();
    const parts = [];
    parts.push(`${c.dim('Modo')} ${settings.ownerOnly ? c.yellow('Solo dueño') : c.green('Público')}`);
    if (settings.excludedNumbers.length) {
      parts.push(`${c.dim('Excluidos')} ${c.white(String(settings.excludedNumbers.length))}`);
    }
    if (rt) {
      parts.push(`${c.dim('Cmds')} ${c.white(fmtNumber(rt.commands))}`);
      parts.push(`${c.dim('Msgs')} ${c.white(fmtNumber(rt.messages))}`);
    }
    return ' ' + parts.join(c.dim(' · '));
  }

  function dashboardLines() {
    const settings = loadSettings();
    const rt = bot.runtime;
    const s = sysStats;
    const lines = [];
    const section = (name) => lines.push('', ' ' + c.accentBold(name));
    const row = (label, value) => lines.push(field(' ' + label, value, 14));
    const barSize = Math.max(8, Math.min(20, cols() - 34));

    lines.push(' ' + c.accentBold('BOT'));
    row('Estado', statusText());
    row('Nombre', c.white(settings.botName));
    if (rt?.number) {
      row('Número', c.white(phone(rt.number)) + (rt.name ? c.dim(` (${rt.name})`) : ''));
    }
    row('Sesión', c.white(bot.session || settings.activeSession));
    row('Comando', c.white(`${settings.prefix}s2`) + c.dim(` · audio: ${settings.prefix}audio`));
    row(
      'Metadatos',
      c.white(settings.stickerPack) + c.dim(' · ') + c.white(settings.stickerAuthor)
    );
    if (isRunning()) {
      row(
        'Encendido',
        c.white(fmtDuration(Date.now() - bot.startedAt)) +
          (rt?.connectedAt
            ? c.dim(' · conectado ') + c.white(fmtDuration(Date.now() - rt.connectedAt))
            : '')
      );
      row(
        'Proceso',
        c.dim('PID ') +
          c.white(String(bot.child?.pid ?? '-')) +
          (rt ? c.dim(' · RAM ') + c.white(fmtBytes(rt.rss)) : '')
      );
    }

    section('PERMISOS (AJUSTES)');
    row('Solo el dueño', settings.ownerOnly ? c.yellow('Activado') : c.green('Desactivado'));
    row(
      'Dueños',
      settings.owners.length ? c.white(settings.owners.map(phone).join(', ')) : c.dim('Cuenta vinculada')
    );
    row(
      'Excluidos',
      settings.excludedNumbers.length
        ? c.red(`${settings.excludedNumbers.length} número(s): `) +
            c.white(settings.excludedNumbers.slice(0, 4).map(phone).join(', '))
        : c.dim('Ninguno')
    );

    section('ACTIVIDAD');
    row('Stickers/Cmds', c.white(fmtNumber(rt?.commands ?? 0)) + c.dim(' esta sesión'));
    row('Mensajes', c.white(fmtNumber(rt?.messages ?? 0)) + c.dim(' esta sesión'));
    row('Bloqueados', c.white(fmtNumber(rt?.blocked ?? 0)) + c.dim(' por permisos/excluidos'));
    row('Errores', (rt?.errors ? c.red(String(rt.errors)) : c.white('0')) + c.dim(' esta sesión'));
    if (rt?.topCommands?.length) {
      row(
        'Más usados',
        rt.topCommands.map(([name, count]) => c.white(name) + c.dim(`×${count}`)).join(' ')
      );
    }

    section('ALMACENAMIENTO Y SISTEMA');
    row('Sesiones', c.white(fmtBytes(s.storage.sessions)));
    row('Bot', c.white(fmtBytes(s.storage.project)) + c.dim(' (sin node_modules)'));
    if (s.storage.diskTotal) {
      const used = s.storage.diskTotal - s.storage.diskFree;
      row(
        'Disco',
        bar(used / s.storage.diskTotal, barSize) +
          ' ' +
          c.white(fmtBytes(s.storage.diskFree)) +
          c.dim(' libres')
      );
    }
    row(
      'RAM',
      bar(s.system.memUsed / s.system.memTotal, barSize) +
        ' ' +
        c.white(fmtBytes(s.system.memUsed)) +
        c.dim(' / ' + fmtBytes(s.system.memTotal))
    );
    row('CPU', c.white(s.system.load.toFixed(2)) + c.dim(` carga · ${s.system.cpus} núcleos`));
    row('Entorno', c.dim(`Node ${s.system.node} · ${s.system.platform}`));
    return lines;
  }

  function consoleView(initial = 'logs') {
    return show((done) => {
      let mode = bot.qrText ? 'qr' : initial;
      let qrDismissed = false;
      let scroll = 0;
      let dashScroll = 0;
      let seenSeq = bot.logSeq;
      let pending = null;

      const onUpdate = () => scheduleDraw();
      const onQr = () => {
        if (!qrDismissed) mode = 'qr';
        scheduleDraw();
      };
      const onNeedLink = () => finish('menu');

      bot.events.on('update', onUpdate);
      bot.events.on('qr', onQr);
      bot.events.on('need_link', onNeedLink);

      function finish(result) {
        bot.events.off('update', onUpdate);
        bot.events.off('qr', onQr);
        bot.events.off('need_link', onNeedLink);
        done(result);
      }

      function header() {
        const lines = [' ' + c.accentBold('AUDIO BOT') + '  ' + statusLine(), miniStats()];
        if (bot.pairingCode && bot.runtime?.status !== 'connected') {
          lines.push(
            ' ' + c.dim('Código de vinculación:') + ' ' + c.inverse(` ${bot.pairingCode} `),
            ' ' + c.dim('WhatsApp › Dispositivos vinculados ›'),
            ' ' + c.dim('Vincular con el número de teléfono')
          );
        }
        lines.push(' ' + rule());
        return lines;
      }

      function footer() {
        if (pending) {
          const question = pending === 'restart' ? '¿Reiniciar el bot?' : '¿Detener el bot?';
          return [
            ' ' + rule(),
            ' ' + c.yellow(question) + c.dim('  Enter = sí · otra tecla = no'),
          ];
        }
        const k = (key, label) => c.accentBold(key) + c.dim(' ' + label);
        const first = mode === 'dash' ? k('L', 'logs') : k('D', 'dashboard');
        const keys = isRunning()
          ? [first, k('M', 'menú'), k('R', 'reiniciar'), k('X', 'detener')]
          : [first, k('M', 'menú'), k('R', 'iniciar')];
        if (bot.qrText && mode !== 'qr') keys.push(k('Q', 'QR'));
        const second =
          mode === 'logs' && scroll > 0
            ? c.yellow('▲ Viendo historial') + c.dim(' · F volver al final')
            : c.dim('↑↓ desplazar');
        return [' ' + rule(), ' ' + keys.join(c.dim(' · ')), ' ' + second];
      }

      function qrScreen() {
        const qr = bot.qrText.split('\n');
        const widest = Math.max(...qr.map((line) => line.replace(/\u001b\[[0-9;]*m/g, '').length));
        const keys =
          ' ' +
          c.accentBold('L') +
          c.dim(' logs · ') +
          c.accentBold('M') +
          c.dim(' menú · se renueva solo');
        const lines = [
          ' ' + c.accentBold('AUDIO BOT') + c.dim(' › ') + c.bold('Escanea el código QR'),
          ...para('WhatsApp › Dispositivos vinculados › Vincular un dispositivo', c.dim),
        ];
        if (widest > cols() || lines.length + qr.length + 1 > rows()) {
          lines.push(
            ...para(
              'El QR no cabe en pantalla: aleja el zoom pellizcando la pantalla, o usa el código de 8 dígitos.',
              c.yellow
            )
          );
          lines.push(keys, ...qr);
        } else {
          lines.push(...qr, keys);
        }
        return lines;
      }

      function body(room) {
        if (mode === 'dash') {
          const all = dashboardLines();
          dashScroll = Math.max(0, Math.min(dashScroll, Math.max(0, all.length - room)));
          return all.slice(dashScroll, dashScroll + room);
        }

        const total = bot.logs.length;
        const maxScroll = Math.max(0, total - room);
        if (scroll > 0) scroll += bot.logSeq - seenSeq;
        seenSeq = bot.logSeq;
        scroll = Math.max(0, Math.min(scroll, maxScroll));
        const end = total - scroll;
        const lines = bot.logs.slice(Math.max(0, end - room), end);
        if (!lines.length) {
          lines.push(
            ' ' +
              c.dim(
                isRunning()
                  ? 'Esperando actividad…'
                  : 'El bot está detenido. Pulsa R para iniciarlo.'
              )
          );
        }
        return lines;
      }

      return {
        tick: 1000,
        onTick: () => refreshStats(5000),
        render() {
          if (mode === 'qr' && !bot.qrText) mode = 'logs';
          if (mode === 'qr') return qrScreen();
          const head = header();
          const foot = footer();
          const room = Math.max(1, rows() - head.length - foot.length);
          const lines = body(room).slice(0, room);
          while (lines.length < room) lines.push('');
          return [...head, ...lines, ...foot];
        },
        onKey(key) {
          const name = key.name || '';

          if (pending) {
            const action = pending;
            pending = null;
            if (name === 'return' || name === 'enter') {
              if (action === 'restart') restartBot().catch(() => {});
              else stopBot().catch(() => {});
            }
            return draw();
          }

          const page = Math.max(1, rows() - 10);
          const move = (delta) => {
            if (mode === 'dash') dashScroll = Math.max(0, dashScroll - delta);
            else if (mode === 'logs') scroll = Math.max(0, scroll + delta);
            draw();
          };

          switch (name) {
            case 'm':
            case 'escape':
              return finish('menu');
            case 'd':
              mode = 'dash';
              if (bot.qrText) qrDismissed = true;
              refreshStats(0);
              return draw();
            case 'l':
            case 'c':
              mode = 'logs';
              if (bot.qrText) qrDismissed = true;
              return draw();
            case 'q':
              if (bot.qrText) {
                mode = 'qr';
                qrDismissed = false;
              }
              return draw();
            case 'r':
              if (!isRunning()) return finish('start');
              pending = 'restart';
              return draw();
            case 'x':
              if (isRunning()) pending = 'stop';
              return draw();
            case 'up':
            case 'k':
              return move(1);
            case 'down':
            case 'j':
              return move(-1);
            case 'pageup':
              return move(page);
            case 'pagedown':
            case 'space':
              return move(-page);
            case 'home':
            case 'g':
              if (mode === 'dash') dashScroll = 0;
              else scroll = bot.logs.length;
              return draw();
            case 'f':
            case 'end':
              scroll = 0;
              dashScroll = mode === 'dash' ? Number.MAX_SAFE_INTEGER : dashScroll;
              return draw();
          }
        },
      };
    });
  }

  async function openConsole(initial = 'logs') {
    let mode = initial;
    while (true) {
      const result = await consoleView(mode);
      if (result !== 'start') return;
      const options = await askLinkOptions();
      if (!options) return;
      startBot(options);
      mode = 'logs';
    }
  }

  // ───────────────────────── sesiones ─────────────────────────

  async function stopIfUsing(names) {
    if (isRunning() && names.includes(bot.session)) await stopBot();
  }

  async function removeSessions(names) {
    if (!names.length) return;
    const using = isRunning() && names.includes(bot.session);
    const what = names.length === 1 ? `la sesión "${names[0]}"` : `${names.length} sesiones`;

    const ok = await confirm(
      () => [
        ...title('Eliminar sesiones'),
        ...para(`Vas a borrar ${what}.`),
        ...para('Tendrás que vincular WhatsApp de nuevo para usarla.', c.dim),
        ...(using ? para('El bot está usando esta sesión y se detendrá.', c.yellow) : []),
      ],
      '¿Eliminar definitivamente?',
      'Sí, eliminar',
      'No, cancelar'
    );
    if (!ok) return;

    await stopIfUsing(names);
    const failed = names.filter((name) => !deleteSession(name));
    if (!failed.length) bot.notice = '';

    await message(() => [
      ...title('Eliminar sesiones'),
      failed.length
        ? ' ' + c.red(`No se pudo eliminar: ${failed.join(', ')}`)
        : ' ' +
          c.green(
            `✔ ${names.length === 1 ? 'Sesión eliminada' : 'Sesiones eliminadas'}: ${names.join(', ')}`
          ),
    ]);
  }

  async function useSession(name) {
    const running = isRunning();
    if (running) {
      const ok = await confirm(
        () => [
          ...title('Sesiones'),
          ...para(`El bot está encendido con la sesión "${bot.session}".`),
        ],
        `¿Cambiar a "${name}" y reiniciar el bot?`
      );
      if (!ok) return;
      await stopBot();
    }
    saveSettings({ activeSession: name });
    bot.notice = '';

    if (running) {
      const options = await askLinkOptions();
      if (options) {
        startBot(options);
        await openConsole();
      }
    }
  }

  async function sessionDetail(name) {
    while (true) {
      const session = readSession(name);
      const inUse = isRunning() && bot.session === name;
      const options = [];
      if (!session.active) {
        options.push({
          label: 'Usar esta sesión',
          hint: 'Marcarla como activa',
          value: 'use',
          key: '1',
        });
      }
      if (session.exists) {
        options.push({
          label: 'Eliminar sesión',
          hint: 'Borrar la vinculación',
          value: 'delete',
          key: '2',
        });
      }
      options.push({ label: 'Volver', value: 'back', key: '0' });

      const choice = await select({
        header: () => [
          ...title(`Sesiones › ${name}`),
          field(
            'Estado',
            (session.registered ? c.green('Vinculada') : c.yellow('Sin vincular')) +
              (session.active ? c.dim(' · ') + c.accent('activa') : '') +
              (inUse ? c.dim(' · ') + c.green('en uso') : '')
          ),
          field('Número', session.number ? c.white(phone(session.number)) : c.dim('—')),
          field(
            'Nombre',
            session.pushName && session.pushName !== '~' ? c.white(session.pushName) : c.dim('—')
          ),
          field(
            'Archivos',
            c.white(fmtNumber(session.files)) + c.dim(' · ') + c.white(fmtBytes(session.size))
          ),
          field('Actividad', c.white(session.modified ? fmtAgo(session.modified) : '—')),
          field('Carpeta', c.dim(path.relative(ROOT, session.dir) + path.sep)),
        ],
        options,
        back: 'back',
      });

      if (choice === 'back') return;
      if (choice === 'use') await useSession(name);
      if (choice === 'delete') {
        await removeSessions([name]);
        if (!readSession(name).exists) return;
      }
    }
  }

  async function sessionsScreen() {
    while (true) {
      const sessions = listSessions();
      const choice = await select({
        header: () => [
          ...title('Sesiones'),
          ...para(
            'Cada sesión es una cuenta de WhatsApp vinculada. El bot usa la marcada con ●.',
            c.dim
          ),
        ],
        options: [
          ...sessions.map((session, i) => ({
            label: (session.active ? '● ' : '○ ') + session.name,
            hint: describeSession(session),
            value: 'session:' + session.name,
            key: i < 8 ? String(i + 1) : undefined,
          })),
          { label: '+ Nueva sesión', hint: 'Para vincular otra cuenta', value: 'new', key: 'n' },
          { label: 'Volver', value: 'back', key: '0' },
        ],
        back: 'back',
      });

      if (choice === 'back') return;
      if (choice === 'new') {
        const name = await prompt({
          header: () => title('Sesiones › Nueva'),
          label: 'Nombre de la nueva sesión',
          hint: 'Solo letras, números, guiones y guion bajo (máx. 24).',
          maxLength: 24,
          validate: (value) => {
            if (!isValidSessionName(value)) return 'Nombre no válido.';
            if (sessions.some((s) => s.name === value)) return 'Ya existe una sesión con ese nombre.';
            return null;
          },
        });
        if (name) {
          await useSession(name);
          if (loadSettings().activeSession === name) {
            await message(() => [
              ...title('Sesiones'),
              ...para(`✔ Sesión "${name}" creada y marcada como activa.`, c.green),
              ...para('Usa "Start" para vincularla con QR o código.', c.dim),
            ]);
          }
        }
        continue;
      }
      await sessionDetail(choice.slice('session:'.length));
    }
  }

  async function deleteSessionsScreen() {
    while (true) {
      const sessions = listSessions().filter((s) => s.exists);
      if (!sessions.length) {
        return message(() => [
          ...title('Eliminar sesiones'),
          ' ' + c.dim('No hay sesiones guardadas.'),
        ]);
      }

      const choice = await select({
        header: () => [
          ...title('Eliminar sesiones'),
          ' ' + c.dim('Elige qué sesión quieres borrar.'),
        ],
        options: [
          ...sessions.map((session, i) => ({
            label: (session.active ? '● ' : '○ ') + session.name,
            hint: describeSession(session),
            value: 'session:' + session.name,
            key: i < 8 ? String(i + 1) : undefined,
          })),
          ...(sessions.length > 1
            ? [{ label: 'Eliminar TODAS', hint: `${sessions.length} sesiones`, value: 'all', key: 't' }]
            : []),
          { label: 'Volver', value: 'back', key: '0' },
        ],
        back: 'back',
      });

      if (choice === 'back') return;
      await removeSessions(
        choice === 'all' ? sessions.map((s) => s.name) : [choice.slice('session:'.length)]
      );
      refreshStats(0);
    }
  }

  // ───────────────────────── actualizar (git pull) ─────────────────────────

  function runCmd(command, args, onLine, timeoutMs = 300_000) {
    return new Promise((resolve) => {
      let output = '';
      let partial = '';
      let settled = false;
      const finish = (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (partial) onLine?.(partial);
        resolve({ code, output });
      };

      const child = spawn(command, args, {
        cwd: ROOT,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', NO_COLOR: '1', FORCE_COLOR: '0' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const timer = setTimeout(() => {
        onLine?.('Tiempo de espera agotado.');
        try {
          child.kill('SIGKILL');
        } catch {
          // Ignorar
        }
      }, timeoutMs);

      const feed = (chunk) => {
        const text = chunk.toString('utf8').replace(/\r/g, '\n');
        output += text;
        const parts = (partial + text).split('\n');
        partial = parts.pop() ?? '';
        for (const part of parts) if (part.trim()) onLine?.(part);
      };
      child.stdout?.on('data', feed);
      child.stderr?.on('data', feed);
      child.on('error', (error) => {
        onLine?.(`No se pudo ejecutar ${command}: ${error.message}`);
        finish(127);
      });
      child.on('close', (code) => finish(code ?? 1));
    });
  }

  function taskScreen(section, task) {
    return show((done) => {
      const output = [];
      let finished = false;
      let result;

      const log = (line) => {
        output.push(' ' + String(line).replace(/\u001b\[[0-9;?]*[ -/]*[@-ln-~]/g, ''));
        scheduleDraw();
      };

      task(log)
        .then((value) => {
          result = value;
        })
        .catch((error) => {
          log(c.red(`Error: ${error?.message || error}`));
        })
        .finally(() => {
          finished = true;
          draw();
        });

      return {
        render() {
          const head = title(section);
          const foot = [
            '',
            ' ' + (finished ? c.dim('Pulsa una tecla para continuar') : c.yellow('Trabajando…')),
          ];
          const room = Math.max(1, rows() - head.length - foot.length);
          return [...head, ...output.slice(-room), ...foot];
        },
        onKey() {
          if (finished) done(result);
        },
      };
    });
  }

  async function updateScreen() {
    if (!fs.existsSync(path.join(ROOT, '.git'))) {
      return message(() => [
        ...title('Actualizar bot'),
        ...para(
          'Este bot no se instaló con git clone, así que no se puede actualizar con git pull.',
          c.yellow
        ),
      ]);
    }

    const head = async () => (await runCmd('git', ['rev-parse', 'HEAD'])).output.trim();

    const result = await taskScreen('Actualizar bot', async (log) => {
      const before = await head();
      log(c.dim('$ git pull'));
      const pull = await runCmd('git', ['pull'], log);
      const after = await head();

      if (pull.code !== 0) {
        log('');
        log(c.red('✖ git pull terminó con errores.'));
        return { changed: [], updated: false };
      }
      if (!before || before === after) {
        log('');
        log(c.green('✔ Ya tienes la última versión.'));
        return { changed: [], updated: false };
      }

      const changed = (await runCmd('git', ['diff', '--name-only', before, after])).output
        .split('\n')
        .filter(Boolean);
      const commits = (
        await runCmd('git', ['log', '--oneline', '-n', '8', `${before}..${after}`])
      ).output
        .split('\n')
        .filter(Boolean);
      log('');
      log(c.green(`✔ Bot actualizado: ${changed.length} archivo(s) cambiaron.`));
      for (const commit of commits) log(c.dim('  ' + commit));
      return { changed, updated: true };
    });

    if (!result?.updated) return;

    if (result.changed.includes('package.json')) {
      const install = await confirm(
        () => [
          ...title('Actualizar bot'),
          ...para('La actualización cambió las dependencias (package.json).'),
        ],
        '¿Instalar dependencias ahora? (npm install)',
        'Sí, instalar',
        'Ahora no'
      );
      if (install) {
        await taskScreen('Actualizar bot › npm install', async (log) => {
          log(c.dim('$ npm install --no-audit --no-fund'));
          const npm = await runCmd('npm', ['install', '--no-audit', '--no-fund'], log, 600_000);
          log('');
          log(
            npm.code === 0
              ? c.green('✔ Dependencias instaladas.')
              : c.red('✖ npm install terminó con errores.')
          );
        });
      }
    }

    if (isRunning()) {
      const restart = await confirm(
        () => [
          ...title('Actualizar bot'),
          ...para('El bot está encendido con la versión anterior.'),
        ],
        '¿Reiniciar el bot para aplicar la actualización?'
      );
      if (restart) await restartBot();
    }
  }

  // ───────────────────────── AJUSTES ─────────────────────────

  async function editText(section, label, hint, current, maxLength, validate) {
    return prompt({
      header: () => [
        ...title(`Ajustes › ${section}`),
        ' ' + c.dim('Actual: ') + c.white(current || '—'),
      ],
      label,
      hint,
      initial: current,
      maxLength,
      validate: (value) => (!value ? 'No puede quedar vacío.' : validate ? validate(value) : null),
    });
  }

  async function ownersScreen() {
    while (true) {
      const owners = loadSettings().owners;
      const session = readSession(loadSettings().activeSession);
      const choice = await select({
        header: () => [
          ...title('Ajustes › Dueños'),
          ...para(
            'Los dueños pueden usar siempre el bot (incluso con "Solo el dueño" activado). La cuenta vinculada del bot ya es dueña automáticamente.',
            c.dim
          ),
          ...(session.number
            ? [' ' + c.dim('Cuenta vinculada: ') + c.green(phone(session.number))]
            : []),
          ...(owners.length ? [] : ['', ' ' + c.yellow('No hay dueños adicionales en la lista.')]),
        ],
        options: [
          ...owners.map((number) => ({
            label: phone(number),
            hint: 'Enter para quitar',
            value: 'remove:' + number,
          })),
          { label: '+ Añadir número de dueño', value: 'add', key: 'a' },
          { label: 'Volver', value: 'back', key: '0' },
        ],
        back: 'back',
      });

      if (choice === 'back') return;
      if (choice === 'add') {
        const number = await prompt({
          header: () => title('Ajustes › Añadir dueño'),
          label: 'Número del dueño',
          hint: 'Con código de país, sin + ni espacios. Ej: 59899123456',
          maxLength: 24,
          validate: (value) => {
            const digits = cleanNumber(value);
            if (digits.length < 8 || digits.length > 15) {
              return 'Escribe un número válido con código de país (8 a 15 dígitos).';
            }
            if (owners.some((o) => isSamePhoneNumber(o, digits))) {
              return 'Ese número ya está en la lista de dueños.';
            }
            return null;
          },
        });
        if (number) saveSettings({ owners: [...owners, cleanNumber(number)] });
        continue;
      }

      const number = choice.slice('remove:'.length);
      const ok = await confirm(
        () => title('Ajustes › Dueños'),
        `¿Quitar a ${phone(number)} de los dueños?`
      );
      if (ok) saveSettings({ owners: owners.filter((n) => n !== number) });
    }
  }

  async function excludedScreen() {
    while (true) {
      const s = loadSettings();
      const excluded = s.excludedNumbers;
      const choice = await select({
        header: () => [
          ...title('Ajustes › Excluidos'),
          ...para(
            'Agrega aquí los números de las personas que NO pueden utilizar el bot (ni en privado ni en grupos). Puedes escribir uno o varios separados por coma o espacio.',
            c.dim
          ),
          ...(excluded.length
            ? []
            : ['', ' ' + c.dim('Todavía no hay ningún número excluido.')]),
        ],
        options: [
          ...excluded.map((number) => ({
            label: '🚫 ' + phone(number),
            hint: 'Enter para desbloquear / quitar',
            value: 'remove:' + number,
          })),
          { label: '+ Añadir número(s) excluido(s)', value: 'add', key: 'a' },
          ...(excluded.length > 1
            ? [
                {
                  label: 'Limpiar todos los excluidos',
                  hint: `${excluded.length} números`,
                  value: 'clear',
                  key: 'c',
                },
              ]
            : []),
          { label: 'Volver', value: 'back', key: '0' },
        ],
        back: 'back',
      });

      if (choice === 'back') return;

      if (choice === 'add') {
        const rawInput = await prompt({
          header: () => title('Ajustes › Excluidos › Añadir'),
          label: 'Número(s) que NO podrán usar el bot',
          hint: 'Con código de país (ej: 59899123456). Puedes pegar varios separados por coma o espacio.',
          maxLength: 160,
          validate: (value) => {
            const tokens = value
              .split(/[,;\s]+/)
              .map(cleanNumber)
              .filter(Boolean);
            if (!tokens.length) {
              return 'Ingresa al menos un número con código de país (8 a 15 dígitos).';
            }
            const invalid = tokens.find((d) => d.length < 8 || d.length > 15);
            if (invalid) {
              return `Número inválido ("${invalid}"). Usa de 8 a 15 dígitos incluyendo código de país.`;
            }
            return null;
          },
        });
        if (rawInput) {
          const tokens = rawInput
            .split(/[,;\s]+/)
            .map(cleanNumber)
            .filter(Boolean);
          const next = [...excluded];
          for (const num of tokens) {
            if (!next.some((existing) => isSamePhoneNumber(existing, num))) {
              next.push(num);
            }
          }
          saveSettings({ excludedNumbers: next });
        }
        continue;
      }

      if (choice === 'clear') {
        const ok = await confirm(
          () => title('Ajustes › Excluidos'),
          `¿Quitar los ${excluded.length} números de la lista de excluidos?`
        );
        if (ok) saveSettings({ excludedNumbers: [] });
        continue;
      }

      const number = choice.slice('remove:'.length);
      const ok = await confirm(
        () => title('Ajustes › Excluidos'),
        `¿Permitir nuevamente que ${phone(number)} use el bot?`
      );
      if (ok) saveSettings({ excludedNumbers: excluded.filter((n) => n !== number) });
    }
  }

  async function settingsScreen() {
    let index = 0;

    const PREVIEWS = {
      ownerOnly:
        'Cuando está activado, únicamente tú (la cuenta vinculada y los números en "Dueños") pueden usar los comandos del bot; el resto de personas son ignoradas.',
      excluded:
        'Lista negra de números bloqueados: las personas cuyos números agregues aquí NO podrán utilizar el bot en ningún chat ni grupo.',
      owners:
        'Números con acceso total al bot incluso cuando el modo "Solo el dueño" está activado.',
      prefix:
        'Símbolo inicial de los comandos (por defecto ".", para usar .s2 y .audio).',
      pack:
        'Descripción/nombre del paquete EXIF que se muestra al tocar el sticker en WhatsApp (por defecto: Made by).',
      author:
        'Autor EXIF mostrado en WhatsApp al abrir la info del sticker (por defecto: @Lyan).',
      maxSec:
        'Duración máxima en segundos al recortar videos y audios para stickers.',
      name: 'Nombre visible del bot en el panel y registros de consola.',
      logs: 'Cambia cuánta información de los mensajes entrantes se imprime en la Consola del bot.',
      restart: 'Levanta de nuevo el bot automáticamente si se cierra por un fallo inesperado.',
      reset:
        'Restaura los valores por defecto conservando la sesión activa.',
    };

    while (true) {
      const s = loadSettings();
      const items = [
        {
          label: 'Solo el dueño',
          hint: s.ownerOnly ? c.yellow('● Activado (privado)') : c.green('○ Desactivado (todos)'),
          value: 'ownerOnly',
          key: '1',
        },
        {
          label: 'Excluidos',
          hint: s.excludedNumbers.length
            ? `${s.excludedNumbers.length} bloqueado(s): ${s.excludedNumbers.slice(0, 2).map(phone).join(', ')}${s.excludedNumbers.length > 2 ? '…' : ''}`
            : 'ninguno',
          value: 'excluded',
          key: '2',
        },
        {
          label: 'Dueños',
          hint: s.owners.length ? s.owners.map(phone).join(', ') : 'solo cuenta vinculada',
          value: 'owners',
          key: '3',
        },
        {
          label: 'Prefijo de comandos',
          hint: `${s.prefix}  (${s.prefix}s2, ${s.prefix}audio)`,
          value: 'prefix',
          key: '4',
        },
        {
          label: 'Descripción del sticker',
          hint: s.stickerPack,
          value: 'pack',
          key: '5',
        },
        {
          label: 'Autor del sticker',
          hint: s.stickerAuthor,
          value: 'author',
          key: '6',
        },
        {
          label: 'Duración máx. (seg)',
          hint: `${s.maxSeconds}s`,
          value: 'maxSec',
          key: '7',
        },
        {
          label: 'Nombre del bot',
          hint: s.botName,
          value: 'name',
          key: '8',
        },
        {
          label: 'Logs de mensajes',
          hint: s.logMode,
          value: 'logs',
          key: 'l',
        },
        {
          label: 'Reinicio automático',
          hint: s.autoRestart ? 'activado' : 'desactivado',
          value: 'restart',
          key: 'a',
        },
        {
          label: 'Restablecer ajustes',
          hint: 'Valores iniciales',
          value: 'reset',
          key: 'r',
        },
        { label: 'Volver', hint: '', value: 'back', key: '0' },
      ];

      const choice = await select({
        header: () => [
          ...title('Ajustes'),
          ...para('Los cambios se guardan al instante y el bot los aplica sin reiniciarlo.', c.dim),
        ],
        options: items,
        initial: index,
        back: 'back',
        preview: (val) => (PREVIEWS[val] ? para(PREVIEWS[val], c.dim) : []),
      });
      index = Math.max(0, items.findIndex((item) => item.value === choice));

      if (choice === 'back') return;

      if (choice === 'ownerOnly') {
        saveSettings({ ownerOnly: !s.ownerOnly });
      } else if (choice === 'excluded') {
        await excludedScreen();
      } else if (choice === 'owners') {
        await ownersScreen();
      } else if (choice === 'prefix') {
        const value = await editText(
          'Prefijo',
          'Nuevo prefijo',
          'Un solo símbolo, por ejemplo  .  !  #  /',
          s.prefix,
          2,
          (v) =>
            Array.from(v).length === 1 && !/[\s\w]/.test(v)
              ? null
              : 'Usa un único símbolo (no letras ni números).'
        );
        if (value) saveSettings({ prefix: value });
      } else if (choice === 'pack') {
        const value = await editText(
          'Descripción del sticker',
          'Descripción (sticker-pack-name)',
          'Se muestra al tocar el sticker en WhatsApp (por defecto: Made by).',
          s.stickerPack,
          60
        );
        if (value) saveSettings({ stickerPack: value });
      } else if (choice === 'author') {
        const value = await editText(
          'Autor del sticker',
          'Autor (sticker-pack-publisher)',
          'Se muestra como creador del sticker en WhatsApp (por defecto: @Lyan).',
          s.stickerAuthor,
          60
        );
        if (value) saveSettings({ stickerAuthor: value });
      } else if (choice === 'maxSec') {
        const value = await editText(
          'Duración máxima',
          'Segundos máximos por sticker (2 a 30)',
          'Recorta videos largos para no superar el peso máximo de WhatsApp.',
          String(s.maxSeconds),
          4,
          (v) => {
            const n = Number(v);
            return Number.isInteger(n) && n >= 2 && n <= 30
              ? null
              : 'Escribe un número entero entre 2 y 30.';
          }
        );
        if (value) saveSettings({ maxSeconds: Number(value) });
      } else if (choice === 'name') {
        const value = await editText(
          'Nombre del bot',
          'Nuevo nombre del bot',
          'Aparece en el panel y en los registros de consola.',
          s.botName,
          40
        );
        if (value) saveSettings({ botName: value });
      } else if (choice === 'logs') {
        saveSettings({
          logMode: LOG_MODES[(LOG_MODES.indexOf(s.logMode) + 1) % LOG_MODES.length],
        });
      } else if (choice === 'restart') {
        saveSettings({ autoRestart: !s.autoRestart });
      } else if (choice === 'reset') {
        const ok = await confirm(
          () => [
            ...title('Ajustes › Restablecer'),
            ...para(
              'Se restablecerán modo "Solo el dueño", lista de excluidos, prefijo, descripción/autor del sticker y logs.'
            ),
            ...para('Los dueños y la sesión activa se conservan.', c.dim),
          ],
          '¿Restablecer los valores iniciales?'
        );
        if (ok) resetSettings({ owners: s.owners, activeSession: s.activeSession });
      }
    }
  }

  // ───────────────────────── eliminar datos ─────────────────────────

  async function wipeDataScreen() {
    const DESCRIPTIONS = {
      all: {
        name: 'TODOS los datos del bot',
        preview:
          'Borra todas las sesiones vinculadas, settings.json y archivos temporales. Deja el bot limpio como recién instalado.',
        stopsBot: true,
        restartsBot: false,
      },
      keepSession: {
        name: 'ajustes y caché (conservando la sesión activa)',
        preview:
          'Limpia archivos temporales y restablece Ajustes conservando la vinculación de WhatsApp, dueños y excluidos.',
        stopsBot: true,
        restartsBot: true,
      },
      settings: {
        name: 'solo el archivo de ajustes (settings.json)',
        preview:
          'Elimina settings.json (Solo el dueño, excluidos, dueños, prefijo y nombre). Conserva las sesiones.',
        stopsBot: false,
        restartsBot: false,
      },
      temp: {
        name: 'la caché temporal y los logs',
        preview:
          'Limpia tmp/, archivos .log y el historial de consola del panel sin tocar sesiones ni ajustes.',
        stopsBot: false,
        restartsBot: false,
      },
    };

    while (true) {
      const info = inspectBotData();
      const sessHint = info.sessions.exists
        ? `${info.sessions.count} · ${fmtBytes(info.sessions.bytes)}`
        : 'ninguna';
      const setHint = info.settings.exists ? fmtBytes(info.settings.bytes) : 'por defecto';
      const tmpHint = info.temp.exists
        ? `${info.temp.files} archivo(s) · ${fmtBytes(info.temp.bytes)}`
        : bot.logs.length
          ? `${bot.logs.length} líneas en consola`
          : 'limpio';

      const options = [
        {
          label: 'Eliminar TODOS los datos',
          hint: info.hasAnyData ? `Fábrica · ${fmtBytes(info.totalBytes)}` : 'sin datos',
          value: 'all',
          key: '1',
        },
        {
          label: 'Limpiar sin cerrar sesión',
          hint: 'Conserva sesión y permisos',
          value: 'keepSession',
          key: '2',
        },
        { label: 'Solo ajustes', hint: setHint, value: 'settings', key: '3' },
        { label: 'Solo caché y logs', hint: tmpHint, value: 'temp', key: '4' },
        { label: 'Volver', hint: '', value: 'back', key: '0' },
      ];

      const choice = await select({
        header: () => [
          ...title('Eliminar datos'),
          field('Sesiones', info.sessions.exists ? c.white(sessHint) : c.dim('ninguna'), 11),
          field('Ajustes', info.settings.exists ? c.white(setHint) : c.dim('por defecto'), 11),
          field('Temporales', info.temp.exists ? c.white(tmpHint) : c.dim(tmpHint), 11),
          field('Total', info.totalBytes ? c.bold(fmtBytes(info.totalBytes)) : c.dim('0 B'), 11),
        ],
        options,
        back: 'back',
        preview: (value) => (value === 'back' ? [] : para(DESCRIPTIONS[value].preview, c.dim)),
      });

      if (choice === 'back') return;

      if (choice === 'temp') {
        const res = wipeBotData(WIPE_PRESETS.temp);
        clearBotLogs();
        refreshStats(0);
        await message(() => [
          ...title('Eliminar datos › Caché y logs'),
          res.ok
            ? ' ' + c.green(`✔ Caché y logs limpiados (${fmtBytes(res.freedBytes)} liberados).`)
            : ' ' + c.red(`✖ No se pudo limpiar: ${res.failed.join(', ')}`),
        ]);
        continue;
      }

      if (choice === 'all' && !info.hasAnyData && !bot.logs.length) {
        await message(() => [
          ...title('Eliminar datos'),
          ' ' + c.dim('No hay datos guardados para eliminar.'),
        ]);
        continue;
      }
      if (choice === 'settings' && !info.settings.exists) {
        await message(() => [
          ...title('Eliminar datos'),
          ' ' + c.dim('No hay archivo settings.json guardado.'),
        ]);
        continue;
      }

      const meta = DESCRIPTIONS[choice];
      const wasRunning = isRunning();
      const ok = await confirm(
        () => [
          ...title('Eliminar datos › Confirmar'),
          ...para(`Vas a eliminar ${meta.name}.`),
          ...para(meta.preview, c.dim),
        ],
        '¿Eliminar definitivamente?',
        'Sí, eliminar',
        'No, cancelar'
      );
      if (!ok) continue;

      if (wasRunning && meta.stopsBot) await stopBot();
      const res = wipeBotData(WIPE_PRESETS[choice]);
      if (choice === 'all' || choice === 'keepSession') {
        clearBotLogs();
        bot.notice = '';
        bot.qrText = '';
        bot.pairingCode = '';
      }
      if (
        wasRunning &&
        meta.stopsBot &&
        meta.restartsBot &&
        readSession(loadSettings().activeSession).registered
      ) {
        startBot();
      }
      refreshStats(0);

      await message(() => [
        ...title('Eliminar datos'),
        ...(res.ok
          ? para(`✔ Eliminado correctamente (${fmtBytes(res.freedBytes)} liberados).`, c.green)
          : para(`✖ No se pudo eliminar: ${res.failed.join(', ')}`, c.red)),
      ]);

      if (choice === 'all') return;
    }
  }

  // ───────────────────────── salida ─────────────────────────

  let closing = false;

  async function shutdown(code = 0) {
    if (!closing) {
      closing = true;
      if (isRunning()) {
        await Promise.race([stopBot(), new Promise((resolve) => setTimeout(resolve, 5000))]);
      }
      killBotNow();
      restoreTerminal();
    }
    process.exit(code);
  }

  async function quitFlow() {
    if (isRunning()) {
      const ok = await confirm(
        () => [
          ...title('Salir'),
          ...para('El bot está encendido y se apagará al cerrar el panel.'),
        ],
        '¿Salir y detener el bot?'
      );
      if (!ok) return;
    }
    await shutdown(0);
  }

  process.on('exit', () => {
    killBotNow();
    restoreTerminal();
  });
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(signal, () => void shutdown(0));
  }
  process.on('uncaughtException', (error) => {
    killBotNow();
    restoreTerminal();
    console.error('\n El panel se cerró por un error inesperado:\n', error);
    process.exit(1);
  });

  // ───────────────────────── arranque ─────────────────────────

  migrateLegacySession();

  initTerminal((key) => {
    if (key.ctrl && key.name === 'c') {
      void shutdown(0);
      return true;
    }
    if (key.ctrl && key.name === 'l') {
      process.stdout.write('\u001b[2J');
      draw();
      return true;
    }
    return false;
  });

  const shortcuts = {
    start: 'start',
    iniciar: 'start',
    consola: 'console',
    console: 'console',
    sesiones: 'sessions',
    sessions: 'sessions',
    eliminar: 'delete',
    delete: 'delete',
    actualizar: 'update',
    update: 'update',
    ajustes: 'settings',
    settings: 'settings',
    config: 'settings',
    datos: 'wipe',
    borrar: 'wipe',
    reset: 'wipe',
    wipe: 'wipe',
  };
  let next = shortcuts[(process.argv[2] || '').toLowerCase()] ?? null;

  panelLog('Panel de Audio-Bot listo.');

  while (true) {
    const action = next ?? (await mainMenu());
    next = null;

    try {
      switch (action) {
        case 'start':
          await startFlow();
          break;
        case 'console':
          await openConsole();
          break;
        case 'sessions':
          await sessionsScreen();
          break;
        case 'delete':
          await deleteSessionsScreen();
          break;
        case 'update':
          await updateScreen();
          break;
        case 'settings':
          await settingsScreen();
          break;
        case 'wipe':
          await wipeDataScreen();
          break;
        case 'stop':
          await stopBot();
          break;
        case 'quit':
          await quitFlow();
          break;
      }
    } catch (error) {
      await message(() => [...title('Error'), ' ' + c.red(String(error?.message || error))]);
    }
  }
}
