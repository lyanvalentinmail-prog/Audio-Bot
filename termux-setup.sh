#!/data/data/com.termux/files/usr/bin/bash
set -e

echo "=========================================="
echo "  Instalador de Audio-Bot para Termux     "
echo "=========================================="

echo "[1/3] Actualizando repositorios de Termux..."
pkg update -y && pkg upgrade -y

echo "[2/3] Instalando Node.js, FFmpeg y Git..."
pkg install -y nodejs-lts ffmpeg git

echo "[3/3] Instalando dependencias de Node.js..."
npm install

if [ ! -f .env ] && [ -f .env.example ]; then
  cp .env.example .env
  echo "Archivo .env creado a partir de .env.example"
fi

echo ""
echo "✅ Instalación completada."
echo "Inicia el bot y vincúlalo con tu código ejecutando:"
echo "   npm start"
