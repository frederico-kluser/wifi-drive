# 📶 Wi-Fi Drive

Um "drive local" que roda em Node.js + Express, permitindo compartilhar arquivos entre dispositivos na mesma rede Wi-Fi — com **estrutura de pastas/subpastas** e **streaming de vídeo e áudio** direto no navegador.

## Recursos

- **Pastas e subpastas** — árvore de diretórios reais sob `shared/`, com navegação por breadcrumb clicável, botão "subir" e deep-link (a pasta atual fica na URL; atualizar a página mantém o lugar, e o botão Voltar do navegador sobe um nível).
- **Upload flexível** — enviar arquivos para a pasta atual, **enviar uma pasta inteira do computador** (preservando subpastas) ou **arrastar e soltar** arquivos/pastas. Uploads são enfileirados com limite de concorrência e resolvem colisões de nome automaticamente (`arquivo (1).ext`).
- **Streaming no navegador** — dar play em vídeo e áudio direto, com seek (HTTP Range / `206 Partial Content`) e preview de imagens. Formatos que o navegador não toca (mkv, avi…) oferecem download.
- **Download** — baixar um arquivo, ou baixar uma seleção/pasta inteira como **ZIP** (mantendo a estrutura).
- **Organização** — **mover** e **renomear** itens (com proteção contra mover uma pasta para dentro de si mesma) e **excluir** (recursivo para pastas).
- **Visualizador de texto** embutido, com busca, números de linha e quebra de linha.
- **Sincronização em tempo real** entre dispositivos via Server-Sent Events, com notificações (toasts) e destaque dos itens recém-chegados.
- Multi-seleção, ordenação, busca, interface responsiva em tema escuro.
- **Acesso por token** na URL e **QR Code** (no terminal e na interface) para conectar o celular rapidamente.

## Stack

- **Node.js** + **Express 5** — servidor web e API
- **Multer** — upload de arquivos (storage engine customizada com criação atômica `O_EXCL`)
- **archiver** — geração de ZIP de arquivos e pastas
- **qrcode** — geração do QR Code

## Instalação

```bash
npm install
```

## Como usar

```bash
npm start      # libera a porta 3000 e sobe o servidor
# ou
node server.js
```

O terminal exibirá:
- O IP da máquina na rede local e o link com token (ex: `http://192.168.0.10:3000?token=abc123…`)
- O token de acesso
- Um QR Code para escanear direto pelo celular

Qualquer dispositivo na mesma rede Wi-Fi pode abrir a interface (com o token), criar pastas, enviar e organizar arquivos, dar play em mídia e baixar o que estiver disponível. **O token é derivado do horário de inicialização e muda a cada reinício do servidor.**

## Estrutura

```text
wifi-drive/
├── public/
│   └── index.html      # Interface web (SPA single-file, dark mode)
├── shared/             # Raiz do drive — pastas e arquivos reais
├── server.js           # Servidor Express + API
├── package.json
└── README.md
```

## Autenticação

Todas as rotas exigem o token, exceto os assets estáticos e o QR Code. Envie-o de uma destas formas:

- Query string: `?token=SEU_TOKEN`
- Header: `x-access-token: SEU_TOKEN`

Os caminhos enviados pelo cliente passam por validação que impede acesso fora de `shared/` (path traversal).

## Endpoints

Caminhos (`path`/`paths`) são **relativos à raiz** de `shared/` (ex.: `Documentos/Fotos/foto.jpg`). Pasta raiz = string vazia.

### Páginas e estáticos
- `GET /` — interface web (exige token)
- `GET /qrcode.png` — imagem do QR Code

### Listagem e leitura
- `GET /api/files?path=&offset=&limit=&search=&sort=&foldersOnly=` — lista uma pasta (subpastas primeiro, depois arquivos). Retorna `{ path, breadcrumb, entries[], total, hasMore }`, onde cada entrada tem `{ type: 'folder'|'file', name, path, kind, size, mtime }`. `sort`: `date-desc` (padrão), `date-asc`, `name-asc`, `name-desc`, `size-desc`, `size-asc`. `foldersOnly=1` retorna só pastas (usado pelo seletor de "Mover").
- `GET /api/text?path=` — conteúdo de um arquivo de texto (até 5 MB) para o visualizador embutido, com detecção de BOM/encoding e bloqueio de binários.
- `GET /api/events` — stream de **Server-Sent Events** para sincronização em tempo real.

### Streaming e download
- `GET /media/<path>?token=` — serve o arquivo **inline** com suporte a HTTP Range (vídeo/áudio com seek, imagens). Usado pelo player do navegador.
- `GET /download/<path>?token=` — baixa o arquivo (`Content-Disposition: attachment`).
- `POST /api/download-zip` — corpo `{ paths: [] }`. Baixa os itens (arquivos e/ou pastas) como um único ZIP, preservando a estrutura das pastas.

### Escrita / organização
- `POST /api/upload?path=&relPath=&clientId=` — upload `multipart/form-data` (campo `files`, até 50 por requisição). `path` = pasta de destino; `relPath` (opcional) recria subpastas dentro do destino (usado no envio de pasta inteira).
- `POST /api/folder` — corpo `{ path, name }`. Cria uma pasta (`409` se já existir).
- `POST /api/rename` — corpo `{ path, newName }`. Renomeia um item (`409` em colisão).
- `POST /api/move` — corpo `{ paths: [], dest }`. Move itens para a pasta `dest` (resolve colisões; recusa mover uma pasta para dentro dela mesma).
- `POST /api/delete` — corpo `{ paths: [] }`. Exclui itens (recursivo para pastas).

> As rotas de escrita aceitam um `clientId` (query ou corpo) para que o servidor não reenvie o evento de sync de volta ao próprio dispositivo que originou a ação.
