/**
 * Resolve 111Movies / Vidlove stream URLs server-side so Luscreens can play
 * them in a first-party <video> (cross-origin iframes cook the plugs).
 */

const https = require('https');
const http = require('http');
const crypto = require('crypto');
const { URL } = require('url');
const { warmDirectPlaylistChain } = require('./vidlove-proxy');

const STREAM_API = 'https://momlover.notyourtype.dad';
const UPSTREAM = 'https://player.vidlove.cc';
const GCM_KEY = 'Sn00pD0g#RESP_B4SE_K3y_2026!';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const PLUGS = ['fabric', 'cline', 'zebra', 'moviebox', 'self'];

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

function pickSource(data, prefer) {
  const sources = Array.isArray(data?.sources) ? data.sources : [];
  const scored = sources
    .map((s) => {
      const url = typeof s?.url === 'string' ? s.url : typeof s?.file === 'string' ? s.file : null;
      if (!url || !/^https?:\/\//i.test(url)) return null;
      const type = String(s?.type || s?.format || '').toLowerCase();
      const isHls = type === 'hls' || /\.m3u8(\?|$)/i.test(url) || /m3u8/i.test(url);
      const quality = String(s?.quality || s?.label || '');
      // Prefer HLS for browser <video>+hls.js; MP4 from this CDN often fails in Chromium.
      let rank = isHls ? 100 : 55;
      if (prefer === 'hls') {
        rank = isHls ? 100 : 40;
      } else if (prefer === 'mp4') {
        rank = isHls ? 40 : 100;
      }
      if (/1080/.test(quality)) rank += 30;
      else if (/720/.test(quality)) rank += 20;
      else if (/480/.test(quality)) rank += 10;
      else if (/auto/i.test(quality)) rank += 15;
      return { url, type: isHls ? 'hls' : 'mp4', quality, plugRank: rank };
    })
    .filter(Boolean)
    .sort((a, b) => b.plugRank - a.plugRank);
  return scored[0] || null;
}

const DIRECT_HLS_HOST_RE =
  /(primebox\.workers\.dev|hakunaymatata|onlinecoachingacademy|voxzer|finepulfe|ployan|cloudfront|bunnycdn)/i;

function proxifyStreamUrl(url, origin, type) {
  try {
    const u = new URL(url);
    if (type === 'mp4' || /\.mp4(\?|$)/i.test(u.pathname)) {
      return `${origin}/media-proxy?url=${encodeURIComponent(url)}`;
    }
    // Skip ballerina when the source is already a known CDN
    if (DIRECT_HLS_HOST_RE.test(u.host)) {
      const kind =
        type === 'hls' ||
        type === 'm3u8' ||
        /\.m3u8(\?|$)/i.test(u.pathname) ||
        /m3u8/i.test(u.pathname + u.search)
          ? 'm3u8'
          : 'ts';
      return `${origin}/m3u8-proxy/direct.${kind}?url=${encodeURIComponent(url)}`;
    }
    if (/ballerinacappuccinalovestungtungtungsahur\.com/i.test(u.host)) {
      const nested = u.searchParams.get('url');
      if (nested && /^https?:\/\//i.test(nested)) {
        try {
          if (DIRECT_HLS_HOST_RE.test(new URL(nested).host)) {
            const kind =
              /m3u8/i.test(u.pathname) || /\.m3u8(\?|$)/i.test(nested) ? 'm3u8' : 'ts';
            return `${origin}/m3u8-proxy/direct.${kind}?url=${encodeURIComponent(nested)}`;
          }
        } catch {
          // keep ballerina path
        }
      }
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

const MEDIA_PROXY_HOST_RE =
  /(hakunaymatata|primebox|voxzer|finepulfe|ployan|workers\.dev|cloudfront|bunnycdn)/i;

function mountMediaProxy(app) {
  app.options('/media-proxy', (_req, res) => {
    res.setHeader('access-control-allow-origin', '*');
    res.setHeader('access-control-allow-methods', 'GET,HEAD,OPTIONS');
    res.setHeader('access-control-allow-headers', 'Range, Accept, Origin');
    res.setHeader('access-control-expose-headers', 'Content-Length, Content-Range, Accept-Ranges');
    return res.status(204).end();
  });

  app.get('/media-proxy', (req, res) => {
    try {
      const target = String(req.query.url || '');
      if (!/^https?:\/\//i.test(target)) {
        return res.status(400).json({ error: 'url required' });
      }
      const parsed = new URL(target);
      if (!MEDIA_PROXY_HOST_RE.test(parsed.host)) {
        return res.status(400).json({ error: 'host not allowed' });
      }

      const headers = {
        'User-Agent': UA,
        Accept: '*/*',
      };
      if (req.headers.range) {
        headers.Range = req.headers.range;
      }

      const lib = parsed.protocol === 'https:' ? https : http;
      const upstreamReq = lib.request(
        {
          protocol: parsed.protocol,
          hostname: parsed.hostname,
          port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
          path: `${parsed.pathname}${parsed.search}`,
          method: 'GET',
          headers,
          agent: parsed.protocol === 'https:' ? httpsAgent : httpAgent,
          timeout: 60000,
        },
        (upstreamRes) => {
          res.status(upstreamRes.statusCode || 502);
          res.setHeader('access-control-allow-origin', '*');
          res.setHeader(
            'access-control-expose-headers',
            'Content-Length, Content-Range, Accept-Ranges'
          );
          const pass = [
            'content-type',
            'content-length',
            'content-range',
            'accept-ranges',
            'cache-control',
          ];
          for (const name of pass) {
            const value = upstreamRes.headers[name];
            if (value != null) {
              res.setHeader(name, value);
            }
          }
          if (!res.getHeader('accept-ranges')) {
            res.setHeader('accept-ranges', 'bytes');
          }
          upstreamRes.pipe(res);
        }
      );
      upstreamReq.on('error', (err) => {
        console.error('media-proxy upstream error', err && err.message ? err.message : err);
        if (!res.headersSent) {
          res.status(502).json({ error: 'media proxy failed' });
        } else {
          res.end();
        }
      });
      upstreamReq.on('timeout', () => {
        upstreamReq.destroy(new Error('timeout'));
      });
      req.on('close', () => {
        upstreamReq.destroy();
      });
      upstreamReq.end();
    } catch (err) {
      console.error('media-proxy failed', err && err.message ? err.message : err);
      if (!res.headersSent) {
        res.status(502).json({ error: 'media proxy failed' });
      }
    }
  });
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

async function tryPlug(plug, { kind, id, season, episode, token, prefer, origin }) {
  const path =
    kind === 'tv' ? `/${plug}/tv/${id}/${season}/${episode}` : `/${plug}/movie/${id}`;
  const res = await fetchJson(`${STREAM_API}${path}`, {
    headers: {
      'x-request-token': token,
      'x-response-encryption': 'aes-gcm',
    },
  });
  if (res.status >= 400 || !res.json) {
    throw new Error(`${plug}:${res.status}${res.error ? `:${res.error}` : ''}`);
  }
  let data = res.json;
  if ((data.v === 'gcm' || data.v === 4) && data.payload) {
    data = decryptGcm(data.payload);
  }
  if (data.success === false) {
    throw new Error(`${plug}:fail`);
  }
  const source = pickSource(data, prefer);
  if (!source) {
    throw new Error(`${plug}:nosrc`);
  }
  return {
    masterUrl: proxifyStreamUrl(source.url, origin, source.type),
    type: source.type,
    quality: source.quality || null,
    plug,
    tmdbId: data.tmdbId ?? id,
    imdbId: data.imdbId ?? null,
  };
}

async function resolveMovies111Stream({ mediaType, id, season, episode, origin, prefer }) {
  const token = await obtainStreamToken();

  const kind = mediaType === 'tv' ? 'tv' : 'movie';
  const plugOrder =
    prefer === 'hls'
      ? ['fabric', 'cline', 'zebra', 'moviebox', 'self']
      : PLUGS;
  const ctx = { kind, id, season, episode, token, prefer, origin };

  // Race preferred plugs in parallel — first valid source wins
  const errors = [];
  const raced = await Promise.any(
    plugOrder.slice(0, 3).map((plug) =>
      tryPlug(plug, ctx).catch((err) => {
        errors.push(err && err.message ? err.message : `${plug}:err`);
        return Promise.reject(err);
      })
    )
  ).catch(() => null);
  if (raced) {
    return raced;
  }

  for (const plug of plugOrder.slice(3)) {
    try {
      return await tryPlug(plug, ctx);
    } catch (err) {
      errors.push(err && err.message ? err.message : `${plug}:err`);
    }
  }

  const err = new Error('No 111Movies plugs available');
  err.details = errors;
  throw err;
}

function mountMovies111Resolve(app) {
  mountMediaProxy(app);

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

      const prefer = String(req.query.prefer || '').toLowerCase();

      const origin = requestOrigin(req);
      const result = await resolveMovies111Stream({
        mediaType,
        id,
        season,
        episode,
        origin,
        prefer: prefer === 'hls' || prefer === 'mp4' ? prefer : undefined,
      });

      // Prefetch master + lowest rung so first player requests are cache hits
      if (result.type === 'hls' && result.masterUrl) {
        try {
          const nested = new URL(result.masterUrl).searchParams.get('url');
          if (nested) {
            await warmDirectPlaylistChain(nested, origin);
          }
        } catch {
          // best-effort
        }
      }

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

module.exports = { mountMovies111Resolve, resolveMovies111Stream, mountMediaProxy };
