const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const { URL } = require('url');
const http = require('http');
const { WebSocketServer, WebSocket: WS } = require('ws');

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 3000;

// Body parsing — needed so POST login forms actually forward their data
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.raw({ type: '*/*', limit: '10mb' }));
app.use(express.static('public'));

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
    return '/proxy?url=' + encodeURIComponent(abs);
  } catch {
    return raw;
  }
}

function getOrigin(urlStr) {
  try { return new URL(urlStr).origin; } catch { return ''; }
}

// Decode the real upstream URL from a proxied Referer header
function unwrapReferer(refererHeader) {
  try {
    const u = new URL(refererHeader);
    const raw = u.searchParams.get('url');
    return raw || refererHeader;
  } catch {
    return refererHeader;
  }
}

// ── WebSocket relay ───────────────────────────────────────────────────────────

const wss = new WebSocketServer({ server, path: '/ws-relay' });

wss.on('connection', (clientWs, req) => {
  const qs = req.url.includes('?') ? req.url.split('?')[1] : '';
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
        'Origin': origin,
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
    if (clientWs.readyState === WS.OPEN) {
      clientWs.send(data, { binary: isBinary });
    }
  });

  targetWs.on('close', (c, r) => {
    try { clientWs.close(c, r); } catch {}
  });

  targetWs.on('error', () => {
    try { clientWs.close(1011); } catch {}
  });

  clientWs.on('message', (data, isBinary) => {
    if (ready && targetWs.readyState === WS.OPEN) {
      targetWs.send(data, { binary: isBinary });
    } else if (!ready) {
      buf.push([data, isBinary]);
    }
  });

  clientWs.on('close', () => {
    if (targetWs.readyState < 2) {
      try { targetWs.close(); } catch {}
    }
  });

  clientWs.on('error', () => {
    if (targetWs.readyState < 2) {
      try { targetWs.close(1011); } catch {}
    }
  });
});

// ── proxy route — handles GET, POST, PUT, PATCH, DELETE ───────────────────────

app.all('/proxy', async (req, res) => {
  const target = req.query.url;

  if (!target) {
    return res.status(400).send('Missing ?url=');
  }

  const targetOrigin = getOrigin(target);

  // Build upstream headers — make the request look like a real browser
  const upstreamHeaders = {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',

    'Accept':
      req.headers['accept'] ||
      'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',

    'Accept-Language': 'en-US,en;q=0.9',

    'Accept-Encoding': 'gzip, deflate, br',

    // Referer: unwrap from our proxy URL so it looks like it came from the real site
    'Referer':
      req.headers['referer']
        ? unwrapReferer(req.headers['referer'])
        : target,

    // Origin: rewrite to match target so CORS + CSRF checks pass
    'Origin':
      req.headers['origin']
        ? targetOrigin
        : undefined,
  };

  // Strip undefined
  Object.keys(upstreamHeaders).forEach(k => {
    if (upstreamHeaders[k] === undefined) {
      delete upstreamHeaders[k];
    }
  });

  // Forward session cookies
  if (req.headers['cookie']) {
    upstreamHeaders['Cookie'] = req.headers['cookie'];
  }

  // Forward content-type for POST bodies
  if (req.headers['content-type']) {
    upstreamHeaders['Content-Type'] = req.headers['content-type'];
  }

  // Forward security headers that login APIs need
  [
    'x-csrf-token',
    'x-xsrf-token',
    'x-requested-with',
    'authorization',
    'x-request-id',
    'x-transaction-id',
  ].forEach(h => {
    if (req.headers[h]) {
      upstreamHeaders[h] = req.headers[h];
    }
  });

  // Build body for POST/PUT/PATCH
  let requestBody;

  if (['POST', 'PUT', 'PATCH'].includes(req.method)) {
    requestBody = req.body;

    // express.raw() gives a Buffer for unknown content-types
    if (
      Buffer.isBuffer(requestBody) &&
      requestBody.length === 0
    ) {
      requestBody = undefined;
    }

    if (
      typeof requestBody === 'object' &&
      !Buffer.isBuffer(requestBody) &&
      Object.keys(requestBody).length === 0
    ) {
      requestBody = undefined;
    }
  }

  let response;

  try {
    response = await axios({
      method: req.method,
      url: target,
      headers: upstreamHeaders,
      data: requestBody,
      responseType: 'arraybuffer',
      timeout: 15000,
      maxRedirects: 8,

      // Don't throw on 4xx/5xx — forward them so the client sees the real error
      validateStatus: () => true,
    });
  } catch (err) {
    return res.status(502).send(`
      <style>
        body {
          font-family: monospace;
          padding: 2rem;
          background: #111;
          color: #e74c3c;
        }

        a {
          color: #666;
        }
      </style>

      <h2>couldn't reach that page</h2>
      <p>${err.message}</p>
      <a href="/">← home</a>
    `);
  }

  // Strip headers that block rewriting / framing
  [
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
  ].forEach(h => res.removeHeader(h));

  // Forward status code
  res.status(response.status);

  // Forward Set-Cookie — strip domain/secure so browser accepts on localhost
  const setCookies = response.headers['set-cookie'];

  if (setCookies) {
    const cleaned = (
      Array.isArray(setCookies)
        ? setCookies
        : [setCookies]
    ).map(c =>
      c
        .replace(/;\s*domain=[^;]*/gi, '')
        .replace(/;\s*secure/gi, '')
        .replace(/;\s*samesite=[^;]*/gi, '')
    );

    res.setHeader('Set-Cookie', cleaned);
  }

  // Handle redirects — rewrite Location header through proxy
  if (response.headers['location']) {
    const loc = response.headers['location'];

    res.setHeader(
      'Location',
      wrap(loc, target)
    );

    return res.end();
  }

  const ct = (
    response.headers['content-type'] || ''
  ).toLowerCase();

  // ── CSS ───────────────────────────────────────────────────────────────────

  if (ct.includes('text/css')) {
    let css = response.data.toString('utf-8');

    css = css.replace(
      /url\(\s*(['"]?)([^'")\s]+)\1\s*\)/g,
      (match, q, u) => {
        if (u.startsWith('data:')) {
          return match;
        }

        return `url(${q}${wrap(u, target)}${q})`;
      }
    );

    res.set('Content-Type', ct);

    return res.send(css);
  }

  // ── Non-HTML passthrough ──────────────────────────────────────────────────

  if (!ct.includes('text/html')) {
    res.set(
      'Content-Type',
      ct || 'application/octet-stream'
    );

    return res.send(response.data);
  }

  // ── HTML rewrite ──────────────────────────────────────────────────────────

  const html = response.data.toString('utf-8');

  const $ = cheerio.load(html, {
    decodeEntities: false
  });

  $('[href]').each((_, el) => {
    const v = $(el).attr('href');
    const r = wrap(v, target);

    if (r !== v) {
      $(el).attr('href', r);
    }
  });

  $('[src]').each((_, el) => {
    const v = $(el).attr('src');
    const r = wrap(v, target);

    if (r !== v) {
      $(el).attr('src', r);
    }
  });

  $('[srcset]').each((_, el) => {
    const raw = $(el).attr('srcset');

    const rw = raw
      .split(',')
      .map(p => {
        const parts = p.trim().split(/\s+/);

        parts[0] = wrap(parts[0], target);

        return parts.join(' ');
      })
      .join(', ');

    $(el).attr('srcset', rw);
  });

  $('[action]').each((_, el) => {
    const v = $(el).attr('action');
    const r = wrap(v, target);

    if (r !== v) {
      $(el).attr('action', r);
    }
  });

  $('[data-src]').each((_, el) => {
    const v = $(el).attr('data-src');
    const r = wrap(v, target);

    if (r !== v) {
      $(el).attr('data-src', r);
    }
  });

  $('meta[http-equiv="refresh"]').each((_, el) => {
    const c = $(el).attr('content') || '';
    const m = c.match(/^(\d+;\s*url=)(.+)$/i);

    if (m) {
      $(el).attr(
        'content',
        `${m[1]}${wrap(m[2], target)}`
      );
    }
  });

  $('meta[http-equiv="content-security-policy"]').remove();
  $('meta[http-equiv="Content-Security-Policy"]').remove();

  // Rewrite same-origin string literals inside inline scripts
  const pageOrigin = getOrigin(target);

  if (pageOrigin) {
    const escaped = pageOrigin.replace(
      /[.*+?^${}()|[\]\\]/g,
      '\\$&'
    );

    const pat = new RegExp(
      `(["'\`])${escaped}(/[a-zA-Z0-9/_\\-.%?=&]*)\\1`,
      'g'
    );

    $('script:not([src])').each((_, el) => {
      const code = $(el).html();

      if (
        !code ||
        code.length > 300_000 ||
        !code.includes(pageOrigin)
      ) {
        return;
      }

      const rw = code.replace(
        pat,
        (_, q, path) =>
          `${q}/proxy?url=${encodeURIComponent(
            pageOrigin + path
          )}${q}`
      );

      if (rw !== code) {
        $(el).html(rw);
      }
    });
  }

  // ── Client-side intercept injection ──────────────────────────────────────
  $('head').prepend(`<script>
(function () {
  'use strict';

  var BASE = ${JSON.stringify(target)};

  // Automatically use ws:// for local HTTP and wss:// for HTTPS/Render.
  var WS_PROTO = location.protocol === 'https:' ? 'wss:' : 'ws:';
  var WS_RELAY = WS_PROTO + '//' + location.host + '/ws-relay';

  var PAGE_ORI = ${JSON.stringify(pageOrigin)};

  function toProxy(u) {
    if (!u || typeof u !== 'string') return u;

    if (u.startsWith('/proxy?url=')) return u;

    var bad = [
      '#',
      'javascript:',
      'mailto:',
      'data:',
      'blob:',
      'tel:'
    ];

    for (var i = 0; i < bad.length; i++) {
      if (u.startsWith(bad[i])) return u;
    }

    try {
      var abs = new URL(u, BASE).toString();

      return abs.startsWith('http')
        ? '/proxy?url=' + encodeURIComponent(abs)
        : u;

    } catch(e) {
      return u;
    }
  }

  function toWsRelay(u) {
    return WS_RELAY +
      '?url=' + encodeURIComponent(u) +
      '&origin=' + encodeURIComponent(PAGE_ORI);
  }

  // WebSocket relay
  var _WS = window.WebSocket;

  if (_WS) {
    function PortalWS(url, protocols) {
      var relayed = toWsRelay(url);

      return protocols !== undefined
        ? new _WS(relayed, protocols)
        : new _WS(relayed);
    }

    PortalWS.prototype = _WS.prototype;

    PortalWS.CONNECTING = 0;
    PortalWS.OPEN = 1;
    PortalWS.CLOSING = 2;
    PortalWS.CLOSED = 3;

    window.WebSocket = PortalWS;
  }

  // fetch override
  var _fetch = window.fetch;

  if (_fetch) {
    window.fetch = function(input, init) {
      try {
        if (typeof input === 'string') {
          input = toProxy(input);
        } else if (input && input.url) {
          var p = toProxy(input.url);

          if (p !== input.url) {
            input = new Request(p, input);
          }
        }
      } catch(e) {}

      return _fetch.call(
        window,
        input,
        init
      );
    };
  }

  // XHR override
  var _xhrOpen = XMLHttpRequest.prototype.open;

  XMLHttpRequest.prototype.open = function() {
    var args = Array.prototype.slice.call(arguments);

    if (args[1]) {
      try {
        args[1] = toProxy(args[1]);
      } catch(e) {}
    }

    return _xhrOpen.apply(this, args);
  };

  // history API
  ['pushState', 'replaceState'].forEach(function(m) {
    var orig = history[m];

    history[m] = function(state, title, url) {
      if (url) {
        try {
          url = toProxy(url);
        } catch(e) {}
      }

      return orig.call(
        this,
        state,
        title,
        url
      );
    };
  });

  // location.assign / replace
  try {
    var _assign =
      window.location.assign.bind(window.location);

    var _replace =
      window.location.replace.bind(window.location);

    window.location.assign = function(u) {
      _assign(toProxy(u));
    };

    window.location.replace = function(u) {
      _replace(toProxy(u));
    };
  } catch(e) {}

  // location.href setter
  try {
    var lp = Object.getPrototypeOf(window.location);

    var desc =
      Object.getOwnPropertyDescriptor(
        lp,
        'href'
      );

    if (desc && desc.set) {
      Object.defineProperty(lp, 'href', {
        get: desc.get,

        set: function(v) {
          desc.set.call(
            window.location,
            toProxy(v)
          );
        },

        configurable: true,
      });
    }
  } catch(e) {}

  // window.open
  var _open = window.open;

  window.open = function(url, tgt, feat) {
    return _open.call(
      this,
      toProxy(url),
      tgt,
      feat
    );
  };

  // click intercept
  document.addEventListener(
    'click',
    function(e) {
      var a =
        e.target &&
        e.target.closest &&
        e.target.closest('a[href]');

      if (!a) return;

      var h = a.getAttribute('href');

      if (
        !h ||
        h.startsWith('#') ||
        h.startsWith('javascript:')
      ) {
        return;
      }

      if (h.startsWith('/proxy?url=')) {
        return;
      }

      e.preventDefault();

      window.location.href = toProxy(h);
    },
    true
  );

  // form submit — rewrite action and forward through proxy
  document.addEventListener(
    'submit',
    function(e) {
      var form = e.target;

      if (!form || !form.action) return;

      if (!form.action.startsWith('/proxy?url=')) {
        try {
          form.action = toProxy(form.action);
        } catch(err) {}
      }
    },
    true
  );

})();
</script>`);

  // Floating toolbar
  const safeVal = target.replace(
    /"/g,
    '&quot;'
  );

  $('body').append(`
<div id="__portal_bar" style="
  position:fixed;
  bottom:0;
  left:0;
  right:0;
  z-index:2147483647;
  background:rgba(12,12,12,0.97);
  backdrop-filter:blur(12px);
  -webkit-backdrop-filter:blur(12px);
  display:flex;
  align-items:center;
  gap:8px;
  padding:7px 12px;
  border-top:1px solid #1e1e1e;
  font-family:'Courier New',monospace;
">
  <a
    href="/"
    title="home"
    style="
      color:#444;
      text-decoration:none;
      font-size:17px;
      flex-shrink:0;
      line-height:1;
    "
  >⬡</a>

  <button
    onclick="history.back()"
    style="
      background:transparent;
      border:1px solid #252525;
      border-radius:4px;
      color:#555;
      padding:3px 9px;
      cursor:pointer;
      font-family:'Courier New',monospace;
      font-size:11px;
      flex-shrink:0;
    "
  >←</button>

  <input
    id="__portal_i"
    value="${safeVal}"
    style="
      flex:1;
      min-width:0;
      background:#111;
      border:1px solid #222;
      border-radius:5px;
      color:#c0c0c0;
      padding:5px 11px;
      font-family:'Courier New',monospace;
      font-size:12px;
      outline:none;
    "
    onfocus="this.style.borderColor='#2563eb'"
    onblur="this.style.borderColor='#222'"
    onkeydown="
      if(event.key==='Enter'){
        var v=this.value.trim();
        if(!v)return;
        var u=v.startsWith('http')
          ?v
          :'https://'+v;
        window.location.href=
          '/proxy?url='+encodeURIComponent(u);
      }
    "
  />

  <button
    onclick="
      var v=document
        .getElementById('__portal_i')
        .value.trim();

      if(!v)return;

      var u=v.startsWith('http')
        ?v
        :'https://'+v;

      window.location.href=
        '/proxy?url='+encodeURIComponent(u);
    "
    onmouseover="this.style.background='#1d4ed8'"
    onmouseout="this.style.background='#2563eb'"
    style="
      background:#2563eb;
      border:none;
      border-radius:5px;
      color:#fff;
      padding:5px 15px;
      cursor:pointer;
      font-family:'Courier New',monospace;
      font-size:12px;
      white-space:nowrap;
      flex-shrink:0;
    "
  >go →</button>
</div>

<div style="height:44px;"></div>
`);

  res.set(
    'Content-Type',
    'text/html; charset=utf-8'
  );

  res.send($.html());
});

// ── boot ──────────────────────────────────────────────────────────────────────

server.listen(PORT, () => {
  console.log(`
  ⬡ portal v3
  → http://localhost:${PORT}

  v3 fixes:
  • POST body forwarding   (login forms actually submit now)
  • Origin/Referer rewrite (passes CSRF checks on Roblox etc)
  • Redirect handling      (Location header gets proxied)
  • All HTTP methods       (GET POST PUT PATCH DELETE)
  • Render WebSocket support (ws:// locally, wss:// on HTTPS)
  `);
});
