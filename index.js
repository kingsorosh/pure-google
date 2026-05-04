const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');

const app = express();
// گوگل پورت رو خودش اختصاص میده، اگر نداد روی 8080 اجرا میشه
const PORT = process.env.PORT || 8080; 

// آدرس سرور اصلی شما (آلمان)
const TARGET = 'https://cdn.dorushio.dpdns.org:8443';

app.use('/', createProxyMiddleware({
    target: TARGET,
    changeOrigin: true,
    ws: true, // این خط به شدت مهمه! اجازه عبور ترافیک وب‌ساکت و تونل‌ها رو میده
    logLevel: 'debug', // برای اینکه ارورها رو توی لاگ گوگل ببینیم
    onError: (err, req, res) => {
        console.error('Proxy Error:', err);
        res.status(500).send('Proxy Connection Failed');
    }
}));

app.listen(PORT, () => {
    console.log(`Proxy server is running on port ${PORT}`);
});