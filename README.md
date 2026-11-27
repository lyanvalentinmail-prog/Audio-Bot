# 🔊 Audio-Bot — Stickers con Audio en WhatsApp (Termux + Baileys)

Bot ligero en **Node.js** pensado para ejecutarse directamente en **Termux (Android)** o Linux, vincularse a WhatsApp mediante **Pairing Code** (código de 8 caracteres sin necesidad de escanear QR con otro teléfono) y convertir cualquier video en un **Sticker con Audio** nativo de WhatsApp usando el comando **`.s2`**.

---

## ✨ Características

- 🔗 **Vinculación por Pairing Code**: solicita tu número con código de país en consola (o desde `.env`) y genera el código de 8 dígitos para vincular en el mismo celular.
- 🎬 **Comando `.s2`**: convierte videos cortos en **stickers animados con sonido visible** usando el formato nativo oficial de WhatsApp (`Message.stickerMessage` + `StickerMessage.audioMessage` campo `26`, `waveform` de 64 barras, `streamingSidecar`, `firstFrameLength` y `emojis: ["🔊"]`).
- 🔊 **Ver y extraer el sonido del sticker (`.audio` / `.sonido`)**: responde a cualquier sticker con audio con `.audio` o `.sonido` (o incluso `.s2`) para ver su onda gráfica de sonido, duración, descripción/autor y recibir su pista de audio reproducible en el chat.
- 🏷️ **Metadatos configurados por defecto**: descripción del paquete **`Made by`** y autor **`@Lyan`**.
- 📱 **100 % compatible con Termux**: sin dependencias nativas en C++/Python (`sharp`, `canvas` o `webpmux`); inyección y lectura de metadatos EXIF en JavaScript puro + `ffmpeg`.
- 📐 **Modos de encuadre y vista previa**:
  - `.s2` → recorte cuadrado centrado `512×512` (por defecto).
  - `.s2 full` → mantiene el encuadre completo con bordes transparentes.
  - `.s2 ver` → envía el sticker con sonido y además adjunta la nota de audio con su onda visible.
- 🔄 **Cola secuencial**: procesa un video a la vez para no saturar CPU ni RAM en dispositivos móviles.

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

> 💡 **Consejo para Termux:** ejecuta `termux-wake-lock` antes de iniciar el bot para evitar que Android suspenda el proceso cuando apagues la pantalla.

---

## 🚀 Ejecución y vinculación con Pairing Code

1. Inicia el bot:

   ```bash
   npm start
   ```

   *(También puedes pasar tu número directamente: `node index.js 59899123456` o configurarlo en `.env`).*

2. Ingresa tu número de WhatsApp con código de país, **sin `+`, espacios ni guiones** (ejemplo: `59899123456` o `5215512345678`).
3. En la terminal aparecerá un código de 8 caracteres como `ABCD-1234`.
4. Abre **WhatsApp** en tu teléfono:
   - Ve a **Ajustes** → **Dispositivos vinculados** → **Vincular un dispositivo**.
   - Toca abajo en **«Vincular con el número de teléfono»** e introduce el código mostrado.

La sesión quedará guardada en `./auth_info` para reconectarse automáticamente las próximas veces.

---

## 💬 Comandos disponibles

| Acción | Cómo usarlo |
| --- | --- |
| **Enviar video directo** | Adjunta un video y escribe **`.s2`** en el comentario (caption). |
| **Responder a un video** | Responde (*reply*) a cualquier video del chat escribiendo **`.s2`**. |
| **Sin recortar bordes** | Usa **`.s2 full`** (o `.s2 completo`) para conservar todo el video con márgenes transparentes. |
| **Enviar con nota de audio visible** | Usa **`.s2 ver`** para recibir el sticker con sonido + su nota de audio con onda aparte. |
| **Ver el sonido de un sticker** | Responde a cualquier sticker con **`.audio`**, **`.sonido`** o **`.s2`** para ver su onda, duración, descripción/autor y escuchar su audio. |

- En WhatsApp verás el icono **🔊** sobre el sticker para reproducir su sonido directamente al tocarlo.
- Si el video no tiene pista de audio, el bot enviará igualmente el sticker animado WebP.

---

## ⚙️ Configuración opcional (`.env`)

Puedes copiar `.env.example` a `.env` para personalizar opciones:

```bash
cp .env.example .env
```

| Variable | Por defecto | Descripción |
| --- | --- | --- |
| `PHONE_NUMBER` | *(vacío)* | Número con código de país para no pedirlo por consola |
| `COMMAND` | `.s2` | Comando para crear stickers con audio |
| `AUDIO_COMMAND` | `.audio` | Comando para ver/extraer el sonido de un sticker |
| `STICKER_PACK` | `Made by` | Descripción / nombre del paquete mostrado al tocar el sticker |
| `STICKER_AUTHOR` | `@Lyan` | Autor del paquete de stickers |
| `MAX_SECONDS` | `10` | Duración máxima del sticker/audio en segundos |
| `MAX_WEBP_BYTES` | `900000` | Peso máximo del archivo `.webp` animado |
| `ALLOW_SELF` | `true` | Permite usar comandos desde el propio número vinculado |

---

## 🧪 Pruebas

```bash
npm test
```
