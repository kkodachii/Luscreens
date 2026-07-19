/**
 * Resolve 111Movies / Vidlove stream URLs server-side so Luscreens can play
 * them in a first-party <video> (cross-origin iframes cook the plugs).
 */

const https = require('https');
const http = require('http');
const crypto = require('crypto');

const STREAM_API = 'https://momlover.notyourtype.dad';
const UPSTREAM = 'https://player.vidlove.cc';
const GCM_KEY = 'Sn00pD0g#RESP_B4SE_K3y_2026!';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const PLUGS = ['fabric', 'moviebox', 'cline', 'zebra', 'self'];

function requestOrigin(req) {
  const proto = String(req.headers['x-forwarded-proto'] || req.protocol || 'https')
    .split(',')[0]
    .trim();
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return `${proto}://${host}`;
}

function fetchJson(targetUrl, options = {}) {
  const method = options.method || 'GET';
  const body = options.body || null;
  const headers = {
    'User-Agent': UA,
    Accept: 'application/json, */*',
    Origin: UPSTREAM,
    Referer: `${UPSTREAM}/`,
    ...(options.headers || {}),
  };
  if (body && !headers['Content-Length']) {
    headers['Content-Length'] = Buffer.byteLength(body);
  }

  return new Promise((resolve, reject) => {
    const lib = targetUrl.startsWith('https') ? https : http;
    const req = lib.request(targetUrl, { method, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try {
          json = raw ? JSON.parse(raw) : null;
        } catch {
          json = null;
        }
        resolve({ status: res.statusCode || 502, json, raw });
      });
    });
    req.on('error', reject);
    req.setTimeout(20000, () => req.destroy(new Error('timeout')));
    if (body) req.write(body);
    req.end();
  });
}

function decryptGcm(payloadB64) {
  const buf = Buffer.from(payloadB64, 'base64');
  if (buf.length < 44) {
    throw new Error('Invalid encrypted payload');
  }
  const salt = buf.subarray(0, 16);
  const iv = buf.subarray(16, 28);
  const tag = buf.subarray(buf.length - 16);
  const data = buf.subarray(28, buf.length - 16);
  const key = crypto
    .createHash('sha256')
    .update(Buffer.concat([Buffer.from(GCM_KEY, 'utf8'), salt]))
    .digest();
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(data), decipher.final()]);
  return JSON.parse(plain.toString('utf8'));
}

function pickSource(data) {
  const sources = Array.isArray(data?.sources) ? data.sources : [];
  const scored = sources
    .map((s) => {
      const url = typeof s?.url === 'string' ? s.url : typeof s?.file === 'string' ? s.file : null;
      if (!url || !/^https?:\/\//i.test(url)) return null;
      const type = String(s?.type || s?.format || '').toLowerCase();
      const isHls = type === 'hls' || /\.m3u8(\?|$)/i.test(url) || /m3u8/i.test(url);
      const quality = String(s?.quality || s?.label || '');
      let rank = isHls ? 100 : 50;
      if (/1080/.test(quality)) rank += 20;
      else if (/720/.test(quality)) rank += 10;
      else if (/auto/i.test(quality)) rank += 15;
      return { url, type: isHls ? 'hls' : 'mp4', quality, plugRank: rank };
    })
    .filter(Boolean)
    .sort((a, b) => b.plugRank - a.plugRank);
  return scored[0] || null;
}

function proxifyStreamUrl(url, origin) {
  try {
    const u = new URL(url);
    if (/ballerinacappuccinalovestungtungtungsahur\.com/i.test(u.host)) {
      return `${origin}/m3u8-proxy${u.pathname}${u.search}`;
    }
    if (/\.m3u8(\?|$)/i.test(u.pathname) || /m3u8/i.test(u.pathname + u.search)) {
      return `${origin}/m3u8-proxy/m3u8-proxy.m3u8?url=${encodeURIComponent(url)}`;
    }
  } catch {
    // keep original
  }
  return url;
}

async function resolveMovies111Stream({ mediaType, id, season, episode, origin }) {
  const tokenRes = await fetchJson(`${STREAM_API}/auth/generate-token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientData: {} }),
  });
  const token = tokenRes.json?.token;
  if (!token) {
    throw new Error('Failed to obtain stream token');
  }

  const kind = mediaType === 'tv' ? 'tv' : 'movie';
  const errors = [];

  for (const plug of PLUGS) {
    const path =
      kind === 'tv'
        ? `/${plug}/tv/${id}/${season}/${episode}`
        : `/${plug}/movie/${id}`;
    try {
      const res = await fetchJson(`${STREAM_API}${path}`, {
        headers: {
          'x-request-token': token,
          'x-response-encryption': 'aes-gcm',
        },
      });
      if (res.status >= 400 || !res.json) {
        errors.push(`${plug}:${res.status}`);
        continue;
      }
      let data = res.json;
      if ((data.v === 'gcm' || data.v === 4) && data.payload) {
        data = decryptGcm(data.payload);
      }
      if (data.success === false) {
        errors.push(`${plug}:fail`);
        continue;
      }
      const source = pickSource(data);
      if (!source) {
        errors.push(`${plug}:nosrc`);
        continue;
      }
      const masterUrl =
        source.type === 'hls' ? proxifyStreamUrl(source.url, origin) : source.url;
      return {
        masterUrl,
        type: source.type,
        quality: source.quality || null,
        plug,
        tmdbId: data.tmdbId ?? id,
        imdbId: data.imdbId ?? null,
      };
    } catch (err) {
      errors.push(`${plug}:${err && err.message ? err.message : 'err'}`);
    }
  }

  const err = new Error('No 111Movies plugs available');
  err.details = errors;
  throw err;
}

function mountMovies111Resolve(app) {
  app.get('/movies111/resolve', async (req, res) => {
    try {
      const mediaType = String(req.query.type || req.query.mediaType || 'movie').toLowerCase();
      const id = String(req.query.id || '').trim();
      const season = Number(req.query.season || 1);
      const episode = Number(req.query.episode || 1);
      if (!id) {
        return res.status(400).json({ error: 'id required' });
      }
      if (mediaType === 'tv' && (!season || !episode)) {
        return res.status(400).json({ error: 'season and episode required for tv' });
      }

      const result = await resolveMovies111Stream({
        mediaType,
        id,
        season,
        episode,
        origin: requestOrigin(req),
      });
      res.setHeader('access-control-allow-origin', '*');
      res.setHeader('cache-control', 'private, max-age=30');
      return res.json({ ok: true, ...result });
    } catch (err) {
      console.error('movies111 resolve failed', err && err.message ? err.message : err);
      res.status(502).json({
        ok: false,
        error: err && err.message ? err.message : 'resolve failed',
        details: err && err.details ? err.details : undefined,
      });
    }
  });
}

module.exports = { mountMovies111Resolve, resolveMovies111Stream };
