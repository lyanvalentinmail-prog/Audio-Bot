# 🔊 Audio-Bot — Stickers con Audio en WhatsApp (Termux + Baileys)

Bot ligero en **Node.js** pensado para ejecutarse directamente en **Termux (Android)** o Linux, vincularse a WhatsApp mediante **Pairing Code** (código de 8 caracteres sin necesidad de escanear QR con otro teléfono) y convertir cualquier video en un **Sticker con Audio** nativo de WhatsApp usando el comando **`.s2`**.

---

## ✨ Características

- 🔗 **Vinculación por Pairing Code**: solicita tu número con código de país en consola (o desde `.env`) y genera el código de 8 dígitos para vincular en el mismo celular.
- 🎬 **Comando `.s2`**: convierte videos cortos en **stickers animados con sonido** usando la estructura Protobuf nativa de WhatsApp (`Message.audioStickerMessage` campo `134` + `StickerMessage.audioMessage` campo `26` + `streamingSidecar`).
- 📱 **100 % compatible con Termux**: sin dependencias nativas en C++/Python (`sharp`, `canvas` o `webpmux`); inyección de metadatos EXIF en JavaScript puro + `ffmpeg`.
- 📐 **Modos de encuadre**:
  - `.s2` → recorte cuadrado centrado `512×512` (por defecto).
  - `.s2 full` → mantiene el encuadre completo con bordes transparentes.
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

## 💬 Uso del comando `.s2`

| Acción | Cómo usarlo |
| --- | --- |
| **Enviar video directo** | Adjunta un video y escribe **`.s2`** en el comentario (caption). |
| **Responder a un video** | Responde (*reply*) a cualquier video del chat escribiendo **`.s2`**. |
| **Sin recortar bordes** | Usa **`.s2 full`** (o `.s2 completo`) para conservar todo el video con márgenes transparentes. |

- Si el video no tiene pista de audio, el bot enviará igualmente el sticker animado WebP.
- Por defecto recorta videos largos a los primeros `10` segundos y ajusta calidad/FPS automáticamente para no superar el límite de tamaño de WhatsApp.

---

## ⚙️ Configuración opcional (`.env`)

Puedes copiar `.env.example` a `.env` para personalizar opciones:

```bash
cp .env.example .env
```

| Variable | Por defecto | Descripción |
| --- | --- | --- |
| `PHONE_NUMBER` | *(vacío)* | Número con código de país para no pedirlo por consola |
| `COMMAND` | `.s2` | Comando disparador |
| `STICKER_PACK` | `Audio-Bot` | Nombre del paquete mostrado al tocar el sticker |
| `STICKER_AUTHOR` | `WhatsApp Audio Sticker` | Autor del paquete de stickers |
| `MAX_SECONDS` | `10` | Duración máxima del sticker/audio en segundos |
| `MAX_WEBP_BYTES` | `900000` | Peso máximo del archivo `.webp` animado |
| `ALLOW_SELF` | `true` | Permite usar `.s2` desde el propio número vinculado |

---

## 🧪 Pruebas

```bash
npm test
```
