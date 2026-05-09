const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const qrcode = require('qrcode');
const archiver = require('archiver');
const { exec } = require('child_process');

const app = express();
const PORT = 3000;
const SHARED_DIR = path.join(__dirname, 'shared');
const QR_CODE_PATH = path.join(__dirname, 'public', 'qrcode.png');

// Generate access token from startup timestamp
const STARTUP_TIMESTAMP = Date.now().toString();
const ACCESS_TOKEN = crypto.createHash('sha256').update(STARTUP_TIMESTAMP).digest('hex').substring(0, 16);

if (!fs.existsSync(SHARED_DIR)) {
    fs.mkdirSync(SHARED_DIR);
}

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, SHARED_DIR),
    filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname)
});
const upload = multer({ storage });

// Auth middleware - checks token in query param or x-access-token header
function authRequired(req, res, next) {
    const token = req.query.token || req.headers['x-access-token'];
    if (token === ACCESS_TOKEN) return next();
    res.status(403).json({ error: 'Acesso negado. Token inválido.' });
}

// Serve static assets (CSS, JS) without auth, but protect the main page
app.get('/', (req, res) => {
    const token = req.query.token;
    if (token !== ACCESS_TOKEN) {
        return res.status(403).send(`<!DOCTYPE html>
<html lang="pt-BR"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>Wi-Fi Drive - Acesso Negado</title>
<style>body{font-family:'Segoe UI',sans-serif;background:#1e1e1e;color:#e0e0e0;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
.box{text-align:center;padding:40px;background:#252526;border-radius:8px;border:1px solid #3e3e42;max-width:400px}
h1{color:#f44336;margin-bottom:12px}p{color:#a0a0a0;font-size:0.95rem}</style></head>
<body><div class="box"><h1>🔒 Acesso Negado</h1><p>Token de acesso inválido ou ausente. Escaneie o QR Code ou use o link correto para acessar.</p></div></body></html>`);
    }
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Static assets (non-HTML) are fine without token
app.use('/assets', express.static(path.join(__dirname, 'public')));
app.get('/qrcode.png', (req, res) => res.sendFile(QR_CODE_PATH));

// Protected download route
app.use('/download', (req, res, next) => {
    const token = req.query.token || req.headers['x-access-token'];
    if (token === ACCESS_TOKEN) return next();
    res.status(403).json({ error: 'Acesso negado.' });
}, express.static(SHARED_DIR));

app.get('/api/files', authRequired, (req, res) => {
    const offset = parseInt(req.query.offset) || 0;
    const limit = parseInt(req.query.limit) || 20;
    const search = (req.query.search || '').toLowerCase();
    const sort = req.query.sort || 'date-desc';

    fs.readdir(SHARED_DIR, (err, files) => {
        if (err) return res.status(500).json({ error: 'Erro ao ler diretório' });

        files = files.filter(f => f !== '.gitkeep');

        let fileDetails = files.map(file => {
            const filePath = path.join(SHARED_DIR, file);
            try {
                const stats = fs.statSync(filePath);
                const dashIndex = file.indexOf('-');
                const displayName = dashIndex > -1 ? file.substring(dashIndex + 1) : file;
                return {
                    filename: file,
                    displayName,
                    size: stats.size,
                    mtime: stats.mtime
                };
            } catch {
                return null;
            }
        }).filter(Boolean);

        // Sort
        switch (sort) {
            case 'date-asc':
                fileDetails.sort((a, b) => a.mtime - b.mtime);
                break;
            case 'name-asc':
                fileDetails.sort((a, b) => a.displayName.localeCompare(b.displayName));
                break;
            case 'name-desc':
                fileDetails.sort((a, b) => b.displayName.localeCompare(a.displayName));
                break;
            case 'size-desc':
                fileDetails.sort((a, b) => b.size - a.size);
                break;
            case 'size-asc':
                fileDetails.sort((a, b) => a.size - b.size);
                break;
            default: // date-desc
                fileDetails.sort((a, b) => b.mtime - a.mtime);
        }

        if (search) {
            fileDetails = fileDetails.filter(f =>
                f.displayName.toLowerCase().includes(search)
            );
        }

        const total = fileDetails.length;
        const paginated = fileDetails.slice(offset, offset + limit).map(f => ({
            filename: f.filename,
            displayName: f.displayName,
            size: f.size,
            createdAt: f.mtime
        }));

        res.json({ files: paginated, total, hasMore: offset + limit < total });
    });
});

// --- Text file viewer ---
const TEXT_MAX_BYTES = 5 * 1024 * 1024; // 5 MB

app.get('/api/text/:filename', authRequired, (req, res) => {
    const filename = path.basename(req.params.filename);
    const filePath = path.join(SHARED_DIR, filename);

    if (!fs.existsSync(filePath)) {
        return res.status(404).json({ error: 'Arquivo não encontrado.' });
    }

    let stats;
    try { stats = fs.statSync(filePath); }
    catch { return res.status(500).json({ error: 'Erro ao acessar arquivo.' }); }

    if (!stats.isFile()) {
        return res.status(400).json({ error: 'Caminho não é um arquivo.' });
    }

    if (stats.size > TEXT_MAX_BYTES) {
        return res.status(413).json({
            error: `Arquivo muito grande para visualizar online (${(stats.size / 1024 / 1024).toFixed(1)} MB). Limite: ${TEXT_MAX_BYTES / 1024 / 1024} MB. Faça download para abrir localmente.`
        });
    }

    fs.readFile(filePath, (err, buf) => {
        if (err) return res.status(500).json({ error: 'Erro ao ler arquivo.' });

        const sniffSize = Math.min(8192, buf.length);
        const sniff = buf.subarray(0, sniffSize);

        const isBomUtf8 = sniff.length >= 3 && sniff[0] === 0xef && sniff[1] === 0xbb && sniff[2] === 0xbf;
        const isBomUtf32Le = sniff.length >= 4 && sniff[0] === 0xff && sniff[1] === 0xfe && sniff[2] === 0x00 && sniff[3] === 0x00;
        const isBomUtf32Be = sniff.length >= 4 && sniff[0] === 0x00 && sniff[1] === 0x00 && sniff[2] === 0xfe && sniff[3] === 0xff;
        const isBomUtf16Le = !isBomUtf32Le && sniff.length >= 2 && sniff[0] === 0xff && sniff[1] === 0xfe;
        const isBomUtf16Be = sniff.length >= 2 && sniff[0] === 0xfe && sniff[1] === 0xff;

        let content;
        let encName;

        if (isBomUtf8) {
            content = buf.subarray(3).toString('utf8');
            encName = 'UTF-8 (BOM)';
        } else if (isBomUtf16Le) {
            content = buf.subarray(2).toString('utf16le');
            encName = 'UTF-16 LE';
        } else if (isBomUtf16Be || isBomUtf32Le || isBomUtf32Be) {
            return res.status(415).json({
                error: 'Codificação não suportada para visualização online (UTF-16 BE / UTF-32). Faça download para abrir localmente.'
            });
        } else {
            // No BOM: scan for null bytes — strong indicator of binary content.
            for (let i = 0; i < sniff.length; i++) {
                if (sniff[i] === 0x00) {
                    return res.status(415).json({
                        error: 'Conteúdo binário detectado — não é possível exibir como texto. Use o download para abrir o arquivo no programa adequado.'
                    });
                }
            }
            content = buf.toString('utf8');
            encName = 'UTF-8';
        }

        res.json({
            content,
            size: stats.size,
            encoding: encName,
            displayName: displayNameOf(filename)
        });
    });
});

// --- Server-Sent Events for realtime sync across devices ---
const sseClients = new Set();
const sseCountByIp = new Map();
const SSE_MAX_PER_IP = 4;

app.get('/api/events', authRequired, (req, res) => {
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    const current = sseCountByIp.get(ip) || 0;
    if (current >= SSE_MAX_PER_IP) {
        res.status(429).end();
        return;
    }
    sseCountByIp.set(ip, current + 1);

    const clientId = String(req.query.clientId || '').slice(0, 64);

    res.set({
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no'
    });
    res.flushHeaders?.();
    res.write(`event: connected\ndata: {"ok":true}\n\n`);

    const client = { res, alive: true, clientId };
    sseClients.add(client);

    const keepAlive = setInterval(() => {
        if (!client.alive) return;
        try { res.write(': ping\n\n'); } catch { cleanup(); }
    }, 25000);

    function cleanup() {
        if (!client.alive) return;
        client.alive = false;
        clearInterval(keepAlive);
        sseClients.delete(client);
        const c = (sseCountByIp.get(ip) || 1) - 1;
        if (c <= 0) sseCountByIp.delete(ip); else sseCountByIp.set(ip, c);
        try { res.end(); } catch {}
    }

    req.on('close', cleanup);
    req.on('error', cleanup);
    res.on('error', cleanup);
});

function displayNameOf(filename) {
    const dashIndex = filename.indexOf('-');
    return dashIndex > -1 ? filename.substring(dashIndex + 1) : filename;
}

function broadcastEvent(type, payload = {}, excludeClientId = null) {
    const data = `event: ${type}\ndata: ${JSON.stringify({ ...payload, ts: Date.now() })}\n\n`;
    for (const client of sseClients) {
        if (!client.alive) continue;
        if (excludeClientId && client.clientId === excludeClientId) continue;
        try { client.res.write(data); } catch {}
    }
}

app.post('/api/upload', authRequired, upload.array('files', 50), (req, res) => {
    if (!req.files || req.files.length === 0) {
        return res.status(400).json({ error: 'Nenhum arquivo enviado' });
    }
    const clientId = String(req.query.clientId || '').slice(0, 64);
    broadcastEvent('files-changed', {
        action: 'upload',
        count: req.files.length,
        files: req.files.map(f => ({
            filename: f.filename,
            displayName: displayNameOf(f.filename)
        }))
    }, clientId);
    res.json({
        message: `${req.files.length} arquivo(s) enviado(s) com sucesso!`,
        count: req.files.length
    });
});

app.use(express.json());

app.post('/api/delete', authRequired, (req, res) => {
    const { files: filenames, clientId } = req.body;
    if (!filenames || !Array.isArray(filenames) || filenames.length === 0) {
        return res.status(400).json({ error: 'Nenhum arquivo especificado' });
    }

    let deleted = 0;
    let errors = [];
    const deletedFiles = [];
    filenames.forEach(filename => {
        const sanitized = path.basename(filename);
        const filePath = path.join(SHARED_DIR, sanitized);
        try {
            if (fs.existsSync(filePath)) {
                fs.unlinkSync(filePath);
                deleted++;
                deletedFiles.push({
                    filename: sanitized,
                    displayName: displayNameOf(sanitized)
                });
            }
        } catch (err) {
            errors.push(sanitized);
        }
    });

    if (deleted > 0) {
        broadcastEvent('files-changed', {
            action: 'delete',
            count: deleted,
            files: deletedFiles
        }, String(clientId || '').slice(0, 64));
    }
    res.json({ deleted, errors });
});

app.post('/api/download-zip', authRequired, (req, res) => {
    const { files: filenames } = req.body;
    if (!filenames || !Array.isArray(filenames) || filenames.length === 0) {
        return res.status(400).json({ error: 'Nenhum arquivo especificado' });
    }

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', 'attachment; filename="wifi-drive-files.zip"');

    const archive = archiver('zip', { zlib: { level: 5 } });
    archive.pipe(res);

    filenames.forEach(filename => {
        const sanitized = path.basename(filename);
        const filePath = path.join(SHARED_DIR, sanitized);
        if (fs.existsSync(filePath)) {
            const dashIndex = sanitized.indexOf('-');
            const displayName = dashIndex > -1 ? sanitized.substring(dashIndex + 1) : sanitized;
            archive.file(filePath, { name: displayName });
        }
    });

    archive.finalize();
});

function getLocalIP() {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name]) {
            if (iface.family === 'IPv4' && !iface.internal) {
                return iface.address;
            }
        }
    }
    return 'localhost';
}

function openBrowser(url) {
    const platform = process.platform;
    let command;
    if (platform === 'win32') {
        command = `start "" "${url}"`;
    } else if (platform === 'darwin') {
        command = `open "${url}"`;
    } else {
        command = `xdg-open "${url}"`;
    }
    exec(command, (err) => {
        if (err) {
            console.log('⚠️  Não foi possível abrir o navegador automaticamente.');
        }
    });
}

const ip = getLocalIP();
const baseUrl = `http://${ip}:${PORT}`;
const authUrl = `${baseUrl}?token=${ACCESS_TOKEN}`;

app.listen(PORT, '0.0.0.0', () => {
    console.log(`\n🚀 Drive Local rodando na rede Wi-Fi!`);
    console.log(`🔗 Acesse no navegador: ${authUrl}`);
    console.log(`🔑 Token de acesso: ${ACCESS_TOKEN}`);
    console.log('\nEscaneie o QR Code abaixo para acessar pelo celular:\n');

    qrcode.toString(authUrl, { type: 'terminal', small: true }, (err, str) => {
        if (!err) console.log(str);
    });

    qrcode.toFile(QR_CODE_PATH, authUrl, { width: 300 }, (err) => {
        if (err) {
            console.log('⚠️  Erro ao gerar QR Code para a interface web:', err.message);
        } else {
            console.log('✅ QR Code atualizado na interface web.');
        }
    });

    openBrowser(authUrl);
});
