const http = require('node:http');
const https = require('node:https');

// =====================DOMAIN=====================
const TARGET_BASE = (process.env.TARGET_DOMAIN || "").replace(/\/$/, "");
const PORT = process.env.PORT || 8080;

// ===================HEADERS=======================
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
    const options = {
      method: req.method,
      headers: {},
    };

    let clientIp = null;

    // فیلتر کردن هدرها و تنظیم آی‌پی واقعی
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
      options.headers[k] = v;
    }

    if (clientIp) options.headers["x-forwarded-for"] = clientIp;

    // تشخیص اینکه مقصد http هست یا https
    const protocol = targetUrl.protocol === 'http:' ? http : https;

    // ساختن درخواستِ پروکسی به سمت مقصد
    const proxyReq = protocol.request(targetUrl, options, (proxyRes) => {
      const resHeaders = { ...proxyRes.headers };
      
      // نود.جی‌اس خودش چانک‌بندی رو مدیریت می‌کنه، پس این هدرها رو حذف می‌کنیم تا تداخل پیش نیاد
      delete resHeaders['transfer-encoding'];
      delete resHeaders['connection'];

      res.writeHead(proxyRes.statusCode, resHeaders);
      
      // جادوی اصلی: اتصال مستقیم لوله‌ی دانلود بدون درگیر کردن CPU
      proxyRes.pipe(res);
    });

    // مدیریت خطاهای پروکسی
    proxyReq.on('error', (err) => {
      if (!res.headersSent) {
        res.writeHead(502);
        res.end();
      }
    });

    req.on('error', (err) => {
      proxyReq.destroy();
    });

    // ===================MAGIC=======================
    // ترفندِ ۶۰ ثانیه‌ای برای زنده نگه‌داشتنِ تونل‌های xhttp
    const timeoutId = setTimeout(() => {
      proxyReq.destroy();
    }, 60000);

    proxyReq.on('close', () => clearTimeout(timeoutId));
    proxyReq.on('error', () => clearTimeout(timeoutId));

    // جادوی دوم: اتصال مستقیم لوله‌ی آپلودِ تو به سمت گوگل
    req.pipe(proxyReq);

  } catch (err) {
    if (!res.headersSent) {
      res.writeHead(500);
      res.end();
    }
  }
});

// تنظیمات مربوط به جلوگیری از قطعی کانکشن تو کلاد ران
server.keepAliveTimeout = 60000;
server.headersTimeout = 65000;

server.listen(PORT, () => {
  console.log(`[Raw Node.js] Proxy is silently running on port ${PORT}...`);
});
