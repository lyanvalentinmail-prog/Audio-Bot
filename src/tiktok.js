/**
 * Descargador de videos de TikTok sin marca de agua (compatible con enlaces cortos
 * vm.tiktok.com, vt.tiktok.com y enlaces completos www.tiktok.com/@user/video/...).
 * Cero dependencias externas: usa `fetch` nativo de Node.js 18+.
 */

const TIKTOK_URL_REGEX =
  /https?:\/\/(?:(?:vm|vt|m|www|t)\.)?tiktok\.com\/[^\s<>"')]+/i;

const TIKWM_ORIGIN = 'https://www.tikwm.com';

const DEFAULT_UA =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36';

const DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

/**
 * Extrae el primer enlace válido de TikTok presente en un texto (o devuelve `null`).
 */
export function extractTikTokUrl(text) {
  if (!text || typeof text !== 'string') return null;
  const match = TIKTOK_URL_REGEX.exec(text);
  if (!match) return null;
  // Limpiar puntuación final común cuando pegan un link en una frase
  return match[0].replace(/[.,;!?]+$/, '');
}

function toAbsoluteUrl(url, origin = TIKWM_ORIGIN) {
  if (!url || typeof url !== 'string') return '';
  if (url.startsWith('http://') || url.startsWith('https://')) return url;
  if (url.startsWith('//')) return `https:${url}`;
  if (url.startsWith('/')) return `${origin}${url}`;
  return url;
}

/**
 * Expande enlaces acortados (`vm.tiktok.com/...`, `vt.tiktok.com/...`, `tiktok.com/t/...`)
 * siguiendo la redirección HTTP si aplica.
 */
export async function expandTikTokUrl(url, fetchImpl = globalThis.fetch) {
  if (!url) return url;
  const isShort =
    /(?:vm|vt)\.tiktok\.com/i.test(url) || /tiktok\.com\/t\//i.test(url);
  if (!isShort) return url;

  try {
    const res = await fetchImpl(url, {
      method: 'GET',
      redirect: 'manual',
      headers: { 'User-Agent': DEFAULT_UA },
      signal: AbortSignal.timeout(8_000),
    });
    const loc = res.headers?.get?.('location');
    if (loc && /^https?:\/\//i.test(loc)) {
      return loc.split('?')[0] || loc;
    }
  } catch {
    // Si falla la expansión manual, usamos la URL original directamente
  }
  return url;
}

async function resolveViaTikwmPost(targetUrl, fetchImpl) {
  const res = await fetchImpl(`${TIKWM_ORIGIN}/api/`, {
    method: 'POST',
    headers: {
      'User-Agent': DESKTOP_UA,
      Accept: 'application/json, text/plain, */*',
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      Origin: TIKWM_ORIGIN,
      Referer: `${TIKWM_ORIGIN}/`,
    },
    body: new URLSearchParams({ url: targetUrl, hd: '0' }).toString(),
    signal: AbortSignal.timeout(12_000),
  });

  if (!res.ok) {
    throw new Error(`TikWM HTTP ${res.status}`);
  }

  const json = await res.json();
  if (!json || json.code !== 0 || !json.data) {
    throw new Error(json?.msg || 'Respuesta inválida de TikWM');
  }

  const d = json.data;
  if (Array.isArray(d.images) && d.images.length > 0 && !d.play && !d.wmplay) {
    const slideshowErr = new Error(
      'Este enlace de TikTok es un carrusel de fotos (no un video). Envía un TikTok de video para convertirlo en sticker con audio.'
    );
    slideshowErr.isSlideshow = true;
    throw slideshowErr;
  }

  // Preferimos `play` (MP4 estándar sin marca de agua, más rápido de bajar y convertir en Termux)
  const videoUrl = toAbsoluteUrl(d.play || d.hdplay || d.wmplay);
  if (!videoUrl) {
    throw new Error('TikWM no devolvió URL de video.');
  }

  return {
    videoUrl,
    fallbackVideoUrl: toAbsoluteUrl(d.wmplay || d.hdplay || ''),
    title: d.title || '',
    author: d.author?.unique_id || d.author?.nickname || '',
    duration: Number(d.duration || 0),
    provider: 'tikwm-post',
  };
}

async function resolveViaTikwmGet(targetUrl, fetchImpl) {
  const apiUrl = `${TIKWM_ORIGIN}/api/?url=${encodeURIComponent(targetUrl)}&hd=0`;
  const res = await fetchImpl(apiUrl, {
    method: 'GET',
    headers: {
      'User-Agent': DESKTOP_UA,
      Accept: 'application/json, text/plain, */*',
      Referer: `${TIKWM_ORIGIN}/`,
    },
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    throw new Error(`TikWM GET HTTP ${res.status}`);
  }

  const json = await res.json();
  if (!json || json.code !== 0 || !json.data) {
    throw new Error(json?.msg || 'Respuesta inválida de TikWM GET');
  }

  const d = json.data;
  if (Array.isArray(d.images) && d.images.length > 0 && !d.play && !d.wmplay) {
    const slideshowErr = new Error(
      'Este enlace de TikTok es un carrusel de fotos (no un video). Envía un TikTok de video para convertirlo en sticker con audio.'
    );
    slideshowErr.isSlideshow = true;
    throw slideshowErr;
  }

  const videoUrl = toAbsoluteUrl(d.play || d.hdplay || d.wmplay);
  if (!videoUrl) {
    throw new Error('TikWM GET no devolvió URL de video.');
  }

  return {
    videoUrl,
    fallbackVideoUrl: toAbsoluteUrl(d.wmplay || d.hdplay || ''),
    title: d.title || '',
    author: d.author?.unique_id || d.author?.nickname || '',
    duration: Number(d.duration || 0),
    provider: 'tikwm-get',
  };
}

async function resolveViaTikMate(targetUrl, fetchImpl) {
  const res = await fetchImpl('https://api.tikmate.app/api/lookup', {
    method: 'POST',
    headers: {
      'User-Agent': DESKTOP_UA,
      Accept: 'application/json, */*',
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      Origin: 'https://tikmate.app',
      Referer: 'https://tikmate.app/',
    },
    body: new URLSearchParams({ url: targetUrl }).toString(),
    signal: AbortSignal.timeout(12_000),
  });

  if (!res.ok) {
    throw new Error(`TikMate HTTP ${res.status}`);
  }

  const data = await res.json();
  if (!data?.success || !data?.token || !data?.id) {
    throw new Error('TikMate no pudo resolver el enlace.');
  }

  return {
    videoUrl: `https://tikmate.app/download/${data.token}/${data.id}.mp4`,
    fallbackVideoUrl: '',
    title: data.desc || '',
    author: data.author_id || '',
    duration: 0,
    provider: 'tikmate',
  };
}

async function resolveViaWebPage(targetUrl, fetchImpl) {
  const res = await fetchImpl(targetUrl, {
    method: 'GET',
    redirect: 'follow',
    headers: {
      'User-Agent': DESKTOP_UA,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8',
      Referer: 'https://www.tiktok.com/',
    },
    signal: AbortSignal.timeout(12_000),
  });

  if (!res.ok) {
    throw new Error(`TikTok Web HTTP ${res.status}`);
  }

  const setCookie = res.headers?.getSetCookie?.() || [];
  const cookieHeader = Array.isArray(setCookie)
    ? setCookie.map((c) => c.split(';')[0]).join('; ')
    : '';

  const html = await res.text();
  const scriptMatch = html.match(
    /<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>([\s\S]+?)<\/script>/
  );
  if (!scriptMatch) {
    throw new Error('No se encontraron metadatos de video en la página de TikTok.');
  }

  const parsed = JSON.parse(scriptMatch[1]);
  const itemStruct =
    parsed?.__DEFAULT_SCOPE__?.['webapp.video-detail']?.itemInfo?.itemStruct;

  const playAddr =
    itemStruct?.video?.playAddr || itemStruct?.video?.downloadAddr || '';
  if (!playAddr) {
    throw new Error('No se encontró stream reproducible en la página de TikTok.');
  }

  return {
    videoUrl: playAddr,
    fallbackVideoUrl: '',
    cookieHeader,
    referer: 'https://www.tiktok.com/',
    title: itemStruct?.desc || '',
    author: itemStruct?.author?.uniqueId || '',
    duration: Number(itemStruct?.video?.duration || 0),
    provider: 'tiktok-web',
  };
}

async function fetchMediaBuffer(url, { referer, cookieHeader, maxBytes, fetchImpl }) {
  const headers = {
    'User-Agent': DESKTOP_UA,
    Accept: '*/*',
  };
  if (referer) headers.Referer = referer;
  if (cookieHeader) headers.Cookie = cookieHeader;

  const res = await fetchImpl(url, {
    method: 'GET',
    redirect: 'follow',
    headers,
    signal: AbortSignal.timeout(45_000),
  });

  if (!res.ok) {
    throw new Error(`Error HTTP ${res.status} al descargar el archivo MP4 de TikTok.`);
  }

  const contentLength = Number(res.headers?.get?.('content-length') || 0);
  if (maxBytes && contentLength > maxBytes) {
    throw new Error(
      `El video de TikTok es demasiado pesado (${Math.round(contentLength / (1024 * 1024))} MB).`
    );
  }

  const arrayBuf = await res.arrayBuffer();
  const buf = Buffer.from(arrayBuf);
  if (buf.length < 512) {
    throw new Error('El archivo descargado desde TikTok es inválido o está vacío.');
  }
  if (maxBytes && buf.length > maxBytes) {
    throw new Error(
      `El video de TikTok supera el tamaño máximo permitido (${Math.round(maxBytes / (1024 * 1024))} MB).`
    );
  }
  return buf;
}

/**
 * Resuelve y descarga en memoria un video de TikTok a partir de su URL.
 * Devuelve `{ buffer, title, author, duration, provider }`.
 */
export async function downloadTikTokVideoBuffer(
  rawUrl,
  { maxBytes = 60 * 1024 * 1024, fetchImpl = globalThis.fetch } = {}
) {
  const cleanUrl = extractTikTokUrl(rawUrl) || String(rawUrl || '').trim();
  if (!cleanUrl) {
    throw new Error('No se proporcionó un enlace de TikTok válido.');
  }

  // Probamos primero la URL directa con TikWM (acepta vm.tiktok.com / vt.tiktok.com sin viaje extra);
  // solo expandimos el redirect si el primer intento falla.
  let resolved = null;
  let lastError = null;

  try {
    resolved = await resolveViaTikwmPost(cleanUrl, fetchImpl);
  } catch (err) {
    if (err?.isSlideshow) throw err;
    lastError = err;
  }

  if (!resolved?.videoUrl) {
    const expandedUrl = await expandTikTokUrl(cleanUrl, fetchImpl);
    const candidateUrls =
      expandedUrl && expandedUrl !== cleanUrl ? [expandedUrl, cleanUrl] : [cleanUrl];

    const resolvers = [
      resolveViaTikwmPost,
      resolveViaTikwmGet,
      resolveViaTikMate,
      resolveViaWebPage,
    ];

    outer: for (const candidate of candidateUrls) {
      for (const resolver of resolvers) {
        try {
          resolved = await resolver(candidate, fetchImpl);
          if (resolved?.videoUrl) {
            break outer;
          }
        } catch (err) {
          if (err?.isSlideshow) {
            throw err;
          }
          lastError = err;
        }
      }
    }
  }

  if (!resolved?.videoUrl) {
    throw new Error(
      `No se pudo descargar el video de TikTok (${lastError?.message || 'enlace privado o no disponible'}).`
    );
  }

  try {
    const buffer = await fetchMediaBuffer(resolved.videoUrl, {
      referer: resolved.referer || `${TIKWM_ORIGIN}/`,
      cookieHeader: resolved.cookieHeader,
      maxBytes,
      fetchImpl,
    });
    return {
      buffer,
      title: resolved.title,
      author: resolved.author,
      duration: resolved.duration,
      provider: resolved.provider,
    };
  } catch (downloadErr) {
    if (resolved.fallbackVideoUrl && resolved.fallbackVideoUrl !== resolved.videoUrl) {
      const buffer = await fetchMediaBuffer(resolved.fallbackVideoUrl, {
        referer: resolved.referer || `${TIKWM_ORIGIN}/`,
        cookieHeader: resolved.cookieHeader,
        maxBytes,
        fetchImpl,
      });
      return {
        buffer,
        title: resolved.title,
        author: resolved.author,
        duration: resolved.duration,
        provider: `${resolved.provider}-fallback`,
      };
    }
    throw downloadErr;
  }
}
