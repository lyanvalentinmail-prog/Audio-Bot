# 🔊 Audio-Bot — Stickers con Audio en WhatsApp (Panel Termux + Baileys)

Bot de WhatsApp en **Node.js** con **panel de control interactivo de terminal (estilo DenjiBot)** pensado para **Termux (Android)** y Linux. Se vincula mediante **Código de 8 dígitos (Pairing Code)** o **Código QR**, convierte videos o enlaces de **TikTok** y **Pinterest** en **Stickers con Audio** nativos usando **`.s2`**, e incluye un menú de **Ajustes** en vivo con control de permisos (**Solo el dueño**, **Excluidos**, dueños, metadatos y más).

---

## ✨ Características

- 🖥️ **Panel interactivo de terminal (`npm start`)**:
  1. **Start** — inicia o reinicia el bot y permite vincular por **Código de 8 dígitos** o **Código QR**.
  2. **Consola del bot** — logs en vivo, vista de QR/código y **Dashboard** (RAM, disco, CPU, actividad y bloqueos).
  3. **Sesiones** — crea, consulta y cambia entre múltiples cuentas/sesiones de WhatsApp.
  4. **Eliminar sesiones** — borra vinculaciones guardadas.
  5. **Actualizar bot** — ejecuta `git pull` desde el propio panel y ofrece actualizar dependencias o reiniciar.
  6. **Ajustes** — configuración instantánea en caliente (sin reiniciar el bot):
     - **Solo el dueño**: restringe el bot únicamente al dueño/cuenta vinculada.
     - **Excluidos**: lista negra donde ingresas los números de teléfono de las personas que **no** pueden utilizar el bot.
     - **Dueños**: añade números adicionales con permiso total.
     - Prefijo (`.`), descripción (`Made by`), autor (`@Lyan`), segundos máximos y modo de logs.
  7. **Eliminar datos** — limpieza selectiva de caché, ajustes o restablecimiento completo.
- 🎬 **Comando `.s2`**: convierte videos cortos y enlaces de **TikTok** o **Pinterest** (`pin.it/...`, `pinterest.com/pin/...`) en **stickers animados con sonido visible** (`Message.stickerMessage` + `StickerMessage.audioMessage` campo `26`, `waveform` de 64 barras y `emojis: ["🔊"]`).
- ✂️ **`.s2 full` sin bordes negros**: recorta automáticamente las barras negras incrustadas (`cropdetect`) y preserva transparencia real RGBA (`0x00000000`).
- 🔊 **Ver y extraer el sonido del sticker (`.audio` / `.sonido`)**: responde a cualquier sticker con `.audio`, `.sonido` o `.s2` para ver su onda gráfica, duración, descripción/autor y escuchar su pista de audio.

---

## 📲 Instalación rápida en Termux

Abre **Termux** y ejecuta:

```bash
pkg update -y && pkg upgrade -y
pkg install -y nodejs-lts ffmpeg git
git clone https://github.com/lyanvalentinmail-prog/Audio-Bot.git
cd Audio-Bot
npm install
```

*(O bien ejecuta directamente `bash termux-setup.sh` dentro de la carpeta del proyecto).*

---

## 🚀 Ejecución y Panel de Control

Inicia el panel interactivo con:

```bash
npm start
```

- Muévete con las flechas `↑` `↓` y `Enter` (o pulsa los números de atajo `1`–`7` y `0`).
- Entra en **`1 Start`** para vincular tu número con **Código de 8 dígitos** o **Código QR**.
- Entra en **`6 Ajustes`** para activar **Solo el dueño** o añadir números en **Excluidos**.

*(Si ejecutas el bot en un entorno sin pantalla interactiva como PM2, `npm start` o `npm run bot` iniciará directamente el proceso del bot).*

---

## 💬 Comandos en WhatsApp

| Acción | Cómo usarlo |
| --- | --- |
| **Enviar video directo** | Adjunta un video y escribe **`.s2`** en el comentario (caption). |
| **Responder a un video** | Responde (*reply*) a cualquier video del chat escribiendo **`.s2`**. |
| **Enlace de TikTok a sticker con audio** | Escribe **`.s2 https://vm.tiktok.com/...`** (o responde `.s2` a un mensaje con link de TikTok). |
| **Enlace de Pinterest a sticker con audio** | Escribe **`.s2 https://pin.it/...`** o **`https://pinterest.com/pin/...`** (o responde `.s2` a un mensaje con link de Pinterest). |
| **Completo y sin bordes negros** | Usa **`.s2 full`** (o `.s2 completo`) para eliminar barras negras y conservar el encuadre completo transparente. |
| **Enviar con nota de audio visible** | Usa **`.s2 ver`** para recibir el sticker con sonido + su nota de audio con onda aparte. |
| **Ver el sonido de un sticker** | Responde a cualquier sticker con **`.audio`**, **`.sonido`** o **`.s2`**. |

---

## 🧪 Pruebas

```bash
npm test
```
