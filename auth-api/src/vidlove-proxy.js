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

function isTextType(contentType) {
  const ct = String(contentType || '').toLowerCase();
  return TEXT_TYPES.some((t) => ct.includes(t));
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

    const req = lib.request(
      targetUrl,
      { method, headers },
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

  // HLS helper host (CORS-blocked in cross-origin iframes)
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
      const target = `${HLS_PROXY}${req.url || '/'}`;
      const upstream = await fetchUpstream(target, {
        method: req.method === 'HEAD' ? 'GET' : req.method || 'GET',
        headers: {
          Accept: req.headers.accept || '*/*',
        },
      });
      const base = proxyBase(req);
      const origin = requestOrigin(req);
      return sendProxied(res, upstream, base, origin, false);
    } catch (err) {
      console.error('m3u8-proxy failed', err && err.message ? err.message : err);
      res.status(502).json({ error: 'm3u8 proxy failed' });
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

module.exports = { mountVidloveProxy };
