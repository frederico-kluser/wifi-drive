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
const SHARED_DIR = path.resolve(__dirname, 'shared'); // canonical absolute base
const QR_CODE_PATH = path.join(__dirname, 'public', 'qrcode.png');

// Generate access token from startup timestamp
const STARTUP_TIMESTAMP = Date.now().toString();
const ACCESS_TOKEN = crypto.createHash('sha256').update(STARTUP_TIMESTAMP).digest('hex').substring(0, 16);

if (!fs.existsSync(SHARED_DIR)) {
    fs.mkdirSync(SHARED_DIR, { recursive: true });
}

// ---------------------------------------------------------------------------
// Path security — the single chokepoint every client-supplied path flows through
// ---------------------------------------------------------------------------

// Resolve a client relative path against SHARED_DIR; return absolute path or null
// if it would escape the tree (path traversal). Lexical only (no FS calls).
function resolveSafe(relPath) {
    if (relPath == null) relPath = '';
    if (typeof relPath !== 'string') return null;
    let rel = relPath.replace(/\\/g, '/');
    if (rel.startsWith('/')) rel = rel.slice(1);
    if (rel.indexOf('\0') !== -1) return null;
    const abs = path.resolve(SHARED_DIR, rel); // collapses '.', '..', '//'
    if (abs === SHARED_DIR) return abs;
    if (abs.startsWith(SHARED_DIR + path.sep)) return abs;
    return null;
}

// Validate a single path segment (new folder name / rename target).
function safeName(name) {
    if (typeof name !== 'string') return false;
    name = name.trim();
    if (!name || name.length > 255) return false;
    if (name === '.' || name === '..') return false;
    if (/[\\/]/.test(name) || name.indexOf('\0') !== -1) return false;
    if (/[\x00-\x1f<>:"|?*]/.test(name)) return false; // control + Windows-illegal
    if (/[ .]$/.test(name)) return false; // trailing dot/space
    return true;
}

// Relative (posix-style) path of an absolute path, from the shared root.
function relOf(abs) {
    return path.relative(SHARED_DIR, abs).split(path.sep).join('/');
}

// True if `child` is the same as, or nested inside, `ancestor` (both absolute).
function isInside(ancestor, child) {
    if (child === ancestor) return true;
    return child.startsWith(ancestor + path.sep);
}

// Decode each segment of an Express mount-relative req.path. Throws URIError on
// malformed escapes (caller turns that into a 400).
function decodeReqPath(reqPath) {
    return reqPath.replace(/^\/+/, '').split('/').map(decodeURIComponent).join('/');
}

// Find a non-colliding name within `dir` by appending " (n)" before the extension.
function nextName(name, attempt) {
    if (attempt === 0) return name;
    const ext = path.extname(name);
    const stem = name.slice(0, name.length - ext.length);
    return `${stem} (${attempt})${ext}`;
}
function nonCollidingName(dir, name) {
    let attempt = 0;
    let candidate = name;
    while (fs.existsSync(path.join(dir, candidate))) {
        attempt++;
        candidate = nextName(name, attempt);
    }
    return candidate;
}

// ---------------------------------------------------------------------------
// File kind detection (advisory hint for the UI: media vs text vs other)
// ---------------------------------------------------------------------------
const KIND_BY_EXT = {
    // video
    '.mp4': 'video', '.m4v': 'video', '.webm': 'video', '.ogv': 'video',
    '.mkv': 'video', '.avi': 'video', '.mov': 'video', '.flv': 'video',
    '.wmv': 'video', '.mpeg': 'video', '.mpg': 'video', '.3gp': 'video', '.m2ts': 'video',
    // audio
    '.mp3': 'audio', '.m4a': 'audio', '.aac': 'audio', '.wav': 'audio',
    '.ogg': 'audio', '.oga': 'audio', '.opus': 'audio', '.flac': 'audio',
    '.weba': 'audio', '.wma': 'audio', '.aiff': 'audio',
    // image
    '.jpg': 'image', '.jpeg': 'image', '.png': 'image', '.gif': 'image',
    '.webp': 'image', '.bmp': 'image', '.svg': 'image', '.avif': 'image', '.ico': 'image',
    // text (note: '.ts' is intentionally TypeScript=text, not MPEG-TS=video)
    '.txt': 'text', '.md': 'text', '.markdown': 'text', '.json': 'text', '.xml': 'text',
    '.csv': 'text', '.log': 'text', '.js': 'text', '.ts': 'text', '.css': 'text',
    '.html': 'text', '.htm': 'text', '.yml': 'text', '.yaml': 'text', '.ini': 'text',
    '.sh': 'text', '.py': 'text', '.c': 'text', '.cpp': 'text', '.java': 'text', '.sql': 'text'
};
function kindOf(filename) {
    return KIND_BY_EXT[path.extname(filename).toLowerCase()] || 'other';
}

const HIDDEN_NAMES = new Set(['.gitkeep']);
function isHidden(name) {
    return HIDDEN_NAMES.has(name) || name.startsWith('.');
}

function buildBreadcrumb(relPath) {
    const crumbs = [{ name: 'Compartilhados', path: '' }];
    const rel = (relPath || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    if (!rel) return crumbs;
    let acc = '';
    for (const p of rel.split('/')) {
        acc = acc ? acc + '/' + p : p;
        crumbs.push({ name: p, path: acc });
    }
    return crumbs;
}

// ---------------------------------------------------------------------------
// Upload storage engine: nested destination + atomic collision-free naming
// ---------------------------------------------------------------------------
// O_EXCL ('wx') makes "pick a free name and create it" atomic, so concurrent
// same-name uploads can't clobber each other (the loser retries with " (n)").
const folderStorage = {
    _handleFile(req, file, cb) {
        const dest = String(req.query.path || '');
        const sub = String(req.query.relPath || '');
        const combined = [dest, sub].filter(Boolean).join('/');
        const dir = resolveSafe(combined);
        if (!dir) return cb(new Error('UNSAFE_DEST'));

        fs.mkdir(dir, { recursive: true }, (mkErr) => {
            if (mkErr) return cb(mkErr);

            let original = path.basename(file.originalname || 'arquivo');
            if (!safeName(original)) {
                original = original.replace(/[\x00-\x1f<>:"|?*\\/]/g, '_').replace(/[ .]+$/, '') || 'arquivo';
            }

            (function tryOpen(attempt) {
                if (attempt > 10000) return cb(new Error('TOO_MANY_COLLISIONS'));
                const finalName = nextName(original, attempt);
                const finalPath = path.join(dir, finalName);
                fs.open(finalPath, 'wx', (err, fd) => {
                    if (err) {
                        if (err.code === 'EEXIST') return tryOpen(attempt + 1);
                        return cb(err);
                    }
                    const ws = fs.createWriteStream(null, { fd });
                    file.stream.on('error', (e) => { ws.destroy(); cb(e); });
                    ws.on('error', (e) => cb(e));
                    ws.on('finish', () => cb(null, {
                        destination: dir,
                        filename: finalName,
                        path: finalPath,
                        size: ws.bytesWritten
                    }));
                    file.stream.pipe(ws);
                });
            })(0);
        });
    },
    _removeFile(req, file, cb) {
        fs.unlink(file.path, cb);
    }
};
const upload = multer({ storage: folderStorage, limits: { files: 50 } });

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------
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

// --- Inline media streaming (Range-capable via `send`) for <video>/<audio>/<img> ---
app.use('/media', authRequired, (req, res) => {
    let rel;
    try { rel = decodeReqPath(req.path); }
    catch { return res.status(400).json({ error: 'Caminho inválido.' }); }

    const abs = resolveSafe(rel);
    if (!abs) return res.status(400).json({ error: 'Caminho inválido.' });

    fs.stat(abs, (err, st) => {
        if (err || !st.isFile()) return res.status(404).json({ error: 'Arquivo não encontrado.' });
        res.sendFile(abs, {
            headers: {
                'Content-Disposition': `inline; filename*=UTF-8''${encodeRFC5987(path.basename(abs))}`
            },
            acceptRanges: true,
            cacheControl: true,
            maxAge: 0
        }, (sendErr) => {
            if (sendErr && !res.headersSent) res.status(sendErr.status || 500).end();
        });
    });
});

// --- Forced download (attachment) for nested files ---
app.use('/download', authRequired, (req, res) => {
    let rel;
    try { rel = decodeReqPath(req.path); }
    catch { return res.status(400).json({ error: 'Caminho inválido.' }); }

    const abs = resolveSafe(rel);
    if (!abs) return res.status(400).json({ error: 'Caminho inválido.' });

    fs.stat(abs, (err, st) => {
        if (err) return res.status(404).json({ error: 'Não encontrado.' });
        if (st.isDirectory()) return res.status(400).json({ error: 'Use download-zip para pastas.' });
        res.download(abs, path.basename(abs), (dlErr) => {
            if (dlErr && !res.headersSent) res.status(dlErr.status || 500).end();
        });
    });
});

function encodeRFC5987(str) {
    return encodeURIComponent(str).replace(/['()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

// --- List a folder ---
app.get('/api/files', authRequired, (req, res) => {
    const relPath = req.query.path || '';
    const dir = resolveSafe(relPath);
    if (!dir) return res.status(400).json({ error: 'Caminho inválido.' });

    fs.stat(dir, (err, dstat) => {
        if (err || !dstat.isDirectory()) {
            return res.status(404).json({ error: 'Pasta não encontrada.' });
        }

        const offset = parseInt(req.query.offset) || 0;
        const limit = parseInt(req.query.limit) || 20;
        const search = (req.query.search || '').toLowerCase();
        const sort = req.query.sort || 'date-desc';
        const foldersOnly = req.query.foldersOnly === '1';

        fs.readdir(dir, { withFileTypes: true }, (rdErr, dirents) => {
            if (rdErr) return res.status(500).json({ error: 'Erro ao ler diretório' });

            const normRel = relPath.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
            let entries = [];

            for (const d of dirents) {
                if (isHidden(d.name)) continue;

                let type, isDir;
                if (d.isDirectory()) { type = 'folder'; isDir = true; }
                else if (d.isFile()) { type = 'file'; isDir = false; }
                else if (d.isSymbolicLink()) {
                    try {
                        const st = fs.statSync(path.join(dir, d.name));
                        isDir = st.isDirectory();
                        type = isDir ? 'folder' : 'file';
                    } catch { continue; }
                } else continue;

                if (foldersOnly && !isDir) continue;

                let size = 0, mtime = new Date(0);
                try {
                    const st = fs.statSync(path.join(dir, d.name));
                    size = st.size; mtime = st.mtime;
                } catch { continue; }

                entries.push({
                    name: d.name,
                    path: normRel ? `${normRel}/${d.name}` : d.name,
                    type,
                    kind: isDir ? null : kindOf(d.name),
                    size: isDir ? 0 : size,
                    mtime
                });
            }

            if (search) entries = entries.filter(e => e.name.toLowerCase().includes(search));

            const cmp = sortComparator(sort);
            entries.sort((a, b) => {
                if (a.type !== b.type) return a.type === 'folder' ? -1 : 1; // folders first
                return cmp(a, b);
            });

            const total = entries.length;
            const page = entries.slice(offset, offset + limit).map(e => ({
                name: e.name,
                path: e.path,
                type: e.type,
                kind: e.kind,
                size: e.size,
                mtime: e.mtime
            }));

            res.json({
                path: normRel,
                breadcrumb: buildBreadcrumb(normRel),
                entries: page,
                total,
                hasMore: offset + limit < total
            });
        });
    });
});

function sortComparator(sort) {
    switch (sort) {
        case 'date-asc': return (a, b) => a.mtime - b.mtime;
        case 'name-asc': return (a, b) => a.name.localeCompare(b.name);
        case 'name-desc': return (a, b) => b.name.localeCompare(a.name);
        case 'size-desc': return (a, b) => b.size - a.size;
        case 'size-asc': return (a, b) => a.size - b.size;
        case 'date-desc':
        default: return (a, b) => b.mtime - a.mtime;
    }
}

// --- Text file viewer ---
const TEXT_MAX_BYTES = 5 * 1024 * 1024; // 5 MB

app.get('/api/text', authRequired, (req, res) => {
    const abs = resolveSafe(req.query.path || '');
    if (!abs || abs === SHARED_DIR) return res.status(400).json({ error: 'Caminho inválido.' });

    let stats;
    try { stats = fs.statSync(abs); }
    catch { return res.status(404).json({ error: 'Arquivo não encontrado.' }); }

    if (!stats.isFile()) {
        return res.status(400).json({ error: 'Caminho não é um arquivo.' });
    }

    if (stats.size > TEXT_MAX_BYTES) {
        return res.status(413).json({
            error: `Arquivo muito grande para visualizar online (${(stats.size / 1024 / 1024).toFixed(1)} MB). Limite: ${TEXT_MAX_BYTES / 1024 / 1024} MB. Faça download para abrir localmente.`
        });
    }

    fs.readFile(abs, (err, buf) => {
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
            displayName: path.basename(abs)
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

function broadcastEvent(type, payload = {}, excludeClientId = null) {
    const data = `event: ${type}\ndata: ${JSON.stringify({ ...payload, ts: Date.now() })}\n\n`;
    for (const client of sseClients) {
        if (!client.alive) continue;
        if (excludeClientId && client.clientId === excludeClientId) continue;
        try { client.res.write(data); } catch {}
    }
}

// --- Upload (into ?path=, optional ?relPath= for folder structure) ---
app.post('/api/upload', authRequired, (req, res) => {
    upload.array('files', 50)(req, res, (err) => {
        if (err) {
            if (err.message === 'UNSAFE_DEST') return res.status(400).json({ error: 'Destino inválido.' });
            if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'Arquivo excede o limite.' });
            return res.status(500).json({ error: 'Falha no upload.' });
        }
        if (!req.files || req.files.length === 0) {
            return res.status(400).json({ error: 'Nenhum arquivo enviado' });
        }

        const dest = String(req.query.path || '').replace(/^\/+|\/+$/g, '');
        const clientId = String(req.query.clientId || '').slice(0, 64);

        const saved = req.files.map(f => ({
            name: f.filename,
            path: relOf(f.path),
            size: f.size,
            kind: kindOf(f.filename)
        }));

        broadcastEvent('files-changed', {
            action: 'upload',
            count: req.files.length,
            path: dest,
            files: saved
        }, clientId);

        res.json({
            message: `${req.files.length} arquivo(s) enviado(s) com sucesso!`,
            count: req.files.length,
            files: saved
        });
    });
});

app.use(express.json());

// --- Create folder ---
app.post('/api/folder', authRequired, (req, res) => {
    const { path: relPath, name, clientId } = req.body;
    if (!safeName(name)) return res.status(400).json({ error: 'Nome de pasta inválido.' });

    const parent = resolveSafe(relPath || '');
    if (!parent) return res.status(400).json({ error: 'Caminho inválido.' });

    const target = path.join(parent, name);
    fs.mkdir(target, { recursive: false }, (err) => {
        if (err) {
            if (err.code === 'EEXIST') return res.status(409).json({ error: 'Já existe um item com esse nome.' });
            return res.status(500).json({ error: 'Erro ao criar pasta.' });
        }
        broadcastEvent('files-changed', {
            action: 'mkdir',
            path: relOf(parent),
            name,
            itemPath: relOf(target)
        }, String(clientId || '').slice(0, 64));
        res.json({ ok: true, path: relOf(target) });
    });
});

// --- Delete (recursive for folders) ---
app.post('/api/delete', authRequired, (req, res) => {
    const { paths, clientId } = req.body;
    if (!Array.isArray(paths) || paths.length === 0) {
        return res.status(400).json({ error: 'Nenhum item especificado' });
    }

    let deleted = 0;
    const errors = [];
    const deletedItems = [];

    for (const rel of paths) {
        const abs = resolveSafe(rel);
        if (!abs || abs === SHARED_DIR) { errors.push(rel); continue; }
        try {
            const st = fs.statSync(abs);
            fs.rmSync(abs, { recursive: true, force: true });
            deleted++;
            deletedItems.push({
                path: relOf(abs),
                type: st.isDirectory() ? 'folder' : 'file',
                name: path.basename(abs)
            });
        } catch {
            errors.push(rel);
        }
    }

    if (deleted > 0) {
        broadcastEvent('files-changed', {
            action: 'delete',
            count: deleted,
            items: deletedItems
        }, String(clientId || '').slice(0, 64));
    }
    res.json({ deleted, errors });
});

// --- Move items into a destination folder ---
app.post('/api/move', authRequired, (req, res) => {
    const { paths, dest, clientId } = req.body;
    if (!Array.isArray(paths) || paths.length === 0) {
        return res.status(400).json({ error: 'Nenhum item especificado' });
    }
    const destDir = resolveSafe(dest || '');
    if (!destDir) return res.status(400).json({ error: 'Destino inválido.' });

    let dstat;
    try { dstat = fs.statSync(destDir); }
    catch { return res.status(404).json({ error: 'Destino não encontrado.' }); }
    if (!dstat.isDirectory()) return res.status(400).json({ error: 'Destino não é uma pasta.' });

    let moved = 0;
    const errors = [];
    const movedItems = [];

    for (const rel of paths) {
        const src = resolveSafe(rel);
        if (!src || src === SHARED_DIR) { errors.push(rel); continue; }

        let sstat;
        try { sstat = fs.statSync(src); }
        catch { errors.push(rel); continue; }

        // Can't move a folder into itself or its own subtree.
        if (sstat.isDirectory() && isInside(src, destDir)) { errors.push(rel); continue; }
        // No-op if already in the destination.
        if (path.dirname(src) === destDir) { continue; }

        const finalPath = path.join(destDir, nonCollidingName(destDir, path.basename(src)));
        try {
            fs.renameSync(src, finalPath);
            moved++;
            movedItems.push({ from: relOf(src), to: relOf(finalPath), fromParent: relOf(path.dirname(src)) });
        } catch {
            errors.push(rel);
        }
    }

    if (moved > 0) {
        broadcastEvent('files-changed', {
            action: 'move',
            count: moved,
            destPath: relOf(destDir),
            items: movedItems
        }, String(clientId || '').slice(0, 64));
    }
    res.json({ moved, errors });
});

// --- Rename a single item ---
app.post('/api/rename', authRequired, (req, res) => {
    const { path: rel, newName, clientId } = req.body;
    if (!safeName(newName)) return res.status(400).json({ error: 'Nome inválido.' });

    const src = resolveSafe(rel);
    if (!src || src === SHARED_DIR) return res.status(400).json({ error: 'Item inválido.' });

    const dir = path.dirname(src);
    const target = path.join(dir, newName);
    if (target === src) return res.json({ ok: true, path: relOf(src) });
    if (fs.existsSync(target)) return res.status(409).json({ error: 'Já existe um item com esse nome.' });

    fs.rename(src, target, (err) => {
        if (err) return res.status(500).json({ error: 'Falha ao renomear.' });
        broadcastEvent('files-changed', {
            action: 'rename',
            from: relOf(src),
            to: relOf(target),
            parent: relOf(dir)
        }, String(clientId || '').slice(0, 64));
        res.json({ ok: true, path: relOf(target) });
    });
});

// --- Download multiple items (files and/or folders) as a ZIP ---
app.post('/api/download-zip', authRequired, (req, res) => {
    const { paths } = req.body;
    if (!Array.isArray(paths) || paths.length === 0) {
        return res.status(400).json({ error: 'Nenhum item especificado' });
    }

    const items = [];
    for (const rel of paths) {
        const abs = resolveSafe(rel);
        if (!abs || abs === SHARED_DIR) continue;
        let st;
        try { st = fs.statSync(abs); } catch { continue; }
        items.push({ abs, name: path.basename(abs), isDir: st.isDirectory() });
    }
    if (items.length === 0) return res.status(404).json({ error: 'Nada para baixar.' });

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', 'attachment; filename="wifi-drive.zip"');

    const archive = archiver('zip', { zlib: { level: 5 } });
    archive.on('warning', (e) => { if (e.code !== 'ENOENT') console.warn('zip warn:', e.message); });
    archive.on('error', () => { if (!res.headersSent) res.status(500); try { res.end(); } catch {} });
    archive.pipe(res);

    for (const it of items) {
        if (it.isDir) archive.directory(it.abs, it.name);
        else archive.file(it.abs, { name: it.name });
    }
    archive.finalize();
});

// ---------------------------------------------------------------------------
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
