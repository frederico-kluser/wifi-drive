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
    fs.readdir(SHARED_DIR, (err, files) => {
        if (err) return res.status(500).json({ error: 'Erro ao ler diretório' });
        res.json(files);
    });
});

app.post('/api/upload', upload.single('file'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'Nenhum arquivo enviado' });
    res.json({ message: 'Upload concluído com sucesso!' });
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
