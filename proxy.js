// stream. — local IPTV proxy
// Run: node proxy.js

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const dgram = require('dgram');
const os = require('os');

const PORT = 3001;
const TIMEOUT = 60000;
const CACHE_FILE = path.join(__dirname, 'channel-cache.json');
const TOKEN_FILE = path.join(__dirname, 'samsung-token.json');

// Samsung TV pairing token — stored on disk so it survives proxy restarts
function loadSamsungToken() {
  try { return JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8')).token || null; } catch { return null; }
}
function saveSamsungToken(token) {
  try { fs.writeFileSync(TOKEN_FILE, JSON.stringify({ token, savedAt: new Date().toISOString() })); } catch (e) { console.error('Token save failed:', e.message); }
}

// Find a device IP from the ARP cache by MAC address
function findInArpByMac(mac, cb) {
  const { exec } = require('child_process');
  const norm = m => m.toLowerCase().split(':').map(h => h.padStart(2, '0')).join(':');
  exec('arp -a', (err, stdout) => {
    if (err) { cb(null); return; }
    for (const line of (stdout || '').split('\n')) {
      const ipM  = line.match(/\((\d+\.\d+\.\d+\.\d+)\)/);
      const macM = line.match(/at\s+([0-9a-f:]+)/i);
      if (ipM && macM && norm(macM[1]) === norm(mac)) { cb(ipM[1]); return; }
    }
    cb(null);
  });
}

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

  // GET /wake-tv?mac=XX:XX:XX:XX:XX:XX — wake TV by pinging its IP
  // GET /wake-tv?mac=XX:XX:XX:XX:XX:XX — wake Samsung TV via two simultaneous methods:
  // 1. WoL magic packet to subnet broadcast (192.168.x.255) — works if TV has WoWLAN enabled
  // 2. UDP sweep of whole subnet — triggers ARP requests for uncached IPs; Samsung TVs
  //    wake on receiving an ARP request for their own address
  if (parsed.pathname === '/wake-tv') {
    const rawMac = parsed.searchParams.get('mac');
    if (!rawMac) { res.writeHead(400, CORS_HEADERS); res.end('Missing ?mac='); return; }
    const mac = rawMac.toLowerCase().replace(/-/g, ':').split(':').map(h => h.padStart(2, '0')).join(':');

    function respond(ip) {
      if (res.headersSent) return;
      res.writeHead(200, { ...CORS_HEADERS, 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, ip: ip || null }));
    }

    const localIp = Object.values(os.networkInterfaces()).flat()
      .find(i => !i.internal && i.family === 'IPv4')?.address || '192.168.178.43';
    const subnet = localIp.split('.').slice(0, 3).join('.');

    // Method 1: WoL magic packet to subnet broadcast
    // 102 bytes: 6×0xFF + 16 repetitions of the 6-byte MAC
    const macBytes = mac.split(':').map(h => parseInt(h, 16));
    const magic = Buffer.alloc(102);
    magic.fill(0xff, 0, 6);
    for (let i = 0; i < 16; i++) macBytes.forEach((b, j) => { magic[6 + i * 6 + j] = b; });
    const wolSock = dgram.createSocket('udp4');
    wolSock.bind(() => {
      wolSock.setBroadcast(true);
      wolSock.send(magic, 0, 102, 9, `${subnet}.255`, () => { try { wolSock.close(); } catch {} });
    });

    // Method 2: UDP sweep — triggers ARP requests for IPs not in cache.
    // Samsung TVs wake on an ARP request for their own IP.
    const sweepSock = dgram.createSocket('udp4');
    const buf = Buffer.alloc(1);
    let pending = 254;
    const onSent = () => {
      if (--pending > 0) return;
      try { sweepSock.close(); } catch {}
      // Wait for TV to respond to ARP, then confirm its IP
      setTimeout(() => findInArpByMac(mac, (foundIp) => respond(foundIp)), 1500);
    };
    sweepSock.bind(() => {
      for (let i = 1; i <= 254; i++) sweepSock.send(buf, 0, 1, 9, `${subnet}.${i}`, onSent);
    });
    return;
  }

  // GET /tv-off?mac=XX:XX:XX:XX:XX:XX — power off Samsung TV via WebSocket API (token-based auth)
  if (parsed.pathname === '/tv-off') {
    const rawMac = parsed.searchParams.get('mac');
    if (!rawMac) { res.writeHead(400, CORS_HEADERS); res.end('Missing ?mac='); return; }
    const mac = rawMac.toLowerCase().replace(/-/g, ':').split(':').map(h => h.padStart(2, '0')).join(':');

    findInArpByMac(mac, (ip) => {
      if (!ip) {
        res.writeHead(404, { ...CORS_HEADERS, 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'TV not found in ARP cache — is it powered on?' }));
        return;
      }
      try {
        const appName = Buffer.from('IPTVPlayer').toString('base64');
        const token   = loadSamsungToken();
        const wsUrl   = `ws://${ip}:8001/api/v2/channels/samsung.remote.control?name=${appName}${token ? `&token=${token}` : ''}`;
        console.log(`[tv-off] Connecting${token ? ' (with stored token)' : ' (no token — pairing required)'}:`, wsUrl);

        const ws = new WebSocket(wsUrl);
        let done = false;
        const finish = (ok, error) => {
          if (done) return; done = true;
          try { ws.close(); } catch {}
          res.writeHead(ok ? 200 : 500, { ...CORS_HEADERS, 'Content-Type': 'application/json' });
          res.end(JSON.stringify(ok ? { ok: true } : { ok: false, error }));
        };
        const sendPowerOff = () => {
          console.log('[tv-off] Sending KEY_POWEROFF');
          ws.send(JSON.stringify({
            method: 'ms.remote.control',
            params: { Cmd: 'Click', DataOfCmd: 'KEY_POWEROFF', Option: 'false', TypeOfRemote: 'SendRemoteKey' }
          }));
          setTimeout(() => finish(true), 800);
        };
        ws.addEventListener('message', (event) => {
          try {
            const msg = JSON.parse(event.data);
            console.log('[tv-off] msg:', JSON.stringify(msg));
            if (msg.event === 'ms.channel.connect') {
              // Save / refresh the token
              const t = msg.data?.token;
              if (t) { saveSamsungToken(t); console.log('[tv-off] Token saved:', t); }
              sendPowerOff();
            } else if (msg.event === 'ms.channel.unauthorized') {
              // Invalid / expired token — clear it so next call triggers fresh pairing
              try { fs.unlinkSync(TOKEN_FILE); } catch {}
              finish(false, 'pair_required');
            }
          } catch {}
        });
        ws.addEventListener('error', (e) => finish(false, e.message || 'WebSocket error'));
        setTimeout(() => {
          if (!done) finish(false, token
            ? 'Timeout — token may be expired; call /tv-pair to re-pair'
            : 'pair_required');
        }, 10000);
      } catch (err) {
        res.writeHead(500, CORS_HEADERS);
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
    });
    return;
  }

  // GET /tv-pair?mac=XX:XX:XX:XX:XX:XX — one-time Samsung TV pairing; TV must be on.
  // Connects without a token so the TV shows its "Allow connection?" dialog.
  // When user accepts on TV, saves the returned token for future /tv-off calls.
  if (parsed.pathname === '/tv-pair') {
    const rawMac = parsed.searchParams.get('mac');
    if (!rawMac) { res.writeHead(400, CORS_HEADERS); res.end('Missing ?mac='); return; }
    const mac = rawMac.toLowerCase().replace(/-/g, ':').split(':').map(h => h.padStart(2, '0')).join(':');

    findInArpByMac(mac, (ip) => {
      if (!ip) {
        res.writeHead(404, { ...CORS_HEADERS, 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'TV not found in ARP cache — is it powered on?' }));
        return;
      }
      // Clear any stale token so we force a fresh pairing dialog
      try { fs.unlinkSync(TOKEN_FILE); } catch {}

      const appName = Buffer.from('IPTVPlayer').toString('base64');
      const wsUrl   = `ws://${ip}:8001/api/v2/channels/samsung.remote.control?name=${appName}`;
      console.log('[tv-pair] Connecting for pairing:', wsUrl);

      const ws = new WebSocket(wsUrl);
      let done = false;
      const finish = (ok, data) => {
        if (done) return; done = true;
        try { ws.close(); } catch {}
        res.writeHead(ok ? 200 : 500, { ...CORS_HEADERS, 'Content-Type': 'application/json' });
        res.end(JSON.stringify(ok ? { ok: true, ...data } : { ok: false, error: data }));
      };
      ws.addEventListener('message', (event) => {
        try {
          const msg = JSON.parse(event.data);
          console.log('[tv-pair] msg:', JSON.stringify(msg));
          if (msg.event === 'ms.channel.connect') {
            const t = msg.data?.token;
            if (t) saveSamsungToken(t);
            console.log('[tv-pair] Paired! Token:', t || '(none)');
            finish(true, { token: t || null });
          } else if (msg.event === 'ms.channel.unauthorized') {
            finish(false, 'TV rejected pairing — check TV settings (General → External Device Manager → Device Connection Manager)');
          }
        } catch {}
      });
      ws.addEventListener('error', (e) => finish(false, e.message || 'WebSocket error'));
      // Long timeout — user needs time to see and accept the dialog on the TV
      setTimeout(() => {
        if (!done) finish(false, 'Timeout — no response from TV. Ensure TV is on and accept the pairing dialog if one appeared.');
      }, 30000);
    });
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
