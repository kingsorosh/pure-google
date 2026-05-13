const http = require('http');
const { pipeline } = require('node:stream/promises');
const { Readable } = require('node:stream');

const TARGET_BASE = (process.env.TARGET_DOMAIN || "").replace(/\/$/, "");
const PORT = process.env.PORT || 8080;

const STRIP_HEADERS = new Set([
  "host", "connection", "keep-alive", "proxy-authenticate",
  "proxy-authorization", "te", "trailer", "transfer-encoding",
  "upgrade", "forwarded", "x-forwarded-host", "x-forwarded-proto",
  "x-forwarded-port",
]);

const server = http.createServer(async (req, res) => {
  if (!TARGET_BASE) {
    res.writeHead(500);
    return res.end("Misconfigured: TARGET_DOMAIN is not set");
  }

  try {
    const targetUrl = TARGET_BASE + req.url;
    const outHeaders = new Headers();
    let clientIp = null;

    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      const k = req.rawHeaders[i];
      const v = req.rawHeaders[i + 1];
      const lowerK = k.toLowerCase();

      if (STRIP_HEADERS.has(lowerK)) continue;
      if (lowerK.startsWith("x-vercel-")) continue;
      
      if (lowerK === "x-real-ip") {
        clientIp = v;
        continue;
      }
      if (lowerK === "x-forwarded-for") {
        if (!clientIp) clientIp = v;
        continue;
      }
      outHeaders.set(k, v);
    }
    
    if (clientIp) outHeaders.set("x-forwarded-for", clientIp);

    const method = req.method;
    const hasBody = method !== "GET" && method !== "HEAD";

    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
      controller.abort();
    }, 60000); 

    const fetchOptions = {
      method,
      headers: outHeaders,
      duplex: "half", 
      redirect: "manual",
      signal: controller.signal
    };

    if (hasBody) {
      fetchOptions.body = Readable.toWeb(req); 
    }

    let targetResponse;
    try {
      targetResponse = await fetch(targetUrl, fetchOptions);
    } finally {
      clearTimeout(timeoutId);
    }

    res.statusCode = targetResponse.status;
    targetResponse.headers.forEach((value, key) => {
      const lowerKey = key.toLowerCase();
      if (lowerKey !== 'transfer-encoding' && lowerKey !== 'connection') {
        res.setHeader(key, value);
      }
    });

    if (targetResponse.body) {
      const downloadStream = Readable.fromWeb(targetResponse.body);
      await pipeline(downloadStream, res);
    } else {
      res.end();
    }

  } catch (err) {
    if (err.name === 'AbortError') {
      if (!res.headersSent) {
        res.writeHead(504);
        res.end(); 
      }
      return;
    }
    
    if (!res.headersSent) {
      res.writeHead(502);
      res.end();
    } else if (!res.destroyed) {
      res.destroy();
    }
  }
});

server.keepAliveTimeout = 60000;
server.headersTimeout = 65000;

server.listen(PORT, '0.0.0.0');
