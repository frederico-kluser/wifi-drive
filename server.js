const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const os = require('os');
const qrcode = require('qrcode');
const { exec } = require('child_process');

const app = express();
const PORT = 3000;
const SHARED_DIR = path.join(__dirname, 'shared');
const QR_CODE_PATH = path.join(__dirname, 'public', 'qrcode.png');

if (!fs.existsSync(SHARED_DIR)) {
    fs.mkdirSync(SHARED_DIR);
}

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, SHARED_DIR),
    filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname)
});
const upload = multer({ storage });

app.use(express.static('public'));
app.use('/download', express.static(SHARED_DIR));

app.get('/api/files', (req, res) => {
    const offset = parseInt(req.query.offset) || 0;
    const limit = parseInt(req.query.limit) || 20;
    const search = (req.query.search || '').toLowerCase();

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
                    createdAt: stats.mtimeStamp || stats.mtime.getTime(),
                    mtime: stats.mtime
                };
            } catch {
                return null;
            }
        }).filter(Boolean);

        // Sort newest first
        fileDetails.sort((a, b) => b.mtime - a.mtime);

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

app.post('/api/upload', upload.array('files', 50), (req, res) => {
    if (!req.files || req.files.length === 0) {
        return res.status(400).json({ error: 'Nenhum arquivo enviado' });
    }
    res.json({
        message: `${req.files.length} arquivo(s) enviado(s) com sucesso!`,
        count: req.files.length
    });
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
const url = `http://${ip}:${PORT}`;

app.listen(PORT, '0.0.0.0', () => {
    console.log(`\n🚀 Drive Local rodando na rede Wi-Fi!`);
    console.log(`🔗 Acesse no navegador: ${url}`);
    console.log('\nEscaneie o QR Code abaixo para acessar pelo celular:\n');

    qrcode.toString(url, { type: 'terminal', small: true }, (err, str) => {
        if (!err) console.log(str);
    });

    qrcode.toFile(QR_CODE_PATH, url, { width: 300 }, (err) => {
        if (err) {
            console.log('⚠️  Erro ao gerar QR Code para a interface web:', err.message);
        } else {
            console.log('✅ QR Code atualizado na interface web.');
        }
    });

    openBrowser(url);
});
