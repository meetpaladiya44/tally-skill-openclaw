# Dev & Production Guide: Single OpenClaw + Codex Plus Extractor

One OpenClaw on the **client CPU** (beside Tally) runs `tally-skill`. A hosted **extractor-service** on **your EC2** uses **Codex CLI** with your **ChatGPT Plus** subscription to read PDFs/images. OpenClaw never does local vision/OCR for invoices.

## Architecture

```
User (Telegram/WhatsApp)
        │
        ▼
OpenClaw on client CPU  ── tally-skill ──► TallyPrime (localhost:9000)
        │
        │  POST PDF/image
        ▼
extractor-service on YOUR EC2 (:8080)
        │
        ▼
codex exec --image  (logged in with ChatGPT Plus)
        │
        ▼
structured JSON  ──► back to OpenClaw  ──► Tally voucher
```

| Component | Where | Role |
|-----------|-------|------|
| OpenClaw + `tally-skill` | Client machine | Chat, Tally posting |
| `extractor-service` | Your EC2 | PDF/image → JSON via Plus |
| TallyPrime | Client machine | Accounting (port 9000) |

---

## Section 0: Prerequisites

| # | Item | Notes |
|---|------|-------|
| 0.1 | Ubuntu EC2 (t3.medium+) | For extractor-service + Codex CLI |
| 0.2 | ChatGPT **Plus** (or higher) | Used by `codex login` on EC2 |
| 0.3 | Client Windows/Linux PC | TallyPrime + OpenClaw |
| 0.4 | Telegram bot token | [@BotFather](https://t.me/BotFather) |
| 0.5 | Stable HTTPS URL for extractor | Cloudflare Tunnel recommended (not ephemeral ngrok) |
| 0.6 | Git repo | e.g. `https://github.com/meetpaladiya44/tally-aws-all-config.git` |

---

## Section 1: Deploy extractor-service on EC2

### 1.1 Base install

SSH as `ubuntu`:

```bash
sudo apt update && sudo apt -y upgrade
sudo apt -y install curl git build-essential jq poppler-utils

curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt -y install nodejs
sudo npm i -g pm2 @openai/codex
```

Verify: `pdftoppm -v`, `node -v`, `codex --version`

### 1.2 Log in Codex with Plus (one-time)

```bash
codex login --device-code
```

Follow the URL, sign in with your **ChatGPT Plus** account. Tokens persist in `~/.codex/auth.json`.

Smoke test:

```bash
codex exec --image /path/to/sample.png "What text do you see? Reply briefly."
```

### 1.3 Clone repo and configure extractor

```bash
sudo mkdir -p /opt/tally && sudo chown ubuntu:ubuntu /opt/tally
cd /opt/tally
git clone https://github.com/meetpaladiya44/tally-aws-all-config.git
cd tally-aws-all-config/extractor-service

npm ci
cp .env.example .env
nano .env
```

Fill `.env`:

| Variable | Value |
|----------|-------|
| `PORT` | `8080` |
| `EXTRACTOR_BEARER` | `openssl rand -base64 48` (generate once, save) |
| `CODEX_BIN` | `codex` |
| `CODEX_MODEL` | `gpt-5` (or model your Codex plan supports) |
| `MAX_PAGES` | `10` |

### 1.4 Start with PM2

```bash
pm2 start server.js --name extractor
pm2 save
pm2 startup
# run the sudo command PM2 prints
```

### 1.5 Expose HTTPS (Cloudflare Tunnel example)

```bash
# install cloudflared, then:
cloudflared tunnel create tally-extractor
cloudflared tunnel route dns tally-extractor extractor.yourdomain.com
cloudflared tunnel run --url http://127.0.0.1:8080 tally-extractor
```

Your public URL: `https://extractor.yourdomain.com` → set as `EXTRACTOR_URL` on clients.

### 1.6 Health check

```bash
export EXTRACTOR_BEARER='<paste from .env>'
curl -s -H "Authorization: Bearer $EXTRACTOR_BEARER" http://127.0.0.1:8080/v1/health | jq .
```

Expected: `"status":"ok"`, `"codex_logged_in":true`

### 1.7 Test extraction

```bash
curl -s -X POST http://127.0.0.1:8080/v1/extract \
  -H "Authorization: Bearer $EXTRACTOR_BEARER" \
  -F "file=@/path/to/sample-invoice.pdf" | jq .
```

---

## Section 2: Client CPU — OpenClaw + tally-skill

### 2.1 Install

On the machine beside TallyPrime:

1. Install Node.js 20+, OpenClaw, `tallyca` (`npm i -g tallyca`).
2. Open TallyPrime → F1 → Connectivity → port **9000**, Allow Local TDL **Yes**.
3. Confirm `http://localhost:9000` shows Tally running.

### 2.2 Onboard OpenClaw

```bash
openclaw onboard
```

| Prompt | Answer |
|--------|--------|
| LLM | OpenAI API key **or** Codex Plus (your choice for agent reasoning on client) |
| Skill | `tally-prime-ca` |
| Channel | Telegram (real bot token) |

Install skill from repo:

```bash
openclaw skill add /path/to/tally-skill --as tally-prime-ca
```

### 2.3 Environment variables (client)

Set for the OpenClaw process (PM2 ecosystem or OpenClaw env UI):

| Variable | Example |
|----------|---------|
| `TALLY_URL` | `http://localhost:9000` |
| `EXTRACTOR_URL` | `https://extractor.yourdomain.com` (no trailing slash) |
| `EXTRACTOR_BEARER` | **Same** as EC2 `extractor-service/.env` |

**Do not** expose Tally port 9000 to the internet.

Example PM2 `ecosystem.config.cjs` on client:

```javascript
module.exports = {
  apps: [{
    name: 'openclaw-tally',
    script: 'openclaw',
    args: 'serve --skill tally-prime-ca',
    env: {
      TALLY_URL: 'http://localhost:9000',
      EXTRACTOR_URL: 'https://extractor.yourdomain.com',
      EXTRACTOR_BEARER: '<same as EC2>',
    },
  }],
};
```

---

## Section 3: Dev mode (Tally on laptop, OpenClaw on EC2)

If you test with Tally on your laptop and OpenClaw on EC2:

1. Run `ngrok http 9000` on laptop for **dev only**.
2. Set client `TALLY_URL` to the ngrok URL (temporary).
3. Extractor stays on EC2; `EXTRACTOR_URL` points to your tunnel.

For production, Tally stays `localhost:9000` on the client and only the extractor is remote.

---

## Section 4: End-to-end test

1. EC2: extractor health `codex_logged_in: true`
2. Client: Tally open, OpenClaw running
3. Send a PDF invoice to Telegram bot
4. OpenClaw should call `/v1/extract`, then post to Tally
5. Confirm voucher in TallyPrime

**Logs:**

```bash
# EC2
pm2 logs extractor --lines 100

# Client
pm2 logs openclaw-tally --lines 100
```

---

## Section 5: Command cheat sheet

| Action | Where | Command |
|--------|-------|---------|
| Restart extractor | EC2 | `pm2 restart extractor` |
| Re-login Codex | EC2 | `codex login --device-code` |
| Health | anywhere | `curl -H "Authorization: Bearer $EXTRACTOR_BEARER" $EXTRACTOR_URL/v1/health` |
| Test extract | anywhere | `curl -F file=@inv.pdf -H "Authorization: Bearer ..." $EXTRACTOR_URL/v1/extract` |
| Tally check | client | `curl -s $TALLY_URL` |

---

## Section 6: Troubleshooting

| Symptom | Fix |
|---------|-----|
| `codex_logged_in: false` | Run `codex login --device-code` on EC2 as the same user as PM2 |
| `EXTRACTION_FAILED` + pdftoppm | `sudo apt install poppler-utils` |
| `401` on extract | `EXTRACTOR_BEARER` mismatch between client and EC2 `.env` |
| OpenClaw guesses invoice fields | Skill not using Step 1a — ensure `EXTRACTOR_URL` is set |
| Plus rate limit | Wait or add API-key profile in Codex (`auth.order.openai`) per `tally-skill/devin.md` |

---

## Repo layout (current)

```
extractor-service/     # EC2 — Codex Plus extraction API
tally-skill/           # Client OpenClaw — Tally posting + calls extractor
```

Removed (deprecated): `bridge-service/`, `tally-extractor-skill/`, two-OpenClaw split. See `.cursor/two-openclaw-tally-runbook.md` for history.
