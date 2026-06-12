// stream. — local IPTV proxy
// Run: node proxy.js

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const dgram = require('dgram');

const PORT = 3001;
const TIMEOUT = 60000;
const CACHE_FILE = path.join(__dirname, 'channel-cache.json');

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

// Follow redirects without buffering the response body.
// Resolves with { finalUrl, upstream } where upstream is the unread IncomingMessage.
function resolveUrl(targetUrl, depth = 0) {
  return new Promise((resolve, reject) => {
    if (depth > 5) { reject(new Error('Too many redirects')); return; }
    const parsed = new URL(targetUrl);
    const lib = parsed.protocol === 'https:' ? https : http;
    const req = lib.request({
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: 'GET',
      headers: { 'User-Agent': 'Mozilla/5.0' },
      timeout: TIMEOUT,
      rejectUnauthorized: false,
    }, (upstream) => {
      if ([301, 302, 307, 308].includes(upstream.statusCode) && upstream.headers.location) {
        upstream.resume();
        const next = new URL(upstream.headers.location, targetUrl).toString();
        resolveUrl(next, depth + 1).then(resolve).catch(reject);
        return;
      }
      resolve({ finalUrl: targetUrl, upstream });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    req.end();
  });
}

function rewriteHlsBody(body, finalUrl, proxyHost) {
  return body.split('\n').map(line => {
    const t = line.trim();
    if (!t || t.startsWith('#')) return line;
    try {
      const abs = new URL(t, finalUrl).toString();
      return `http://${proxyHost}/proxy?url=${encodeURIComponent(abs)}`;
    } catch { return line; }
  }).join('\n');
}

function makeRequest(targetUrl, res, clientReq = null, depth = 0) {
  if (depth > 5) {
    res.writeHead(502, CORS_HEADERS);
    res.end('Too many redirects');
    return;
  }

  const parsed = new URL(targetUrl);
  const lib = parsed.protocol === 'https:' ? https : http;

  const reqHeaders = { 'User-Agent': 'Mozilla/5.0' };
  if (clientReq?.headers?.range) reqHeaders['Range'] = clientReq.headers.range;

  const options = {
    hostname: parsed.hostname,
    port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
    path: parsed.pathname + parsed.search,
    method: 'GET',
    headers: reqHeaders,
    timeout: TIMEOUT,
    rejectUnauthorized: false,
  };

  const req = lib.request(options, (upstream) => {
    if ([301, 302, 307, 308].includes(upstream.statusCode) && upstream.headers.location) {
      upstream.resume();
      const next = new URL(upstream.headers.location, targetUrl).toString();
      makeRequest(next, res, clientReq, depth + 1);
      return;
    }
    const ct = upstream.headers['content-type'] || 'application/octet-stream';
    // Normalise non-standard status codes (e.g. 884 from some IPTV providers)
    const statusCode = (upstream.statusCode >= 100 && upstream.statusCode <= 599)
      ? upstream.statusCode : 200;
    const resHeaders = { ...CORS_HEADERS, 'Content-Type': ct };
    if (upstream.headers['content-range'])  resHeaders['Content-Range']  = upstream.headers['content-range'];
    if (upstream.headers['accept-ranges'])  resHeaders['Accept-Ranges']  = upstream.headers['accept-ranges'];
    if (upstream.headers['content-length']) resHeaders['Content-Length'] = upstream.headers['content-length'];
    res.writeHead(statusCode, resHeaders);
    upstream.pipe(res);
  });

  req.on('error', (err) => {
    if (!res.headersSent) {
      res.writeHead(502, CORS_HEADERS);
      res.end('Proxy error: ' + err.message);
    }
  });

  req.on('timeout', () => {
    req.destroy();
    if (!res.headersSent) {
      res.writeHead(504, CORS_HEADERS);
      res.end('Timeout');
    }
  });

  req.end();
}

const server = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS_HEADERS);
    res.end();
    return;
  }

  const parsed = new URL(req.url, `http://127.0.0.1:${PORT}`);

  // Serve the player UI at /
  if (parsed.pathname === '/' || parsed.pathname === '/index.html') {
    const htmlPath = path.join(__dirname, 'iptv-player.html');
    fs.readFile(htmlPath, (err, data) => {
      if (err) {
        res.writeHead(404);
        res.end('iptv-player.html not found');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(data);
    });
    return;
  }

  if (parsed.pathname === '/health') {
    res.writeHead(200, { ...CORS_HEADERS, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, port: PORT }));
    return;
  }

  // GET /cache — return cached channel list
  if (req.method === 'GET' && parsed.pathname === '/cache') {
    fs.readFile(CACHE_FILE, (err, data) => {
      if (err) {
        res.writeHead(404, { ...CORS_HEADERS, 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'No cache found' }));
        return;
      }
      res.writeHead(200, { ...CORS_HEADERS, 'Content-Type': 'application/json' });
      res.end(data);
    });
    return;
  }

  // POST /cache — save channel list to disk
  if (req.method === 'POST' && parsed.pathname === '/cache') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      fs.writeFile(CACHE_FILE, body, (err) => {
        if (err) {
          res.writeHead(500, { ...CORS_HEADERS, 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
          return;
        }
        res.writeHead(200, { ...CORS_HEADERS, 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      });
    });
    return;
  }

  // GET /hls?url=... — smart HLS/VOD endpoint
  // - Seek requests (Range header present): forwarded directly to upstream
  // - Initial load: inspects Content-Type without buffering body
  //     application/x-mpegurl or body starts with #EXTM3U → rewrite manifest
  //     video/* or audio/*                                  → 302 to /proxy (streaming + Range)
  //     ambiguous (octet-stream, text/*, empty)             → peek first bytes then decide
  if (req.method === 'GET' && parsed.pathname === '/hls') {
    let target = parsed.searchParams.get('url');
    if (!target) { res.writeHead(400, CORS_HEADERS); res.end('Missing ?url='); return; }
    if (target.endsWith('.ts') && !target.includes('/live/') && !target.includes('/hls/')) {
      target = target.replace(/\/([^/]+)\/([^/]+)\/(\d+)\.ts$/, '/live/$1/$2/$3.m3u8');
    }

    // Seeking — forward Range header directly, no manifest rewriting needed
    if (req.headers.range) {
      makeRequest(target, res, req);
      return;
    }

    const proxyHost = req.headers.host || `127.0.0.1:${PORT}`;

    resolveUrl(target).then(({ finalUrl, upstream }) => {
      const ct = upstream.headers['content-type'] || '';
      let sent = false;

      const redirect = () => {
        if (sent) return; sent = true;
        res.writeHead(302, { ...CORS_HEADERS, 'Location': `http://${proxyHost}/proxy?url=${encodeURIComponent(finalUrl)}` });
        res.end();
      };

      // Clearly a video/audio file — redirect immediately, no buffering
      if (ct.startsWith('video/') || ct.startsWith('audio/')) {
        upstream.resume();
        redirect();
        return;
      }

      // HLS or ambiguous — buffer to inspect then rewrite or redirect
      const chunks = [];
      const definitelyHls = ct.includes('mpegurl') || ct.includes('m3u');

      upstream.on('data', chunk => {
        if (sent) return;
        chunks.push(chunk);
        // For ambiguous types, bail early if first bytes aren't an HLS marker
        if (!definitelyHls) {
          const peek = Buffer.concat(chunks).slice(0, 16).toString('utf8').trimStart();
          if (!peek.startsWith('#EXTM3U') && !peek.startsWith('#EXT-X-')) {
            upstream.destroy();
            redirect();
          }
        }
      });

      upstream.on('end', () => {
        if (sent) return; sent = true;
        const body = Buffer.concat(chunks).toString('utf8');
        if (body.trimStart().startsWith('#EXTM3U') || body.includes('#EXT-X-TARGETDURATION')) {
          res.writeHead(200, { ...CORS_HEADERS, 'Content-Type': 'application/x-mpegURL' });
          res.end(rewriteHlsBody(body, finalUrl, proxyHost));
        } else {
          redirect();
        }
      });

      upstream.on('error', err => {
        if (sent) return; sent = true;
        res.writeHead(502, CORS_HEADERS); res.end(err.message);
      });
    }).catch(err => {
      if (!res.headersSent) { res.writeHead(502, CORS_HEADERS); res.end(err.message); }
    });
    return;
  }

  // GET /wol?mac=XX:XX:XX:XX:XX:XX&broadcast=255.255.255.255 — Wake on LAN
  if (parsed.pathname === '/wol') {
    const mac = parsed.searchParams.get('mac');
    const broadcast = parsed.searchParams.get('broadcast') || '255.255.255.255';
    if (!mac) { res.writeHead(400, CORS_HEADERS); res.end('Missing ?mac='); return; }
    try {
      const macBytes = mac.split(/[:\-]/).map(h => parseInt(h, 16));
      if (macBytes.length !== 6 || macBytes.some(isNaN)) throw new Error('Invalid MAC');
      const magic = Buffer.alloc(102);
      magic.fill(0xff, 0, 6);
      for (let i = 0; i < 16; i++) macBytes.forEach((b, j) => magic[6 + i * 6 + j] = b);
      const sock = dgram.createSocket('udp4');
      sock.once('error', (err) => {
        sock.close();
        res.writeHead(500, { ...CORS_HEADERS, 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      });
      sock.bind(() => {
        sock.setBroadcast(true);
        sock.send(magic, 0, magic.length, 9, broadcast, (err) => {
          sock.close();
          if (err) {
            res.writeHead(500, { ...CORS_HEADERS, 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: err.message }));
          } else {
            res.writeHead(200, { ...CORS_HEADERS, 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true }));
          }
        });
      });
    } catch (err) {
      res.writeHead(400, CORS_HEADERS);
      res.end(JSON.stringify({ ok: false, error: err.message }));
    }
    return;
  }

  // GET /tv-off?ip=192.168.x.x — Samsung TV power off via WebSocket API
  if (parsed.pathname === '/tv-off') {
    const ip = parsed.searchParams.get('ip');
    if (!ip) { res.writeHead(400, CORS_HEADERS); res.end('Missing ?ip='); return; }
    try {
      const appName = Buffer.from('IPTV Player').toString('base64');
      const ws = new WebSocket(`ws://${ip}:8001/api/v2/channels/samsung.remote.control?name=${appName}`);
      let done = false;
      const finish = (ok, error) => {
        if (done) return; done = true;
        try { ws.close(); } catch {}
        res.writeHead(ok ? 200 : 500, { ...CORS_HEADERS, 'Content-Type': 'application/json' });
        res.end(JSON.stringify(ok ? { ok: true } : { ok: false, error }));
      };
      ws.addEventListener('open', () => {
        ws.send(JSON.stringify({
          method: 'ms.remote.control',
          params: { Cmd: 'Click', DataOfCmd: 'KEY_POWER', Option: 'false', TypeOfRemote: 'SendRemoteKey' }
        }));
        setTimeout(() => finish(true), 1000);
      });
      ws.addEventListener('error', (e) => finish(false, e.message || 'WebSocket error'));
      setTimeout(() => finish(false, 'Timeout connecting to TV'), 5000);
    } catch (err) {
      res.writeHead(500, CORS_HEADERS);
      res.end(JSON.stringify({ ok: false, error: err.message }));
    }
    return;
  }

  if (parsed.pathname === '/proxy') {
    const target = parsed.searchParams.get('url');
    if (!target) {
      res.writeHead(400, CORS_HEADERS);
      res.end('Missing ?url= parameter');
      return;
    }
    try {
      new URL(target);
    } catch {
      res.writeHead(400, CORS_HEADERS);
      res.end('Invalid URL');
      return;
    }
    makeRequest(target, res, req);
    return;
  }

  res.writeHead(404, CORS_HEADERS);
  res.end('Not found');
});

server.listen(PORT, '0.0.0.0', () => {
  const os = require('os');
  const localIp = Object.values(os.networkInterfaces())
    .flat()
    .find(i => i.family === 'IPv4' && !i.internal)?.address || 'your-ip';
  console.log('');
  console.log('  stream. proxy running');
  console.log('  ➜  http://localhost:' + PORT + '  (this machine)');
  console.log('  ➜  http://' + localIp + ':' + PORT + '  (other devices)');
  console.log('  Press Ctrl+C to stop');
  console.log('');
});
