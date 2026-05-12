const http = require('http');
const https = require('https');
const dns = require('dns');

dns.setDefaultResultOrder('ipv4first');

const TARGET_BASE = (process.env.TARGET_DOMAIN || "").replace(/\/$/, "");
const PORT = process.env.PORT || 8080;

const STRIP_HEADERS = new Set([
  "host", "connection", "keep-alive", "proxy-authenticate",
  "proxy-authorization", "te", "trailer", "transfer-encoding",
  "upgrade", "forwarded", "x-forwarded-host", "x-forwarded-proto",
  "x-forwarded-port",
]);

const server = http.createServer((req, res) => {
  if (!TARGET_BASE) {
    res.writeHead(500);
    return res.end();
  }

  try {
    const targetUrl = new URL(req.url, TARGET_BASE);
    const protocol = targetUrl.protocol === 'http:' ? http : https;

    const options = {
      method: req.method,
      headers: {},
    };

    let clientIp = null;
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      const k = req.rawHeaders[i];
      const v = req.rawHeaders[i + 1];
      const lowerK = k.toLowerCase();

      if (STRIP_HEADERS.has(lowerK)) continue;

      if (lowerK === "x-real-ip") {
        clientIp = v;
        continue;
      }
      if (lowerK === "x-forwarded-for") {
        if (!clientIp) clientIp = v;
        continue;
      }
      options.headers[k] = v;
    }
    if (clientIp) options.headers["x-forwarded-for"] = clientIp;

    const proxyReq = protocol.request(targetUrl, options, (proxyRes) => {
      const resHeaders = { ...proxyRes.headers };
      
      delete resHeaders['transfer-encoding'];
      delete resHeaders['connection'];

      res.writeHead(proxyRes.statusCode, resHeaders);
      proxyRes.pipe(res);

      proxyRes.on('error', (err) => {
        if (!res.destroyed) res.destroy(err);
      });
    });

    proxyReq.setTimeout(60000, () => {
      proxyReq.destroy(new Error('upstream_timeout'));
    });

    proxyReq.on('error', (err) => {
      if (!res.headersSent) {
        res.writeHead(502);
        res.end();
      } else if (!res.destroyed) {
        res.destroy(err);
      }
    });

    req.on('error', (err) => {
      if (!proxyReq.destroyed) proxyReq.destroy(err);
    });

    req.on('aborted', () => {
      if (!proxyReq.destroyed) proxyReq.destroy(new Error('client_aborted'));
    });

    req.pipe(proxyReq);

  } catch (err) {
    if (!res.headersSent) {
      res.writeHead(500);
      res.end();
    } else if (!res.destroyed) {
      res.destroy(err);
    }
  }
});

server.keepAliveTimeout = 120000; 
server.headersTimeout = 125000;

server.listen(PORT, '0.0.0.0');
