'use strict';

const express             = require('express');
const axios               = require('axios');
const cheerio             = require('cheerio');
const { URL }             = require('url');
const http                = require('http');
const { WebSocketServer, WebSocket: WS } = require('ws');

const app    = express();
const server = http.createServer(app);
const PORT   = process.env.PORT || 3000;

// ── body parsing ──────────────────────────────────────────────────────────────
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.raw({ type: '*/*', limit: '10mb' }));
app.use(express.static('public'));

// ── health check (Railway / Render require this) ──────────────────────────────
app.get('/health', (_, res) => res.json({ ok: true, ts: Date.now() }));

// ── helpers ───────────────────────────────────────────────────────────────────

function resolveHref(base, rel) {
  if (!rel) return rel;
  try { return new URL(rel, base).toString(); }
  catch { return rel; }
}

function wrap(raw, base) {
  if (!raw || typeof raw !== 'string') return raw;
  const skip = ['#', 'javascript:', 'mailto:', 'tel:', 'data:', '/proxy?url=', 'blob:'];
  if (skip.some(p => raw.startsWith(p))) return raw;
  try {
    const abs = resolveHref(base, raw);
    if (!abs.startsWith('http')) return raw;
    return `/proxy?url=${encodeURIComponent(abs)}`;
  } catch { return raw; }
}

function getOrigin(urlStr) {
  try { return new URL(urlStr).origin; } catch { return ''; }
}

function unwrapReferer(h) {
  try {
    const u   = new URL(h);
    const raw = u.searchParams.get('url');
    return raw || h;
  } catch { return h; }
}

// Headers we always strip from upstream responses
const STRIP_HEADERS = [
  'content-security-policy',
  'content-security-policy-report-only',
  'x-frame-options',
  'x-content-type-options',
  'strict-transport-security',
  'permissions-policy',
  'cross-origin-opener-policy',
  'cross-origin-embedder-policy',
  'cross-origin-resource-policy',
  'report-to',
  'nel',
  // These two are critical — axios already decompresses the body, so
  // forwarding these headers makes the browser try to decompress
  // already-plain-text and get garbled garbage
  'content-encoding',
  'transfer-encoding',
  // We let Express set the correct length after our rewrites
  'content-length',
];

// ── WebSocket relay ───────────────────────────────────────────────────────────

const wss = new WebSocketServer({ server, path: '/ws-relay' });

wss.on('connection', (clientWs, req) => {
  const qs     = req.url.includes('?') ? req.url.split('?')[1] : '';
  const params = new URLSearchParams(qs);
  const target = params.get('url');
  const origin = params.get('origin') || '';

  if (!target || (!target.startsWith('ws://') && !target.startsWith('wss://'))) {
    clientWs.close(1008, 'invalid target');
    return;
  }

  let targetWs;
  try {
    targetWs = new WS(target, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Origin'    : origin,
      },
    });
  } catch {
    clientWs.close(1011, 'relay init failed');
    return;
  }

  let ready = false;
  const buf = [];

  targetWs.on('open', () => {
    ready = true;
    buf.forEach(([d, b]) => targetWs.send(d, { binary: b }));
    buf.length = 0;
  });
  targetWs.on('message', (data, isBinary) => {
    if (clientWs.readyState === WS.OPEN) clientWs.send(data, { binary: isBinary });
  });
  targetWs.on('close',   (c, r) => { try { clientWs.close(c, r); } catch {} });
  targetWs.on('error',   ()     => { try { clientWs.close(1011); } catch {} });

  clientWs.on('message', (data, isBinary) => {
    if (ready && targetWs.readyState === WS.OPEN) targetWs.send(data, { binary: isBinary });
    else if (!ready) buf.push([data, isBinary]);
  });
  clientWs.on('close', () => { if (targetWs.readyState < 2) try { targetWs.close(); } catch {} });
  clientWs.on('error', () => { if (targetWs.readyState < 2) try { targetWs.close(1011); } catch {} });
});

// ── proxy ─────────────────────────────────────────────────────────────────────

app.all('/proxy', async (req, res) => {
  const target = req.query.url;
  if (!target) return res.status(400).send('Missing ?url=');

  // CORS — needed for video players and SPA API calls
  res.setHeader('Access-Control-Allow-Origin',   '*');
  res.setHeader('Access-Control-Allow-Methods',  'GET,POST,PUT,PATCH,DELETE,OPTIONS,HEAD');
  res.setHeader('Access-Control-Allow-Headers',  '*');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Length,Content-Range,Accept-Ranges');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const targetOrigin = getOrigin(target);

  // Build headers that make us look like a real browser
  const upstreamHeaders = {
    'User-Agent'     : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    'Accept'         : req.headers['accept'] || '*/*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br',
    'Referer'        : req.headers['referer'] ? unwrapReferer(req.headers['referer']) : target,
  };

  if (req.headers['origin'])       upstreamHeaders['Origin']       = targetOrigin;
  if (req.headers['cookie'])       upstreamHeaders['Cookie']       = req.headers['cookie'];
  if (req.headers['content-type']) upstreamHeaders['Content-Type'] = req.headers['content-type'];
  // Range header — needed so video seeking returns 206 partial content
  if (req.headers['range'])        upstreamHeaders['Range']        = req.headers['range'];

  // Auth + CSRF tokens that login flows need
  ['x-csrf-token','x-xsrf-token','x-requested-with',
   'authorization','x-request-id','x-transaction-id'].forEach(h => {
    if (req.headers[h]) upstreamHeaders[h] = req.headers[h];
  });

  // Build POST/PUT/PATCH body
  let requestBody;
  if (['POST','PUT','PATCH'].includes(req.method)) {
    requestBody = req.body;
    if (Buffer.isBuffer(requestBody) && requestBody.length === 0) requestBody = undefined;
    if (requestBody && typeof requestBody === 'object' && !Buffer.isBuffer(requestBody)
        && Object.keys(requestBody).length === 0) requestBody = undefined;
  }

  let response;
  try {
    response = await axios({
      method        : req.method,
      url           : target,
      headers       : upstreamHeaders,
      data          : requestBody,
      responseType  : 'arraybuffer',
      timeout       : 20000,
      maxRedirects  : 0,          // we forward redirects ourselves — no loop risk
      validateStatus: () => true, // never throw on status codes, handle everything
    });
  } catch (err) {
    return res.status(502).send(`
      <style>
        body { font-family: monospace; padding: 2rem; background: #111; color: #e74c3c; }
        a    { color: #666; }
        p    { color: #555; margin-top: .5rem; font-size: .85rem; }
      </style>
      <h2>couldn't reach that page</h2>
      <p>${err.message}</p>
      <p><a href="/">← home</a></p>
    `);
  }

  // Strip all the headers that break our rewriting
  STRIP_HEADERS.forEach(h => res.removeHeader(h));

  res.status(response.status);

  // Forward cookies — strip domain/secure so localhost accepts them
  const setCookies = response.headers['set-cookie'];
  if (setCookies) {
    const cleaned = (Array.isArray(setCookies) ? setCookies : [setCookies]).map(c =>
      c.replace(/;\s*domain=[^;]*/gi,  '')
       .replace(/;\s*secure/gi,        '')
       .replace(/;\s*samesite=[^;]*/gi,'')
    );
    res.setHeader('Set-Cookie', cleaned);
  }

  // Forward partial-content headers (video seeking)
  if (response.headers['content-range'])  res.setHeader('Content-Range',  response.headers['content-range']);
  if (response.headers['accept-ranges'])  res.setHeader('Accept-Ranges',  response.headers['accept-ranges']);

  // Redirect — rewrite Location through our proxy and let client follow
  if (response.headers['location']) {
    res.setHeader('Location', wrap(response.headers['location'], target));
    return res.end();
  }

  const ct  = (response.headers['content-type'] || '').toLowerCase();
  const url = target.toLowerCase();

  // ── HLS (.m3u8) — rewrite segment + key URLs ─────────────────────────────
  if (ct.includes('mpegurl') || ct.includes('x-mpegurl') || url.includes('.m3u8')) {
    let m3u8 = response.data.toString('utf-8');
    m3u8 = m3u8.split('\n').map(line => {
      const t = line.trim();
      if (!t) return line;
      if (t.startsWith('#'))
        return line.replace(/URI="([^"]+)"/g, (_, u) => `URI="${wrap(u, target)}"`);
      return wrap(t, target);
    }).join('\n');
    res.set('Content-Type', 'application/x-mpegURL');
    return res.send(m3u8);
  }

  // ── DASH (.mpd) — rewrite BaseURL + media/init attributes ────────────────
  if (ct.includes('dash+xml') || url.includes('.mpd')) {
    let mpd = response.data.toString('utf-8');
    mpd = mpd.replace(/(<BaseURL[^>]*>)([^<]+)(<\/BaseURL>)/g,
      (_, o, u, c) => `${o}${wrap(u.trim(), target)}${c}`);
    mpd = mpd.replace(/\smedia="([^"]+)"/g,         (_, u) => ` media="${wrap(u, target)}"`);
    mpd = mpd.replace(/\sinitialization="([^"]+)"/g, (_, u) => ` initialization="${wrap(u, target)}"`);
    res.set('Content-Type', 'application/dash+xml');
    return res.send(mpd);
  }

  // ── CSS — rewrite url() and @import ──────────────────────────────────────
  if (ct.includes('text/css')) {
    let css = response.data.toString('utf-8');
    css = css.replace(/url\(\s*(['"]?)([^'")\s]+)\1\s*\)/g, (match, q, u) => {
      if (u.startsWith('data:')) return match;
      return `url(${q}${wrap(u, target)}${q})`;
    });
    css = css.replace(/@import\s+(['"])([^'"]+)\1/g,
      (_, q, u) => `@import ${q}${wrap(u, target)}${q}`);
    res.set('Content-Type', ct);
    return res.send(css);
  }

  // ── Non-HTML binary passthrough (images, fonts, video segments, JS) ───────
  if (!ct.includes('text/html')) {
    res.set('Content-Type', ct || 'application/octet-stream');
    return res.send(response.data);
  }

  // ── HTML — full rewrite pass ──────────────────────────────────────────────
  const html = response.data.toString('utf-8');
  const $    = cheerio.load(html, { decodeEntities: false });

  // CRITICAL: strip integrity hashes — our rewrites change the content,
  // so the hash never matches and the browser silently refuses to load the file
  $('[integrity]').removeAttr('integrity');
  // Strip crossorigin on things we're serving from a different origin
  $('script[crossorigin], link[crossorigin], img[crossorigin], video[crossorigin], audio[crossorigin]')
    .removeAttr('crossorigin');

  // Standard URL attributes
  $('[href]').each((_, el) => {
    const v = $(el).attr('href'), r = wrap(v, target);
    if (r !== v) $(el).attr('href', r);
  });
  $('[src]').each((_, el) => {
    const v = $(el).attr('src'), r = wrap(v, target);
    if (r !== v) $(el).attr('src', r);
  });
  $('[srcset]').each((_, el) => {
    const raw = $(el).attr('srcset');
    const rw  = raw.split(',').map(p => {
      const parts = p.trim().split(/\s+/);
      parts[0] = wrap(parts[0], target);
      return parts.join(' ');
    }).join(', ');
    $(el).attr('srcset', rw);
  });
  $('[action]').each((_, el) => {
    const v = $(el).attr('action'), r = wrap(v, target);
    if (r !== v) $(el).attr('action', r);
  });

  // Video/audio attributes
  $('video[poster]').each((_, el) => {
    const v = $(el).attr('poster'), r = wrap(v, target);
    if (r !== v) $(el).attr('poster', r);
  });
  $('track[src]').each((_, el) => {
    const v = $(el).attr('src'), r = wrap(v, target);
    if (r !== v) $(el).attr('src', r);
  });

  // Lazy-load / framework data attributes
  ['data-src','data-href','data-url','data-original',
   'data-lazy-src','data-lazy','data-bg','data-background-image'].forEach(attr => {
    $(`[${attr}]`).each((_, el) => {
      const v = $(el).attr(attr), r = wrap(v, target);
      if (r !== v) $(el).attr(attr, r);
    });
  });

  // Meta tag content URLs (og:image, twitter:image, etc.)
  $('meta[content]').each((_, el) => {
    const v = $(el).attr('content') || '';
    if (v.startsWith('http://') || v.startsWith('https://')) {
      const r = wrap(v, target);
      if (r !== v) $(el).attr('content', r);
    }
  });

  // Remove canonical — can cause redirect loops through proxy
  $('link[rel="canonical"]').remove();

  // Inline style attribute url() rewrite
  $('[style]').each((_, el) => {
    const s = $(el).attr('style');
    if (!s || !s.includes('url(')) return;
    const rw = s.replace(/url\(\s*(['"]?)([^'")\s]+)\1\s*\)/g, (match, q, u) => {
      if (u.startsWith('data:')) return match;
      return `url(${q}${wrap(u, target)}${q})`;
    });
    if (rw !== s) $(el).attr('style', rw);
  });

  // Inline <style> block url() rewrite
  $('style').each((_, el) => {
    const s = $(el).html();
    if (!s) return;
    const rw = s.replace(/url\(\s*(['"]?)([^'")\s]+)\1\s*\)/g, (match, q, u) => {
      if (u.startsWith('data:')) return match;
      return `url(${q}${wrap(u, target)}${q})`;
    });
    if (rw !== s) $(el).html(rw);
  });

  // meta refresh
  $('meta[http-equiv="refresh"]').each((_, el) => {
    const c = $(el).attr('content') || '';
    const m = c.match(/^(\d+;\s*url=)(.+)$/i);
    if (m) $(el).attr('content', `${m[1]}${wrap(m[2], target)}`);
  });

  // Kill inline CSP meta
  $('meta[http-equiv="content-security-policy"]').remove();
  $('meta[http-equiv="Content-Security-Policy"]').remove();

  // Rewrite same-origin string literals inside small inline scripts
  const pageOrigin = getOrigin(target);
  if (pageOrigin) {
    const escaped = pageOrigin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pat = new RegExp(`(["'\`])${escaped}(/[a-zA-Z0-9/_\\-.%?=&]*)\\1`, 'g');
    $('script:not([src])').each((_, el) => {
      const code = $(el).html();
      if (!code || code.length > 300_000 || !code.includes(pageOrigin)) return;
      const rw = code.replace(pat, (_, q, path) =>
        `${q}/proxy?url=${encodeURIComponent(pageOrigin + path)}${q}`
      );
      if (rw !== code) $(el).html(rw);
    });
  }

  // ── Client-side intercept injection ──────────────────────────────────────
  $('head').prepend(`<script>
(function () {
  'use strict';
  var BASE     = ${JSON.stringify(target)};
  var PAGE_ORI = ${JSON.stringify(pageOrigin)};
  // Dynamic WS URL — works on localhost (ws://) AND Railway/Render (wss://)
  var WS_PROTO = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  var WS_RELAY = WS_PROTO + '//' + window.location.host + '/ws-relay';

  function toProxy(u) {
    if (!u || typeof u !== 'string') return u;
    if (u.startsWith('/proxy?url=')) return u;
    var bad = ['#','javascript:','mailto:','data:','blob:','tel:'];
    for (var i = 0; i < bad.length; i++) if (u.startsWith(bad[i])) return u;
    try {
      var abs = new URL(u, BASE).toString();
      return abs.startsWith('http') ? '/proxy?url=' + encodeURIComponent(abs) : u;
    } catch(e) { return u; }
  }

  // ── Block service worker registration ────────────────────────────────────
  // Service workers would register to our /proxy?url= scope and break everything
  try {
    if ('serviceWorker' in navigator) {
      Object.defineProperty(navigator, 'serviceWorker', {
        get: function () {
          return {
            register        : function () { return Promise.resolve({ scope: '/' }); },
            ready           : Promise.resolve({ scope: '/', active: null }),
            getRegistrations: function () { return Promise.resolve([]); },
            addEventListener: function () {},
            removeEventListener: function () {},
          };
        },
        configurable: true,
      });
    }
  } catch(e) {}

  // ── WebSocket relay ───────────────────────────────────────────────────────
  var _WS = window.WebSocket;
  if (_WS) {
    function PortalWS(url, protocols) {
      var relayed = WS_RELAY + '?url=' + encodeURIComponent(url)
                  + '&origin=' + encodeURIComponent(PAGE_ORI);
      return protocols !== undefined ? new _WS(relayed, protocols) : new _WS(relayed);
    }
    PortalWS.prototype  = _WS.prototype;
    PortalWS.CONNECTING = 0; PortalWS.OPEN = 1;
    PortalWS.CLOSING    = 2; PortalWS.CLOSED = 3;
    window.WebSocket = PortalWS;
  }

  // ── fetch override ────────────────────────────────────────────────────────
  var _fetch = window.fetch;
  if (_fetch) {
    window.fetch = function (input, init) {
      try {
        if (typeof input === 'string') {
          input = toProxy(input);
        } else if (input && input.url) {
          var p = toProxy(input.url);
          if (p !== input.url) input = new Request(p, input);
        }
      } catch(e) {}
      return _fetch.call(window, input, init);
    };
  }

  // ── XHR override ─────────────────────────────────────────────────────────
  var _xhrOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function () {
    var args = Array.prototype.slice.call(arguments);
    if (args[1]) try { args[1] = toProxy(args[1]); } catch(e) {}
    return _xhrOpen.apply(this, args);
  };

  // ── pushState / replaceState ──────────────────────────────────────────────
  // Force full page load instead of SPA routing — prevents the SPA router
  // from trying to match our /proxy?url=... path as one of its own routes
  ['pushState','replaceState'].forEach(function (m) {
    var orig = history[m];
    history[m] = function (state, title, url) {
      if (!url) return orig.call(this, state, title, url);
      var proxied = toProxy(url);
      if (proxied !== url) { window.location.href = proxied; return; }
      return orig.call(this, state, title, url);
    };
  });

  // ── location overrides ────────────────────────────────────────────────────
  try {
    var _assign  = window.location.assign.bind(window.location);
    var _replace = window.location.replace.bind(window.location);
    window.location.assign  = function (u) { _assign(toProxy(u));  };
    window.location.replace = function (u) { _replace(toProxy(u)); };
  } catch(e) {}

  try {
    var lp   = Object.getPrototypeOf(window.location);
    var desc = Object.getOwnPropertyDescriptor(lp, 'href');
    if (desc && desc.set) {
      Object.defineProperty(lp, 'href', {
        get: desc.get,
        set: function (v) { desc.set.call(window.location, toProxy(v)); },
        configurable: true,
      });
    }
  } catch(e) {}

  // ── window.open ───────────────────────────────────────────────────────────
  var _open = window.open;
  window.open = function (url, tgt, feat) {
    return _open.call(this, toProxy(url), tgt, feat);
  };

  // ── click intercept ───────────────────────────────────────────────────────
  document.addEventListener('click', function (e) {
    var a = e.target && e.target.closest && e.target.closest('a[href]');
    if (!a) return;
    var h = a.getAttribute('href');
    if (!h || h.startsWith('#') || h.startsWith('javascript:')) return;
    if (h.startsWith('/proxy?url=')) return;
    e.preventDefault();
    window.location.href = toProxy(h);
  }, true);

  // ── form submit ───────────────────────────────────────────────────────────
  document.addEventListener('submit', function (e) {
    var form = e.target;
    if (!form) return;
    var method = (form.method || 'get').toLowerCase();

    if (method === 'get') {
      // GET forms: browser would append ?params OUTSIDE our encoded proxy URL,
      // breaking the target URL entirely. Fix: intercept and build it ourselves.
      e.preventDefault();
      var action = form.action || '';
      var realAction = action;
      if (action.indexOf('/proxy?url=') !== -1) {
        try {
          var tmp = new URL(action, window.location.origin);
          realAction = decodeURIComponent(tmp.searchParams.get('url') || action);
        } catch(err) {}
      }
      var params = new URLSearchParams();
      var els = form.querySelectorAll('input,select,textarea');
      for (var i = 0; i < els.length; i++) {
        var el = els[i];
        if (!el.name || el.disabled) continue;
        if ((el.type === 'checkbox' || el.type === 'radio') && !el.checked) continue;
        params.append(el.name, el.value || '');
      }
      var qs      = params.toString();
      var fullUrl = realAction + (realAction.indexOf('?') !== -1 ? '&' : '?') + qs;
      window.location.href = '/proxy?url=' + encodeURIComponent(fullUrl);
      return;
    }

    // POST: just make sure action is proxied
    if (!form.action.startsWith('/proxy?url=')) {
      try { form.action = toProxy(form.action); } catch(err) {}
    }
  }, true);

})();
</script>`);

  // ── Floating toolbar ──────────────────────────────────────────────────────
  const safeVal = target.replace(/"/g, '&quot;');
  $('body').append(`
<div id="__portal_bar" style="
  position:fixed;bottom:0;left:0;right:0;z-index:2147483647;
  background:rgba(12,12,12,0.97);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);
  display:flex;align-items:center;gap:8px;padding:7px 12px;
  border-top:1px solid #1e1e1e;font-family:'Courier New',monospace;
  box-sizing:border-box;
">
  <a href="/" style="color:#444;text-decoration:none;font-size:17px;flex-shrink:0;line-height:1;">⬡</a>
  <button onclick="history.back()" style="
    background:transparent;border:1px solid #252525;border-radius:4px;
    color:#555;padding:3px 9px;cursor:pointer;font-family:'Courier New',monospace;
    font-size:11px;flex-shrink:0;
  ">←</button>
  <input id="__portal_i" value="${safeVal}" style="
    flex:1;min-width:0;background:#111;border:1px solid #222;border-radius:5px;
    color:#c0c0c0;padding:5px 11px;font-family:'Courier New',monospace;font-size:12px;outline:none;
    box-sizing:border-box;
  "
    onfocus="this.style.borderColor='#2563eb'"
    onblur="this.style.borderColor='#222'"
    onkeydown="if(event.key==='Enter'){
      var v=this.value.trim();if(!v)return;
      var u=v.startsWith('http')?v:'https://'+v;
      window.location.href='/proxy?url='+encodeURIComponent(u);
    }"
  />
  <button
    onclick="var v=document.getElementById('__portal_i').value.trim();if(!v)return;var u=v.startsWith('http')?v:'https://'+v;window.location.href='/proxy?url='+encodeURIComponent(u);"
    onmouseover="this.style.background='#1d4ed8'"
    onmouseout="this.style.background='#2563eb'"
    style="background:#2563eb;border:none;border-radius:5px;color:#fff;
      padding:5px 15px;cursor:pointer;font-family:'Courier New',monospace;
      font-size:12px;white-space:nowrap;flex-shrink:0;"
  >go →</button>
</div>
<div style="height:44px;"></div>`);

  res.set('Content-Type', 'text/html; charset=utf-8');
  res.send($.html());
});

// ── start ─────────────────────────────────────────────────────────────────────

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n  ⬡ portal  →  http://localhost:${PORT}\n`);
});
