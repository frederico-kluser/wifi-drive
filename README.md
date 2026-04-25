# 📶 Wi-Fi Drive

Um "drive local" simples que roda em Node.js + Express, permitindo compartilhar arquivos entre dispositivos conectados na mesma rede Wi-Fi.

## Recursos

- Upload de arquivos via interface web
- Listagem e download dos arquivos compartilhados
- Interface responsiva com tema escuro
- QR Code gerado no terminal para acesso rápido pelo celular
- Sem rota de deleção (apenas adicionar e baixar)

## Stack

- **Node.js** + **Express** — servidor web e API
- **Multer** — upload de arquivos
- **qrcode** — geração do QR Code no terminal

## Instalação

```bash
npm install
```

## Como usar

```bash
node server.js
```

O terminal exibirá:
- O IP da máquina na rede local (ex: `http://192.168.0.10:3000`)
- Um QR Code para escaneio direto pelo celular

Qualquer dispositivo conectado à mesma rede Wi-Fi pode acessar a interface, fazer upload de arquivos e baixar os que já estão disponíveis.

## Estrutura

```text
wifi-drive/
├── public/
│   └── index.html      # Interface web (dark mode)
├── shared/             # Pasta dos arquivos compartilhados
├── server.js           # Servidor Express + API
├── package.json
└── README.md
```

## Endpoints

- `GET /` — interface web
- `GET /api/files` — lista os arquivos da pasta `shared/`
- `POST /api/upload` — faz upload de um arquivo (campo `file`)
- `GET /download/:filename` — baixa o arquivo informado
