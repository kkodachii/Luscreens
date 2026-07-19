/**
 * Resolve 111Movies / Vidlove stream URLs server-side so Luscreens can play
 * them in a first-party <video> (cross-origin iframes cook the plugs).
 */

const https = require('https');
const http = require('http');
const crypto = require('crypto');
const { URL } = require('url');

const STREAM_API = 'https://momlover.notyourtype.dad';
const UPSTREAM = 'https://player.vidlove.cc';
const GCM_KEY = 'Sn00pD0g#RESP_B4SE_K3y_2026!';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const PLUGS = ['fabric', 'moviebox', 'cline', 'zebra', 'self'];

/** Prefer IPv4 — some hosts fail on Render's IPv6 path. */
const httpsAgent = new https.Agent({ family: 4, keepAlive: true });
const httpAgent = new http.Agent({ family: 4, keepAlive: true });

function requestOrigin(req) {
  const proto = String(req.headers['x-forwarded-proto'] || req.protocol || 'https')
    .split(',')[0]
    .trim();
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return `${proto}://${host}`;
}

function fetchJsonLegacy(targetUrl, options = {}) {
  const method = options.method || 'GET';
  const body = options.body || null;
  const headers = {
    'User-Agent': UA,
    Accept: 'application/json, */*',
    Origin: UPSTREAM,
    Referer: `${UPSTREAM}/`,
    ...(options.headers || {}),
  };
  if (body && !headers['Content-Length'] && !headers['content-length']) {
    headers['Content-Length'] = Buffer.byteLength(body);
  }

  return new Promise((resolve) => {
    let settled = false;
    const done = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    try {
      const parsed = new URL(targetUrl);
      const lib = parsed.protocol === 'https:' ? https : http;
      const agent = parsed.protocol === 'https:' ? httpsAgent : httpAgent;
      const req = lib.request(
        {
          protocol: parsed.protocol,
          hostname: parsed.hostname,
          port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
          path: `${parsed.pathname}${parsed.search}`,
          method,
          headers,
          agent,
          timeout: 20000,
        },
        (res) => {
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
            done({ status: res.statusCode || 502, json, raw, error: null });
          });
        }
      );
      req.on('error', (err) => {
        done({
          status: 0,
          json: null,
          raw: '',
          error: err && err.message ? err.message : 'request error',
        });
      });
      req.on('timeout', () => {
        req.destroy(new Error('timeout'));
      });
      if (body) req.write(body);
      req.end();
    } catch (err) {
      done({
        status: 0,
        json: null,
        raw: '',
        error: err && err.message ? err.message : 'request setup failed',
      });
    }
  });
}

async function fetchJson(targetUrl, options = {}) {
  const method = options.method || 'GET';
  const body = options.body || null;
  const headers = {
    'User-Agent': UA,
    Accept: 'application/json, */*',
    Origin: UPSTREAM,
    Referer: `${UPSTREAM}/`,
    ...(options.headers || {}),
  };

  // Prefer global fetch when present; fall back to IPv4-forced http(s).
  if (typeof fetch === 'function') {
    try {
      const res = await fetch(targetUrl, {
        method,
        headers,
        body: body || undefined,
        redirect: 'follow',
      });
      const raw = await res.text();
      let json = null;
      try {
        json = raw ? JSON.parse(raw) : null;
      } catch {
        json = null;
      }
      return { status: res.status, json, raw, error: null };
    } catch (err) {
      // Fall through to legacy IPv4 agent
      const legacy = await fetchJsonLegacy(targetUrl, options);
      if (!legacy.error) return legacy;
      return {
        status: 0,
        json: null,
        raw: '',
        error:
          (err && err.message ? err.message : 'fetch failed') +
          (legacy.error ? ` / ${legacy.error}` : ''),
      };
    }
  }

  return fetchJsonLegacy(targetUrl, options);
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

async function obtainStreamToken() {
  let last = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    last = await fetchJson(`${STREAM_API}/auth/generate-token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientData: {} }),
    });
    if (last.json?.token) {
      return last.json.token;
    }
    // Brief backoff for rate limits / cold starts
    await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
  }

  const preview = String(last?.raw || '')
    .replace(/\s+/g, ' ')
    .slice(0, 120);
  const err = new Error(
    `Failed to obtain stream token (status=${last?.status ?? 0}${
      last?.error ? `, err=${last.error}` : ''
    })`
  );
  err.details = {
    status: last?.status ?? 0,
    error: last?.error || null,
    preview: preview || null,
  };
  throw err;
}

async function resolveMovies111Stream({ mediaType, id, season, episode, origin }) {
  const token = await obtainStreamToken();

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
        errors.push(`${plug}:${res.status}${res.error ? `:${res.error}` : ''}`);
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
      console.error('movies111 resolve failed', err && err.message ? err.message : err, err && err.details);
      res.status(502).json({
        ok: false,
        error: err && err.message ? err.message : 'resolve failed',
        details: err && err.details ? err.details : undefined,
      });
    }
  });
}

module.exports = { mountMovies111Resolve, resolveMovies111Stream };
