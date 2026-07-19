/**
 * Same-origin reverse proxy for player.vidlove.cc embeds.
 *
 * Direct cross-origin iframes fail stream plugs. We serve the player under
 * /vidlove-proxy and proxy Vidlove's stream API hosts at our origin root
 * (the player uses `new URL(api).origin`, so path-prefixed API bases break).
 */

const https = require('https');
const http = require('http');
const { URL } = require('url');

const UPSTREAM = 'https://player.vidlove.cc';
const ALT_UPSTREAM = 'https://111movies.net';
const STREAM_API = 'https://momlover.notyourtype.dad';
const HLS_PROXY = 'https://ballerinacappuccinalovestungtungtungsahur.com';

/** Root path prefixes forwarded to STREAM_API (must not collide with auth-api). */
const STREAM_API_PREFIXES = [
  '/moviebox',
  '/cline',
  '/self',
  '/zebra',
  '/fabric',
  '/season',
];

const TEXT_TYPES = [
  'text/html',
  'text/css',
  'text/javascript',
  'application/javascript',
  'application/x-javascript',
  'application/json',
  'image/svg+xml',
];

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const httpsAgent = new https.Agent({
  family: 4,
  keepAlive: true,
  maxSockets: 64,
  keepAliveMsecs: 15000,
});
const httpAgent = new http.Agent({
  family: 4,
  keepAlive: true,
  maxSockets: 32,
});

/** Short in-memory cache for rewritten playlists (not media segments). */
const playlistCache = new Map();
const PLAYLIST_CACHE_TTL_MS = 15000;
const PLAYLIST_CACHE_MAX = 120;

function isValidPlaylistBody(text) {
  const head = String(text || '')
    .replace(/^\uFEFF/, '')
    .trimStart()
    .slice(0, 64)
    .toUpperCase();
  return head.startsWith('#EXTM3U');
}

const DIRECT_HLS_HOST_RE =
  /(primebox\.workers\.dev|hakunaymatata|onlinecoachingacademy|voxzer|finepulfe|ployan|cloudfront|bunnycdn)/i;

function isTextType(contentType) {
  const ct = String(contentType || '').toLowerCase();
  return TEXT_TYPES.some((t) => ct.includes(t));
}

function cacheGet(key) {
  const hit = playlistCache.get(key);
  if (!hit) return null;
  if (Date.now() > hit.expires) {
    playlistCache.delete(key);
    return null;
  }
  return hit;
}

function cacheSet(key, value) {
  if (playlistCache.size >= PLAYLIST_CACHE_MAX) {
    const first = playlistCache.keys().next().value;
    if (first) playlistCache.delete(first);
  }
  playlistCache.set(key, { ...value, expires: Date.now() + PLAYLIST_CACHE_TTL_MS });
}

function directPlaylistCacheKey(upstreamUrl) {
  return `/m3u8-proxy/direct.m3u8?url=${encodeURIComponent(upstreamUrl)}`;
}

/**
 * Prefetch + rewrite master (and lowest-bitrate variant) into playlist cache
 * so the player’s first requests are cache hits.
 */
async function warmDirectPlaylistChain(upstreamMasterUrl, origin) {
  if (!upstreamMasterUrl || !/^https?:\/\//i.test(upstreamMasterUrl)) {
    return null;
  }
  const masterKey = directPlaylistCacheKey(upstreamMasterUrl);
  let masterBody;
  const cachedMaster = cacheGet(masterKey);
  if (cachedMaster?.body) {
    masterBody = cachedMaster.body.toString('utf8');
  } else {
    const upstream = await fetchUpstream(upstreamMasterUrl, {
      method: 'GET',
      headers: { Accept: '*/*' },
    });
    if ((upstream.status || 500) >= 400) {
      return null;
    }
    masterBody = rewritePlaylistText(upstream.body.toString('utf8'), origin);
    if (!isValidPlaylistBody(masterBody)) {
      return null;
    }
    cacheSet(masterKey, {
      status: upstream.status || 200,
      body: Buffer.from(masterBody, 'utf8'),
    });
  }

  // Pick lowest BANDWIDTH variant (fast start); fall back to first URI
  const lines = masterBody.split(/\r?\n/);
  let bestUrl = null;
  let bestBw = Infinity;
  let pendingBw = null;
  for (const line of lines) {
    const trimmed = line.trim();
    if (/^#EXT-X-STREAM-INF:/i.test(trimmed)) {
      const m = /BANDWIDTH=(\d+)/i.exec(trimmed);
      pendingBw = m ? Number(m[1]) : null;
      continue;
    }
    if (!trimmed || trimmed.startsWith('#')) continue;
    if (!/^https?:\/\//i.test(trimmed)) continue;
    const bw = pendingBw != null ? pendingBw : 999999999;
    pendingBw = null;
    if (bw < bestBw) {
      bestBw = bw;
      bestUrl = trimmed;
    }
  }
  if (!bestUrl) {
    return masterKey;
  }

  try {
    const proxied = new URL(bestUrl);
    const nested = proxied.searchParams.get('url');
    if (!nested) return masterKey;
    // Keys must match Express req.originalUrl for /m3u8-proxy requests
    const keyFromProxy = `${proxied.pathname}${proxied.search}`;
    const keyCanonical = directPlaylistCacheKey(nested);
    if (!cacheGet(keyFromProxy) && !cacheGet(keyCanonical)) {
      const upstream = await fetchUpstream(nested, {
        method: 'GET',
        headers: { Accept: '*/*' },
      });
      if ((upstream.status || 500) < 400) {
        const text = rewritePlaylistText(upstream.body.toString('utf8'), origin);
        if (isValidPlaylistBody(text)) {
          const body = Buffer.from(text, 'utf8');
          const entry = { status: upstream.status || 200, body };
          cacheSet(keyFromProxy, entry);
          cacheSet(keyCanonical, entry);
        }
      }
    }
  } catch {
    // warm is best-effort
  }
  return masterKey;
}

function pipeUpstream(targetUrl, req, res, { asPlaylist = false, origin = '' } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      resolve();
    };

    try {
      const parsed = new URL(targetUrl);
      const lib = parsed.protocol === 'https:' ? https : http;
      const agent = parsed.protocol === 'https:' ? httpsAgent : httpAgent;
      const headers = {
        'User-Agent': UA,
        Accept: req.headers.accept || '*/*',
      };
      if (req.headers.range) {
        headers.Range = req.headers.range;
      }

      const upstreamReq = lib.request(
        {
          protocol: parsed.protocol,
          hostname: parsed.hostname,
          port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
          path: `${parsed.pathname}${parsed.search}`,
          method: req.method === 'HEAD' ? 'GET' : req.method || 'GET',
          headers,
          agent,
          timeout: 45000,
        },
        (upstreamRes) => {
          const contentType = String(upstreamRes.headers['content-type'] || '');
          const looksPlaylist =
            asPlaylist ||
            /m3u8/i.test(parsed.pathname) ||
            contentType.includes('mpegurl') ||
            contentType.includes('m3u8');

          if (looksPlaylist) {
            const chunks = [];
            upstreamRes.on('data', (c) => chunks.push(c));
            upstreamRes.on('end', () => {
              let text = Buffer.concat(chunks).toString('utf8');
              text = rewritePlaylistText(text, origin || requestOrigin(req));
              const body = Buffer.from(text, 'utf8');
              res.status(upstreamRes.statusCode || 200);
              res.setHeader('access-control-allow-origin', '*');
              res.setHeader('content-type', 'application/vnd.apple.mpegurl');
              res.setHeader('cache-control', 'public, max-age=15');
              res.setHeader('content-length', body.length);
              res.end(body);
              done();
            });
            return;
          }

          res.status(upstreamRes.statusCode || 200);
          res.setHeader('access-control-allow-origin', '*');
          res.setHeader(
            'access-control-expose-headers',
            'Content-Length, Content-Range, Accept-Ranges'
          );
          for (const name of [
            'content-type',
            'content-length',
            'content-range',
            'accept-ranges',
            'cache-control',
          ]) {
            if (upstreamRes.headers[name] != null) {
              res.setHeader(name, upstreamRes.headers[name]);
            }
          }
          if (/ts-proxy|\.ts($|\?)/i.test(parsed.pathname + (req.path || ''))) {
            res.setHeader('content-type', 'video/mp2t');
          }
          if (!res.getHeader('accept-ranges')) {
            res.setHeader('accept-ranges', 'bytes');
          }
          upstreamRes.pipe(res);
          upstreamRes.on('end', done);
          upstreamRes.on('error', done);
        }
      );

      upstreamReq.on('error', (err) => {
        console.error('hls pipe error', err && err.message ? err.message : err);
        if (!res.headersSent) {
          res.status(502).json({ error: 'hls proxy failed' });
        }
        done();
      });
      upstreamReq.on('timeout', () => {
        upstreamReq.destroy(new Error('timeout'));
      });
      req.on('close', () => {
        upstreamReq.destroy();
        done();
      });
      upstreamReq.end();
    } catch (err) {
      console.error('hls pipe setup failed', err && err.message ? err.message : err);
      if (!res.headersSent) {
        res.status(502).json({ error: 'hls proxy failed' });
      }
      done();
    }
  });
}

function proxyUrlForUpstream(rawUrl, origin) {
  try {
    const absolute = /^https?:\/\//i.test(rawUrl)
      ? rawUrl
      : rawUrl.startsWith('/')
        ? `${HLS_PROXY}${rawUrl}`
        : null;
    if (!absolute) return null;
    const u = new URL(absolute);

    // Ballerina wrapper: unwrap CDN nested ?url= and go direct
    const nested = u.searchParams.get('url');
    if (nested && /^https?:\/\//i.test(nested)) {
      try {
        const nestedHost = new URL(nested).host;
        if (DIRECT_HLS_HOST_RE.test(nestedHost)) {
          const kind =
            /m3u8/i.test(u.pathname) || /\.m3u8(\?|$)/i.test(nested) ? 'm3u8' : 'ts';
          return `${origin}/m3u8-proxy/direct.${kind}?url=${encodeURIComponent(nested)}`;
        }
      } catch {
        // fall through
      }
    }

    if (u.origin === origin) return absolute;
    if (DIRECT_HLS_HOST_RE.test(u.host)) {
      const kind = /\.m3u8(\?|$)/i.test(u.pathname) ? 'm3u8' : 'ts';
      return `${origin}/m3u8-proxy/direct.${kind}?url=${encodeURIComponent(absolute)}`;
    }
    if (/ballerinacappuccinalovestungtungtungsahur\.com/i.test(u.host)) {
      return `${origin}/m3u8-proxy${u.pathname}${u.search}`;
    }
    return `${origin}/m3u8-proxy/m3u8-proxy.m3u8?url=${encodeURIComponent(absolute)}`;
  } catch {
    return null;
  }
}

function rewritePlaylistText(text, origin) {
  return text
    .split(/\r?\n/)
    .map((line) => {
      const trimmed = line.trim();
      if (/^#YT-EXT-/i.test(trimmed) || /^#EXT-X-VIDEO-RANGE:/i.test(trimmed)) {
        return null;
      }
      if (/^#EXT-X-STREAM-INF:/i.test(trimmed)) {
        return trimmed
          .replace(/,YT-EXT-ABSOLUTE-LOUDNESS=[^,]*/gi, '')
          .replace(/,VIDEO-RANGE=[^,]*/gi, '');
      }
      if (!trimmed || trimmed.startsWith('#')) {
        return line;
      }
      // Absolute http(s) or relative ballerina proxy paths
      if (
        /^https?:\/\//i.test(trimmed) ||
        /^\/?(m3u8-proxy\.m3u8|ts-proxy\.ts|key-proxy)/i.test(trimmed)
      ) {
        return proxyUrlForUpstream(trimmed, origin) || line;
      }
      return line;
    })
    .filter((line) => line != null)
    .join('\n');
}

function requestOrigin(req) {
  const proto = String(req.headers['x-forwarded-proto'] || req.protocol || 'https')
    .split(',')[0]
    .trim();
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return `${proto}://${host}`;
}

function proxyBase(req) {
  return `${requestOrigin(req)}/vidlove-proxy`;
}

function rewriteBody(body, base, origin) {
  let out = body
    .replace(/https:\/\/player\.vidlove\.cc/gi, base)
    .replace(/http:\/\/player\.vidlove\.cc/gi, base)
    .replace(/https:\/\/www\.111movies\.net/gi, base)
    .replace(/https:\/\/111movies\.net/gi, base)
    .replace(/https:\/\/www\.111movies\.com/gi, base)
    .replace(/https:\/\/111movies\.com/gi, base)
    // Origin-only: player does `new URL(api).origin` before /auth/...
    .replace(/https:\/\/momlover\.notyourtype\.dad/gi, origin)
    .replace(
      /https:\/\/ballerinacappuccinalovestungtungtungsahur\.com/gi,
      `${origin}/m3u8-proxy`
    );

  out = out.replace(
    /(src|href)=(["'])\/(?!\/|vidlove-proxy\/)/gi,
    `$1=$2/vidlove-proxy/`
  );
  out = out.replace(
    /(["'])\/(assets|embed|api|_next|_vercel|static)\//gi,
    `$1/vidlove-proxy/$2/`
  );

  return out;
}

function injectGuard(html, base, origin) {
  const guard = `<script>(function(){try{var B=${JSON.stringify(base)};var O=${JSON.stringify(origin)};
if(typeof document!=='undefined'){var b=document.createElement('base');b.href=B.endsWith('/')?B:B+'/';
if(document.head)document.head.prepend(b);}
var abs=/^https?:\\/\\/(?:player\\.)?vidlove\\.cc|^https?:\\/\\/(?:www\\.)?111movies\\.(?:net|com)/i;
var api=/^https?:\\/\\/momlover\\.notyourtype\\.dad/i;
var hls=/^https?:\\/\\/ballerinacappuccinalovestungtungtungsahur\\.com/i;
function fix(u){try{if(!u)return u;if(hls.test(u))return O+'/m3u8-proxy'+u.replace(hls,'');if(api.test(u))return u.replace(api,O);if(abs.test(u))return u.replace(abs,B);if(u.charAt(0)==='/'&&u.indexOf('/vidlove-proxy')!==0&&u.indexOf('/auth/')!==0&&!/^\\/(moviebox|cline|self|zebra|fabric|season|m3u8-proxy)\\//.test(u))return B+u;return u;}catch(e){return u}}
var of=window.fetch;window.fetch=function(i,init){if(typeof i==='string')i=fix(i);else if(i&&i.url){try{i=new Request(fix(i.url),i);}catch(e){}}return of.call(this,i,init);};
var XO=XMLHttpRequest.prototype.open;XMLHttpRequest.prototype.open=function(m,u){arguments[1]=fix(u);return XO.apply(this,arguments);};
}catch(e){}})();</script>`;
  if (/<head[^>]*>/i.test(html)) {
    return html.replace(/<head[^>]*>/i, (m) => `${m}${guard}`);
  }
  return guard + html;
}

function readRequestBody(req) {
  // express.json() may have already consumed the stream
  if (req.body != null && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) {
    return Promise.resolve(Buffer.from(JSON.stringify(req.body), 'utf8'));
  }
  if (Buffer.isBuffer(req.body)) {
    return Promise.resolve(req.body);
  }
  if (typeof req.body === 'string') {
    return Promise.resolve(Buffer.from(req.body, 'utf8'));
  }
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function fetchUpstream(targetUrl, options = {}) {
  const method = options.method || 'GET';
  const body = options.body || null;
  const extraHeaders = options.headers || {};

  return new Promise((resolve, reject) => {
    const lib = targetUrl.startsWith('https') ? https : http;
    const headers = {
      'User-Agent': UA,
      Accept: '*/*',
      Referer: `${UPSTREAM}/`,
      Origin: UPSTREAM,
      ...extraHeaders,
    };
    if (body && body.length && !headers['Content-Length'] && !headers['content-length']) {
      headers['Content-Length'] = body.length;
    }

    let parsed;
    try {
      parsed = new URL(targetUrl);
    } catch (err) {
      reject(err);
      return;
    }
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
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          resolve({
            status: res.statusCode || 502,
            headers: res.headers,
            body: Buffer.concat(chunks),
          });
        });
      }
    );
    req.on('error', reject);
    req.setTimeout(25000, () => {
      req.destroy(new Error('Upstream timeout'));
    });
    if (body && body.length) {
      req.write(body);
    }
    req.end();
  });
}

function stripFrameHeaders(headers) {
  const out = { ...headers };
  delete out['x-frame-options'];
  delete out['content-security-policy'];
  delete out['content-security-policy-report-only'];
  delete out['cross-origin-opener-policy'];
  delete out['cross-origin-embedder-policy'];
  delete out['content-encoding'];
  delete out['content-length'];
  delete out['transfer-encoding'];
  out['access-control-allow-origin'] = '*';
  out['access-control-allow-methods'] = 'GET,POST,OPTIONS,HEAD';
  out['access-control-allow-headers'] =
    'Content-Type, Authorization, Accept, Origin, Referer, X-Requested-With, x-request-token, x-response-encryption';
  return out;
}

function sendProxied(res, upstream, base, origin, rewriteText) {
  const contentType = upstream.headers['content-type'] || '';
  const headers = stripFrameHeaders(upstream.headers);
  headers['cache-control'] = headers['cache-control'] || 'public, max-age=60';

  let body = upstream.body;
  if (rewriteText && isTextType(contentType)) {
    let text = body.toString('utf8');
    text = rewriteBody(text, base, origin);
    if (contentType.includes('text/html')) {
      text = injectGuard(text, base, origin);
    }
    body = Buffer.from(text, 'utf8');
  }

  res.status(upstream.status);
  Object.entries(headers).forEach(([key, value]) => {
    if (value != null && key.toLowerCase() !== 'connection') {
      res.setHeader(key, value);
    }
  });
  res.setHeader('content-type', contentType || 'application/octet-stream');
  res.send(body);
}

async function proxyStreamApi(req, res) {
  try {
    if (req.method === 'OPTIONS') {
      res.setHeader('access-control-allow-origin', '*');
      res.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS,HEAD');
      res.setHeader(
        'access-control-allow-headers',
        'Content-Type, Authorization, Accept, Origin, Referer, X-Requested-With, x-request-token, x-response-encryption'
      );
      return res.status(204).end();
    }

    // When mounted at /moviebox etc., req.path is stripped — use originalUrl.
    const original = req.originalUrl || req.url || req.path || '/';
    const pathWithQuery = original.split('?');
    const pathname = pathWithQuery[0];
    const query = pathWithQuery[1] ? `?${pathWithQuery[1]}` : '';
    const target = `${STREAM_API}${pathname}${query}`;
    const reqBody =
      req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH'
        ? await readRequestBody(req)
        : null;

    const forward = {
      Accept: req.headers.accept || 'application/json, */*',
    };
    if (req.headers['content-type']) {
      forward['Content-Type'] = req.headers['content-type'];
    } else if (reqBody && reqBody.length) {
      forward['Content-Type'] = 'application/json';
    }
    // Vidlove stream API auth (not Bearer)
    const passHeaders = [
      'authorization',
      'x-requested-with',
      'x-request-token',
      'x-response-encryption',
    ];
    for (const name of passHeaders) {
      if (req.headers[name]) {
        forward[name] = req.headers[name];
      }
    }

    const upstream = await fetchUpstream(target, {
      method: req.method,
      body: reqBody,
      headers: forward,
    });

    const base = proxyBase(req);
    const origin = requestOrigin(req);
    return sendProxied(res, upstream, base, origin, false);
  } catch (err) {
    console.error('stream-api proxy failed', err && err.message ? err.message : err);
    res.status(502).json({ error: 'stream api proxy failed' });
  }
}

function mountVidloveProxy(app) {
  // Same-origin host page for embed tests / optional full-page player shell
  app.get('/vidlove-embed-host', (req, res) => {
    const src = String(req.query.src || '/vidlove-proxy/embed/movie/533535');
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><style>html,body,iframe{margin:0;width:100%;height:100%;border:0;background:#000}</style></head><body><iframe src="${src.replace(/"/g, '')}" allow="autoplay;encrypted-media;fullscreen;picture-in-picture" allowfullscreen></iframe></body></html>`);
  });

  // Stream API at origin root (player strips path via URL.origin)
  for (const prefix of STREAM_API_PREFIXES) {
    app.use(prefix, proxyStreamApi);
  }
  // Only this auth path belongs to Vidlove; Luscreens keeps /auth/login etc.
  app.all('/auth/generate-token', proxyStreamApi);

  // HLS helper — stream segments; short-circuit CDN urls to skip ballerina hop
  app.use('/m3u8-proxy', async (req, res) => {
    try {
      if (req.method === 'OPTIONS') {
        res.setHeader('access-control-allow-origin', '*');
        res.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS,HEAD');
        res.setHeader(
          'access-control-allow-headers',
          'Content-Type, Authorization, Accept, Origin, Referer, X-Requested-With, x-request-token, x-response-encryption'
        );
        return res.status(204).end();
      }

      const origin = requestOrigin(req);
      const nestedUrl = typeof req.query.url === 'string' ? req.query.url : '';
      const cacheKey = req.originalUrl || req.url;

      // Fast path: ?url= points at a CDN we can fetch directly (no ballerina)
      if (nestedUrl && /^https?:\/\//i.test(nestedUrl)) {
        let nestedHost = '';
        try {
          nestedHost = new URL(nestedUrl).host;
        } catch {
          return res.status(400).json({ error: 'bad url' });
        }
        if (!DIRECT_HLS_HOST_RE.test(nestedHost) && !/ballerina/i.test(nestedHost)) {
          return res.status(400).json({ error: 'host not allowed' });
        }

        const isPlaylist =
          /m3u8/i.test(req.path || '') ||
          /\.m3u8(\?|$)/i.test(nestedUrl) ||
          /\/direct\.m3u8/i.test(req.path || '') ||
          // CDN playlist gateways often omit .m3u8 in the path
          (/\/proxy/i.test(nestedUrl) && !/\.(ts|m4s|mp4)(\?|$)/i.test(nestedUrl));
        if (isPlaylist) {
          const cached = cacheGet(cacheKey);
          if (cached?.body && isValidPlaylistBody(cached.body.toString('utf8'))) {
            res.status(200);
            res.setHeader('access-control-allow-origin', '*');
            res.setHeader('content-type', 'application/vnd.apple.mpegurl');
            res.setHeader('cache-control', 'public, max-age=10');
            res.setHeader('x-cache', 'HIT');
            return res.end(cached.body);
          }

          // Buffer+rewrite playlist, then cache (never cache HTML/404 as m3u8)
          const upstream = await fetchUpstream(nestedUrl, {
            method: 'GET',
            headers: { Accept: '*/*' },
          });
          const status = upstream.status || 502;
          const text = rewritePlaylistText(upstream.body.toString('utf8'), origin);
          if (status >= 400 || !isValidPlaylistBody(text)) {
            res.status(status >= 400 ? status : 502);
            res.setHeader('access-control-allow-origin', '*');
            res.setHeader('content-type', 'text/plain; charset=utf-8');
            res.setHeader('cache-control', 'no-store');
            return res.end('invalid playlist');
          }
          const body = Buffer.from(text, 'utf8');
          cacheSet(cacheKey, { status: 200, body });
          res.status(200);
          res.setHeader('access-control-allow-origin', '*');
          res.setHeader('content-type', 'application/vnd.apple.mpegurl');
          res.setHeader('cache-control', 'public, max-age=10');
          res.setHeader('x-cache', 'MISS');
          return res.end(body);
        }

        // Media segments: stream through (no full buffer)
        return pipeUpstream(nestedUrl, req, res, { asPlaylist: false, origin });
      }

      // Ballerina-shaped paths (/m3u8-proxy.m3u8, /ts-proxy.ts, …)
      // If nested ?url= is already a CDN we know, skip the ballerina hop entirely.
      const ballerinaNested =
        typeof req.query.url === 'string' && /^https?:\/\//i.test(req.query.url)
          ? req.query.url
          : '';
      if (ballerinaNested) {
        try {
          const nestedHost = new URL(ballerinaNested).host;
          if (DIRECT_HLS_HOST_RE.test(nestedHost)) {
            const isPlaylist =
              /m3u8/i.test(req.path || '') || /\.m3u8(\?|$)/i.test(ballerinaNested);
            if (isPlaylist) {
              const cached = cacheGet(`direct:${ballerinaNested}`);
              if (cached?.body && isValidPlaylistBody(cached.body.toString('utf8'))) {
                res.status(200);
                res.setHeader('access-control-allow-origin', '*');
                res.setHeader('content-type', 'application/vnd.apple.mpegurl');
                res.setHeader('cache-control', 'public, max-age=10');
                res.setHeader('x-cache', 'HIT');
                return res.end(cached.body);
              }
              const upstream = await fetchUpstream(ballerinaNested, {
                method: 'GET',
                headers: { Accept: '*/*' },
              });
              const status = upstream.status || 502;
              const text = rewritePlaylistText(upstream.body.toString('utf8'), origin);
              if (status >= 400 || !isValidPlaylistBody(text)) {
                res.status(status >= 400 ? status : 502);
                res.setHeader('access-control-allow-origin', '*');
                res.setHeader('cache-control', 'no-store');
                return res.end('invalid playlist');
              }
              const body = Buffer.from(text, 'utf8');
              cacheSet(`direct:${ballerinaNested}`, { status: 200, body });
              res.status(200);
              res.setHeader('access-control-allow-origin', '*');
              res.setHeader('content-type', 'application/vnd.apple.mpegurl');
              res.setHeader('cache-control', 'public, max-age=10');
              res.setHeader('x-bypass', 'ballerina');
              return res.end(body);
            }
            res.setHeader('x-bypass', 'ballerina');
            return pipeUpstream(ballerinaNested, req, res, {
              asPlaylist: false,
              origin,
            });
          }
        } catch {
          // fall through to ballerina
        }
      }

      const target = `${HLS_PROXY}${req.url || '/'}`;
      const isTs = /ts-proxy/i.test(req.path || '');
      if (isTs) {
        return pipeUpstream(target, req, res, { asPlaylist: false, origin });
      }

      const cached = cacheGet(cacheKey);
      if (cached?.body && isValidPlaylistBody(cached.body.toString('utf8'))) {
        res.status(200);
        res.setHeader('access-control-allow-origin', '*');
        res.setHeader('content-type', 'application/vnd.apple.mpegurl');
        res.setHeader('cache-control', 'public, max-age=10');
        res.setHeader('x-cache', 'HIT');
        return res.end(cached.body);
      }

      const upstream = await fetchUpstream(target, {
        method: req.method === 'HEAD' ? 'GET' : req.method || 'GET',
        headers: { Accept: req.headers.accept || '*/*' },
      });
      const status = upstream.status || 502;
      const text = rewritePlaylistText(upstream.body.toString('utf8'), origin);
      if (status >= 400 || !isValidPlaylistBody(text)) {
        res.status(status >= 400 ? status : 502);
        res.setHeader('access-control-allow-origin', '*');
        res.setHeader('cache-control', 'no-store');
        return res.end('invalid playlist');
      }
      const body = Buffer.from(text, 'utf8');
      cacheSet(cacheKey, { status: 200, body });
      res.status(200);
      res.setHeader('access-control-allow-origin', '*');
      res.setHeader('content-type', 'application/vnd.apple.mpegurl');
      res.setHeader('cache-control', 'public, max-age=10');
      res.setHeader('x-cache', 'MISS');
      return res.end(body);
    } catch (err) {
      console.error('m3u8-proxy failed', err && err.message ? err.message : err);
      if (!res.headersSent) {
        res.status(502).json({ error: 'm3u8 proxy failed' });
      }
    }
  });

  app.use('/vidlove-proxy', async (req, res) => {
    try {
      if (req.method === 'OPTIONS') {
        res.setHeader('access-control-allow-origin', '*');
        res.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS,HEAD');
        res.setHeader(
          'access-control-allow-headers',
          'Content-Type, Authorization, Accept, Origin, Referer, X-Requested-With, x-request-token, x-response-encryption'
        );
        return res.status(204).end();
      }

      const suffix = req.path || '/';
      if (suffix.includes('..')) {
        return res.status(400).send('Bad path');
      }

      const base = proxyBase(req);
      const origin = requestOrigin(req);
      const query = req.url.includes('?')
        ? req.url.slice(req.url.indexOf('?'))
        : '';

      let target = `${UPSTREAM}${suffix}${query}`;
      const reqBody =
        req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH'
          ? await readRequestBody(req)
          : null;

      let upstream = await fetchUpstream(target, {
        method: req.method === 'HEAD' ? 'GET' : req.method,
        body: reqBody,
      });

      if (
        upstream.status >= 300 &&
        upstream.status < 400 &&
        upstream.headers.location
      ) {
        const loc = new URL(upstream.headers.location, target).toString();
        if (/vidlove\.cc|111movies\./i.test(loc)) {
          upstream = await fetchUpstream(loc, { method: 'GET' });
        }
      }

      return sendProxied(res, upstream, base, origin, true);
    } catch (err) {
      console.error('vidlove-proxy failed', err && err.message ? err.message : err);
      res.status(502).json({ error: 'vidlove proxy failed' });
    }
  });

  app.use('/111movies-proxy', async (req, res) => {
    try {
      const suffix = req.path || '/';
      if (suffix.includes('..')) {
        return res.status(400).send('Bad path');
      }
      const target = `${ALT_UPSTREAM}${suffix}`;
      const upstream = await fetchUpstream(target);
      if (
        upstream.status >= 300 &&
        upstream.status < 400 &&
        upstream.headers.location
      ) {
        const loc = new URL(upstream.headers.location, target);
        const proxied = '/vidlove-proxy' + loc.pathname + (loc.search || '');
        return res.redirect(302, proxied);
      }
      const m = suffix.match(/^\/(movie|tv)\/(.+)$/i);
      if (m) {
        const kind = m[1].toLowerCase();
        return res.redirect(302, `/vidlove-proxy/embed/${kind}/${m[2]}`);
      }
      res.status(upstream.status).send(upstream.body);
    } catch (err) {
      console.error('111movies-proxy failed', err && err.message ? err.message : err);
      res.status(502).json({ error: '111movies proxy failed' });
    }
  });
}

module.exports = { mountVidloveProxy, warmDirectPlaylistChain };
