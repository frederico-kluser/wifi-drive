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

app.post('/api/upload', authRequired, upload.array('files', 50), (req, res) => {
    if (!req.files || req.files.length === 0) {
        return res.status(400).json({ error: 'Nenhum arquivo enviado' });
    }
    res.json({
        message: `${req.files.length} arquivo(s) enviado(s) com sucesso!`,
        count: req.files.length
    });
});

app.use(express.json());

app.post('/api/delete', authRequired, (req, res) => {
    const { files: filenames } = req.body;
    if (!filenames || !Array.isArray(filenames) || filenames.length === 0) {
        return res.status(400).json({ error: 'Nenhum arquivo especificado' });
    }

    let deleted = 0;
    let errors = [];
    filenames.forEach(filename => {
        const sanitized = path.basename(filename);
        const filePath = path.join(SHARED_DIR, sanitized);
        try {
            if (fs.existsSync(filePath)) {
                fs.unlinkSync(filePath);
                deleted++;
            }
        } catch (err) {
            errors.push(sanitized);
        }
    });

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
