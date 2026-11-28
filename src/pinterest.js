/**
 * Descargador de videos de Pinterest (compatible con enlaces cortos `pin.it/...`,
 * enlaces completos `pinterest.com/pin/...`, dominios regionales `es.pinterest.com`, `mx.pinterest.com`,
 * Idea Pins / Story Pins y enlaces directos `v.pinimg.com/videos/...`).
 * Cero dependencias externas: usa `fetch` nativo de Node.js 18+.
 */

const PINTEREST_URL_REGEX =
  /https?:\/\/(?:(?:[a-z]{2,3}|www)\.)?(?:pinterest\.[a-z]{2,}(?:\.[a-z]{2})?|pin\.it|v\d*\.pinimg\.com\/videos)\/[^\s<>"')]+/i;

const DESKTOP_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  'Accept-Language': 'es-ES,es;q=0.9,en-US;q=0.8,en;q=0.7',
  Accept:
    'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Cache-Control': 'no-cache',
};

/**
 * Extrae el primer enlace válido de Pinterest presente en un texto (o devuelve `null`).
 */
export function extractPinterestUrl(text) {
  if (!text || typeof text !== 'string') return null;
  const match = PINTEREST_URL_REGEX.exec(text);
  if (!match) return null;
  return match[0].replace(/[.,;!?]+$/, '');
}

export function extractPinId(input) {
  if (!input || typeof input !== 'string') return null;
  const match = input.match(/\/pin\/(?:[\w-]+--)?(\d+)/i);
  return match ? match[1] : null;
}

export function unescapePinterestHtml(rawHtml) {
  if (!rawHtml || typeof rawHtml !== 'string') return '';
  return rawHtml
    .replace(/\\\\u002[fF]/g, '/')
    .replace(/\\u002[fF]/g, '/')
    .replace(/\\\\\//g, '/')
    .replace(/\\\//g, '/')
    .replace(/\\u0026/gi, '&')
    .replace(/&amp;/g, '&');
}

function cleanMediaUrl(url) {
  if (!url || typeof url !== 'string') return '';
  return url
    .replace(/\\u002[fF]/g, '/')
    .replace(/\\\//g, '/')
    .replace(/\\u0026/gi, '&')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '')
    .trim();
}

/**
 * Convierte una lista HLS `.m3u8` de Pinterest en URLs candidatas directas `.mp4`.
 */
export function getHlsToMp4Candidates(hlsUrl) {
  if (!hlsUrl || typeof hlsUrl !== 'string') return [];
  const cleaned = cleanMediaUrl(hlsUrl);
  if (!/\.m3u8(\?.*)?$/i.test(cleaned)) return [];
  const withoutQuery = cleaned.split('?')[0];
  const candidates = [];

  if (withoutQuery.includes('/hls/')) {
    candidates.push(withoutQuery.replace('/hls/', '/720p/').replace(/\.m3u8$/i, '.mp4'));
    candidates.push(withoutQuery.replace('/hls/', '/expMp4/').replace(/\.m3u8$/i, '.mp4'));
    candidates.push(withoutQuery.replace('/hls/', '/expMp4/').replace(/\.m3u8$/i, '_720w.mp4'));
  } else {
    candidates.push(withoutQuery.replace(/\.m3u8$/i, '.mp4'));
  }

  return Array.from(new Set(candidates));
}

function scoreMp4Url(url) {
  let score = 0;
  if (/\/v1\.pinimg\.com\//i.test(url)) score += 10;
  // Preferir H.264/AVC (720p / expMp4) sobre HEVC y resoluciones óptimas para sticker 512x512
  if (/\/720p\/|\/expMp4\//i.test(url)) score += 50;
  else if (/\/1080p\//i.test(url)) score += 40;
  else if (/\/hevcMp4/i.test(url)) score -= 20;
  else if (/\/mc\//i.test(url)) score += 20;

  if (/\/720p\/|_720w\./i.test(url)) score += 90;
  else if (/\/1080p\/|_1080w\./i.test(url)) score += 80;
  else if (/\/540p\/|_540w\./i.test(url)) score += 30;
  else if (/\/480p\/|_480w\./i.test(url)) score += 10;
  else if (/\/360p\/|_360w\./i.test(url)) score -= 20;
  return score;
}

function pickFromVideoList(videoList) {
  if (!videoList || typeof videoList !== 'object') return { mp4: null, hls: null };
  const preferredKeys = [
    'V_720P',
    'V_1080P',
    'V_EXP7',
    'V_EXP6',
    'V_EXP5',
    'V_480P',
    'V_360P',
  ];

  let bestMp4 = null;
  let bestHls = null;

  for (const key of preferredKeys) {
    const entry = videoList[key];
    if (entry && typeof entry.url === 'string') {
      const u = cleanMediaUrl(entry.url);
      if (/\.mp4(\?|$)/i.test(u)) {
        bestMp4 = u;
        break;
      }
    }
  }

  for (const [key, entry] of Object.entries(videoList)) {
    if (!entry || typeof entry.url !== 'string') continue;
    const u = cleanMediaUrl(entry.url);
    if (/\.mp4(\?|$)/i.test(u) && !bestMp4) {
      bestMp4 = u;
    } else if (/\.m3u8(\?|$)/i.test(u) && (!bestHls || key === 'V_HLSV4')) {
      bestHls = u;
    }
  }

  return { mp4: bestMp4, hls: bestHls };
}

function parseJsonLdVideos(html) {
  const mp4s = [];
  const hlsList = [];
  let title = '';
  let author = '';

  const scriptRegex =
    /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match;

  function walk(node) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    const rawType = node['@type'];
    const types = Array.isArray(rawType) ? rawType : [rawType];
    if (types.includes('VideoObject')) {
      if (!title && typeof node.name === 'string') title = node.name;
      if (!author && typeof node.author?.name === 'string') author = node.author.name;
      if (typeof node.contentUrl === 'string') {
        const u = cleanMediaUrl(node.contentUrl);
        if (/\.mp4(\?|$)/i.test(u)) mp4s.push(u);
        else if (/\.m3u8(\?|$)/i.test(u)) hlsList.push(u);
      }
    }
    if (node['@graph']) walk(node['@graph']);
  }

  while ((match = scriptRegex.exec(html)) !== null) {
    try {
      walk(JSON.parse(match[1]));
    } catch {
      // Ignorar bloque malformado
    }
  }

  return { mp4s, hlsList, title, author };
}

function parsePwsAndRelayJson(html, targetPinId = null) {
  const roots = [];
  const jsonRegex = /<script\b[^>]*type=["']application\/json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = jsonRegex.exec(html)) !== null) {
    const raw = match[1]?.trim();
    if (!raw) continue;
    try {
      roots.push(JSON.parse(raw));
    } catch {
      // Ignorar script no válido
    }
  }

  const relayRegex =
    /window\.__PWS_RELAY_REGISTER_COMPLETED_REQUEST__\(\s*["'][^"']+["']\s*,\s*(\{[\s\S]*?\})\s*\)\s*;?/g;
  while ((match = relayRegex.exec(html)) !== null) {
    try {
      roots.push(JSON.parse(match[1]));
    } catch {
      // Ignorar relay malformado
    }
  }

  if (!roots.length) return { mp4s: [], hlsList: [], hasImageOnly: false, title: '', author: '' };

  function findPinNode(node) {
    if (!node || typeof node !== 'object' || !targetPinId) return null;
    if (Array.isArray(node)) {
      for (const item of node) {
        const hit = findPinNode(item);
        if (hit) return hit;
      }
      return null;
    }
    if (
      (String(node.id || '') === targetPinId || String(node.entityId || '') === targetPinId) &&
      (node.videos ||
        node.video_list ||
        node.videoList ||
        node.story_pin_data ||
        node.storyPinData ||
        node.images)
    ) {
      return node;
    }
    if (node.pins && typeof node.pins === 'object' && node.pins[targetPinId]) {
      return node.pins[targetPinId];
    }
    for (const val of Object.values(node)) {
      if (val && typeof val === 'object') {
        const hit = findPinNode(val);
        if (hit) return hit;
      }
    }
    return null;
  }

  function collectFrom(startNode) {
    const mp4s = [];
    const hlsList = [];
    let hasImage = false;
    let title = '';
    let author = '';

    function traverse(node) {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) {
        for (const item of node) traverse(item);
        return;
      }

      if (!title) {
        const t = node.pin_title || node.pinTitle || node.title || node.grid_title;
        if (typeof t === 'string' && t.trim() && !/^pinterest$/i.test(t.trim())) {
          title = t.trim();
        }
      }
      if (!author) {
        const a =
          node.pinner?.username ||
          node.native_creator?.username ||
          node.pinner?.full_name ||
          node.nativeCreator?.fullName;
        if (typeof a === 'string' && a.trim()) author = a.trim();
      }

      const vList = node.video_list || node.videoList;
      if (vList && typeof vList === 'object') {
        const picked = pickFromVideoList(vList);
        if (picked.mp4) mp4s.push(picked.mp4);
        if (picked.hls) hlsList.push(picked.hls);
      }

      if (Array.isArray(node.videoUrls)) {
        for (const u of node.videoUrls) {
          if (typeof u !== 'string') continue;
          const cleaned = cleanMediaUrl(u);
          if (/\.mp4(\?|$)/i.test(cleaned)) mp4s.push(cleaned);
          else if (/\.m3u8(\?|$)/i.test(cleaned)) hlsList.push(cleaned);
        }
      }

      if (node.images && typeof node.images === 'object') {
        hasImage = true;
      }

      for (const val of Object.values(node)) {
        if (val && typeof val === 'object') traverse(val);
      }
    }

    traverse(startNode);
    return { mp4s, hlsList, hasImageOnly: hasImage && mp4s.length === 0 && hlsList.length === 0, title, author };
  }

  const combinedRoot = roots.length === 1 ? roots[0] : { roots };
  const pinSubtree = findPinNode(combinedRoot);
  if (pinSubtree) {
    const subRes = collectFrom(pinSubtree);
    if (subRes.mp4s.length > 0 || subRes.hlsList.length > 0) {
      return subRes;
    }
  }
  return collectFrom(combinedRoot);
}

/**
 * Extrae las URLs MP4 ordenadas por calidad a partir de uno o varios bloques HTML de Pinterest.
 */
export function extractPinterestVideoCandidatesFromHtml(htmlSources, pinId = null) {
  const list = Array.isArray(htmlSources) ? htmlSources.filter(Boolean) : [htmlSources].filter(Boolean);
  const mp4Candidates = [];
  const hlsCandidates = [];
  let title = '';
  let author = '';
  let sawImagePin = false;

  for (const rawHtml of list) {
    const html = unescapePinterestHtml(rawHtml);

    // Capa 1: JSON-LD VideoObject
    const l1 = parseJsonLdVideos(html);
    if (l1.title && !title) title = l1.title;
    if (l1.author && !author) author = l1.author;
    mp4Candidates.push(...l1.mp4s);
    hlsCandidates.push(...l1.hlsList);

    // Capa 2: __PWS_DATA__ / Relay SSR / story_pin_data / video_list
    const l2 = parsePwsAndRelayJson(html, pinId);
    if (l2.title && !title) title = l2.title;
    if (l2.author && !author) author = l2.author;
    if (l2.hasImageOnly) sawImagePin = true;
    mp4Candidates.push(...l2.mp4s);
    hlsCandidates.push(...l2.hlsList);

    // Capa 3: Regex directa sobre v*.pinimg.com/videos/...mp4
    const directMp4Matches =
      html.match(/https?:\/\/v\d*\.pinimg\.com\/videos\/[^"'\s<>\\]+\.mp4/gi) || [];
    for (const m of directMp4Matches) {
      mp4Candidates.push(cleanMediaUrl(m));
    }

    // Capa 4: Regex HLS sobre v*.pinimg.com/videos/...m3u8
    const directHlsMatches =
      html.match(/https?:\/\/v\d*\.pinimg\.com\/videos\/[^"'\s<>\\]+\.m3u8/gi) || [];
    for (const h of directHlsMatches) {
      hlsCandidates.push(cleanMediaUrl(h));
    }
  }

  const uniqueMp4 = Array.from(new Set(mp4Candidates.filter(Boolean)));
  uniqueMp4.sort((a, b) => scoreMp4Url(b) - scoreMp4Url(a));

  for (const hls of Array.from(new Set(hlsCandidates.filter(Boolean)))) {
    for (const converted of getHlsToMp4Candidates(hls)) {
      if (!uniqueMp4.includes(converted)) {
        uniqueMp4.push(converted);
      }
    }
  }

  return {
    mp4Urls: uniqueMp4,
    isImageOnly: uniqueMp4.length === 0 && sawImagePin,
    title,
    author,
  };
}

async function fetchTextSafe(url, fetchImpl) {
  try {
    const res = await fetchImpl(url, {
      method: 'GET',
      redirect: 'follow',
      headers: DESKTOP_HEADERS,
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return { text: null, finalUrl: res.url || url };
    const text = await res.text();
    return { text: text && text.length > 50 ? text : null, finalUrl: res.url || url };
  } catch {
    return { text: null, finalUrl: url };
  }
}

async function resolveViaHtmlAndEmbed(targetUrl, fetchImpl) {
  // Si ya es un enlace directo a MP4 del CDN de Pinterest
  if (/^https?:\/\/v\d*\.pinimg\.com\/videos\/.+\.mp4(\?.*)?$/i.test(targetUrl)) {
    return {
      mp4Urls: [targetUrl],
      title: '',
      author: '',
      provider: 'pinimg-direct',
    };
  }

  let pinId = extractPinId(targetUrl);
  const initial = await fetchTextSafe(targetUrl, fetchImpl);
  if (!pinId) {
    pinId =
      extractPinId(initial.finalUrl) ||
      (initial.text ? extractPinId(unescapePinterestHtml(initial.text)) : null);
  }

  const htmlSources = [];
  if (initial.text) htmlSources.push(initial.text);

  if (pinId) {
    const canonicalUrl = `https://www.pinterest.com/pin/${pinId}/`;
    const embedUrl = `https://assets.pinterest.com/ext/embed.html?id=${pinId}`;
    const [canonicalRes, embedRes] = await Promise.all([
      initial.finalUrl.startsWith(canonicalUrl)
        ? Promise.resolve({ text: null })
        : fetchTextSafe(canonicalUrl, fetchImpl),
      fetchTextSafe(embedUrl, fetchImpl),
    ]);
    if (canonicalRes.text) htmlSources.unshift(canonicalRes.text);
    if (embedRes.text) htmlSources.push(embedRes.text);
  }

  if (!htmlSources.length) {
    throw new Error('No se pudo leer la página del Pin en Pinterest.');
  }

  const parsed = extractPinterestVideoCandidatesFromHtml(htmlSources, pinId);
  if (parsed.mp4Urls.length === 0) {
    if (parsed.isImageOnly) {
      const imgErr = new Error(
        'Este enlace de Pinterest es una imagen estática (no un video). Envía el enlace de un Pin de video para hacerlo sticker con audio.'
      );
      imgErr.isImagePin = true;
      throw imgErr;
    }
    throw new Error('No se encontró pista de video MP4 en el HTML de Pinterest.');
  }

  return {
    mp4Urls: parsed.mp4Urls,
    title: parsed.title,
    author: parsed.author,
    provider: 'pinterest-html',
  };
}

async function resolveViaFallbackApis(targetUrl, fetchImpl) {
  const enc = encodeURIComponent(targetUrl);
  const endpoints = [
    {
      name: 'delirius',
      url: `https://api.delirius.online/download/pinterestdl?url=${enc}`,
      pick: (json) => {
        const d = json?.data;
        const dl = d?.download?.url || d?.video || d?.url;
        if (!dl) return null;
        const isVideo = /video|\.mp4/i.test(`${d?.download?.type || ''} ${dl}`);
        return { dl, isVideo, title: d?.title || '', author: d?.username || d?.author_name || '' };
      },
    },
    {
      name: 'vreden',
      url: `https://api.vreden.web.id/api/v1/download/pinterest?url=${enc}`,
      pick: (json) => {
        const r = json?.result;
        const media = Array.isArray(r?.media) ? r.media.find((m) => /\.mp4|video/i.test(`${m?.type} ${m?.url}`)) || r.media[0] : r;
        const dl = media?.url || r?.video || r?.url;
        if (!dl) return null;
        const isVideo = /\.mp4/i.test(dl) || /video/i.test(media?.type || '');
        return { dl, isVideo, title: r?.title || '', author: r?.author || '' };
      },
    },
    {
      name: 'siputzx',
      url: `https://api.siputzx.my.id/api/d/pinterest?url=${enc}`,
      pick: (json) => {
        const d = json?.data;
        const dl =
          (Array.isArray(d?.media_urls)
            ? d.media_urls.find((m) => /\.mp4/i.test(m?.url || ''))?.url || d.media_urls[0]?.url
            : null) || d?.url;
        if (!dl) return null;
        return { dl, isVideo: /\.mp4/i.test(dl), title: d?.title || '', author: '' };
      },
    },
  ];

  for (const ep of endpoints) {
    try {
      const res = await fetchImpl(ep.url, {
        method: 'GET',
        headers: {
          'User-Agent': DESKTOP_HEADERS['User-Agent'],
          Accept: 'application/json',
        },
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) continue;
      const json = await res.json();
      const picked = ep.pick(json);
      if (!picked?.dl) continue;
      if (!picked.isVideo) {
        const imgErr = new Error(
          'Este enlace de Pinterest es una imagen estática (no un video). Envía un Pin de video para hacerlo sticker con audio.'
        );
        imgErr.isImagePin = true;
        throw imgErr;
      }
      return {
        mp4Urls: [picked.dl],
        title: picked.title,
        author: picked.author,
        provider: `pinterest-${ep.name}`,
      };
    } catch (err) {
      if (err?.isImagePin) throw err;
    }
  }

  throw new Error('Los proveedores de respaldo no devolvieron un video de Pinterest.');
}

async function fetchVideoCandidateBuffer(url, { maxBytes, fetchImpl }) {
  const res = await fetchImpl(url, {
    method: 'GET',
    redirect: 'follow',
    headers: {
      'User-Agent': DESKTOP_HEADERS['User-Agent'],
      Referer: 'https://www.pinterest.com/',
      Accept: 'video/mp4,video/*,*/*;q=0.8',
    },
    signal: AbortSignal.timeout(45_000),
  });

  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }

  const contentType = (res.headers?.get?.('content-type') || '').toLowerCase();
  if (contentType.startsWith('image/') || contentType.includes('text/html')) {
    throw new Error(`Contenido inesperado (${contentType})`);
  }

  const contentLength = Number(res.headers?.get?.('content-length') || 0);
  if (maxBytes && contentLength > maxBytes) {
    throw new Error(
      `El video de Pinterest es demasiado pesado (${Math.round(contentLength / (1024 * 1024))} MB).`
    );
  }

  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 512) {
    throw new Error('Archivo MP4 demasiado pequeño o vacío.');
  }
  if (maxBytes && buf.length > maxBytes) {
    throw new Error(
      `El video de Pinterest supera el límite permitido (${Math.round(maxBytes / (1024 * 1024))} MB).`
    );
  }
  return buf;
}

/**
 * Resuelve y descarga en memoria un video de Pinterest a partir de su URL (`pin.it/...` o `pinterest.com/pin/...`).
 * Devuelve `{ buffer, title, author, provider }`.
 */
export async function downloadPinterestVideoBuffer(
  rawUrl,
  { maxBytes = 60 * 1024 * 1024, fetchImpl = globalThis.fetch } = {}
) {
  const cleanUrl = extractPinterestUrl(rawUrl) || String(rawUrl || '').trim();
  if (!cleanUrl) {
    throw new Error('No se proporcionó un enlace de Pinterest válido.');
  }

  let resolved = null;
  let lastError = null;

  try {
    resolved = await resolveViaHtmlAndEmbed(cleanUrl, fetchImpl);
  } catch (err) {
    if (err?.isImagePin) throw err;
    lastError = err;
  }

  if (!resolved?.mp4Urls?.length) {
    try {
      resolved = await resolveViaFallbackApis(cleanUrl, fetchImpl);
    } catch (err) {
      if (err?.isImagePin) throw err;
      lastError = err;
    }
  }

  if (!resolved?.mp4Urls?.length) {
    throw new Error(
      `No se pudo extraer el video de Pinterest (${lastError?.message || 'Pin privado o no disponible'}).`
    );
  }

  let downloadError = null;
  for (const mp4Url of resolved.mp4Urls) {
    try {
      const buffer = await fetchVideoCandidateBuffer(mp4Url, { maxBytes, fetchImpl });
      return {
        buffer,
        title: resolved.title || '',
        author: resolved.author || '',
        provider: resolved.provider,
      };
    } catch (err) {
      downloadError = err;
    }
  }

  // Si los candidatos de HTML fallaron (ej. HLS convertido no disponible), probar APIs de respaldo
  if (resolved.provider === 'pinterest-html') {
    try {
      const fallback = await resolveViaFallbackApis(cleanUrl, fetchImpl);
      for (const mp4Url of fallback.mp4Urls) {
        const buffer = await fetchVideoCandidateBuffer(mp4Url, { maxBytes, fetchImpl });
        return {
          buffer,
          title: fallback.title || resolved.title || '',
          author: fallback.author || resolved.author || '',
          provider: fallback.provider,
        };
      }
    } catch (err) {
      if (err?.isImagePin) throw err;
    }
  }

  throw new Error(
    `No se pudo descargar el archivo MP4 desde Pinterest (${downloadError?.message || 'error de red'}).`
  );
}
