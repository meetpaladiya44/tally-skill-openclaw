# Complete Setup Guide: AWS + GitHub + Codex Plus Extractor

One OpenClaw on the **client CPU** (beside Tally) runs `tally-skill`. A hosted **extractor-service** on **your EC2** uses **Codex CLI** with your **ChatGPT Plus** subscription to read PDFs/images.

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

---

## Part A — On your Windows PC (before AWS)

### Step A1 — Gather accounts and keys

| Item | Where to get it |
|------|-----------------|
| AWS account | https://aws.amazon.com |
| GitHub account | https://github.com |
| ChatGPT **Plus** subscription | https://chat.openai.com (needed for `codex login` on EC2) |
| Telegram bot token | Telegram → [@BotFather](https://t.me/BotFather) → `/newbot` |
| A sample invoice | Any PDF or PNG/JPEG invoice on your PC (for testing) |

---

### Step A2 — Create GitHub repository and push code

Do this on your Windows machine where the project folder lives (e.g. `D:\tally-skill-openclaw-main`).

**A2.1 — Create empty repo on GitHub**

1. Open https://github.com/new
2. Repository name: `tally-aws-all-config` (or any name you prefer)
3. Visibility: **Private** (recommended)
4. Do **not** check "Add a README"
5. Click **Create repository**
6. Copy the repo URL, e.g. `https://github.com/meetpaladiya44/tally-aws-all-config.git`

**A2.2 — Initialize git and push (PowerShell)**

```powershell
cd D:\tally-skill-openclaw-main

# Create .gitignore if missing (do not commit secrets or node_modules)
@"
extractor-service/node_modules/
extractor-service/uploads/
extractor-service/data/
extractor-service/.env
.env
*.env.local
.DS_Store
"@ | Out-File -Encoding utf8 .gitignore

git init
git add .gitignore extractor-service tally-skill
# ensure template is included (not ignored):
git add -f extractor-service/.env.example
git commit -m "Add extractor-service and tally-skill"

git remote add origin https://github.com/meetpaladiya44/tally-aws-all-config.git
git branch -M main
git push -u origin main
```

If GitHub asks for login, use a **Personal Access Token** (Settings → Developer settings → Tokens) as the password.

**What gets pushed:**

```
extractor-service/    # Node API on EC2
tally-skill/          # OpenClaw skill on client
dev-testing.md        # this guide
```

---

## Part B — Create AWS EC2 instance

### Step B1 — Create key pair (.pem)

1. AWS Console → **EC2** → left menu **Key Pairs** → **Create key pair**
2. Name: `tally-dev-key`
3. Type: **RSA**
4. Format: **.pem** (for SSH from Windows)
5. Click **Create** — the `.pem` file downloads. Store it safely, e.g. `C:\Users\meetp\Downloads\tally-dev-key.pem`

**Fix permissions on Windows (required for SSH):**

```powershell
icacls "C:\Users\meetp\Downloads\tally-dev-key.pem" /inheritance:r
icacls "C:\Users\meetp\Downloads\tally-dev-key.pem" /grant:r "$($env:USERNAME):R"
```

---

### Step B2 — Launch EC2 instance

1. AWS Console → **EC2** → **Launch instance**
2. Fill in:

| Field | Value |
|-------|-------|
| Name | `tally-extractor-dev` |
| AMI | **Ubuntu Server 22.04 LTS** (64-bit x86) |
| Instance type | **t3.medium** (2 vCPU, 4 GB RAM) |
| Key pair | `tally-dev-key` (from B1) |
| Network | Default VPC is fine |
| Storage | 20 GB gp3 |

3. **Security group** — Create new:

| Type | Port | Source | Purpose |
|------|------|--------|---------|
| SSH | 22 | **My IP** | You SSH in |
| Custom TCP | 8080 | **My IP** (optional) | Test extractor from your PC without tunnel |

Do **not** open port 8080 to `0.0.0.0/0` unless you add bearer auth (you do) and understand the risk. For production use Cloudflare Tunnel instead.

4. Click **Launch instance**
5. Wait until **Instance state** = **Running**
6. Copy **Public IPv4 address**, e.g. `3.110.xx.xx`

---

### Step B3 — SSH into EC2

From PowerShell on your PC:

```powershell
ssh -i "C:\Users\meetp\Downloads\tally-dev-key.pem" ubuntu@3.110.xx.xx
```

Replace the IP with your instance IP. You should see a prompt like `ubuntu@ip-172-31-xx-xx:~$`.

All following **Part C** commands run on the EC2 unless stated otherwise.

---

## Part C — EC2 base software

### Step C1 — Update system and install packages

```bash
sudo apt update && sudo apt -y upgrade
sudo apt -y install curl git build-essential jq poppler-utils
```

`poppler-utils` provides `pdftoppm` — required to convert PDF pages to PNG before Codex can read them.

Verify:

```bash
pdftoppm -v
# should print version info, not "command not found"
```

---

### Step C2 — Install Node.js 20

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt -y install nodejs

node -v    # v20.x.x
npm -v
```

---

### Step C3 — Install PM2 and Codex CLI globally

```bash
sudo npm i -g pm2 @openai/codex

pm2 -v
codex --version
```

---

## Part D — Log in Codex with ChatGPT Plus (one-time)

### Step D1 — Device login on EC2

EC2 has no browser, so use device code flow:

```bash
codex login --device-code
```

1. The terminal prints a **URL** and a **code**
2. On your **PC browser**, open that URL (often `https://auth.openai.com/...` or similar)
3. Sign in with the **same account that has ChatGPT Plus**
4. Enter the code when prompted
5. Back on EC2 you should see success

Auth is saved at:

```bash
ls -la ~/.codex/
# look for auth.json or similar
```

**Important:** Run `codex login` as the **same Linux user** that will run PM2 (`ubuntu`). If you later run PM2 as another user, that user must log in separately.

---

## Part E — Put test images/PDFs on EC2 (for `codex exec --image`)

Codex CLI does **not** read PDF directly. It accepts **PNG, JPEG, WebP, GIF** via `--image`. Our `extractor-service` converts PDF → PNG automatically; for manual `codex exec` tests you need image files on the server.

**Test files used in this guide** (adjust names if yours differ):

| File | Typical path on EC2 |
|------|---------------------|
| Original PDF | `~/Invoice No.8933183031.PDF` |
| Converted pages | `~/samples/invoice-page-1.png`, `~/samples/invoice-page-2.png` |

All later curl and Codex commands below use these paths.

### Method 1 — Copy from your Windows PC with SCP (recommended)

On your **Windows PC** (new PowerShell window, not inside SSH):

```powershell
# Copy your invoice PDF (example filename from Part E)
scp -i "C:\Users\meetp\Downloads\tally-dev-key.pem" `
  "D:\path\to\Invoice No.8933183031.PDF" `
  ubuntu@3.110.xx.xx:/home/ubuntu/

# Optional: copy into samples folder instead
scp -i "C:\Users\meetp\Downloads\tally-dev-key.pem" `
  "D:\path\to\Invoice No.8933183031.PDF" `
  ubuntu@3.110.xx.xx:/home/ubuntu/samples/
```

Create the folder on EC2 first if needed:

```bash
mkdir -p ~/samples
```

---

### Method 2 — Create a simple test PNG on EC2 (no file from PC)

If you only want to verify Codex vision works:

```bash
sudo apt -y install imagemagick
convert -size 400x200 xc:white -pointsize 24 -draw "text 20,100 'Invoice 186 Total 46199'" ~/samples/test-invoice.png
ls -la ~/samples/
```

---

### Method 3 — Convert PDF to PNG on EC2 (manual, same as extractor-service)

If your PDF is in home (e.g. `Invoice No.8933183031.PDF`):

```bash
mkdir -p ~/samples
pdftoppm -png ~/'Invoice No.8933183031.PDF' ~/samples/invoice-page
ls ~/samples/
# invoice-page-1.png, invoice-page-2.png, ...  (NOT a folder named "png")
```

`pdftoppm` writes **files** with suffix `-1.png`, `-2.png`. It does **not** create a directory called `png`.

---

### Step E2 — Smoke test Codex with an image

You do **not** need Part F (extractor-service) to pass this step. Part E only proves: Codex login works + vision reads your invoice PNG. Continue to Part F after this succeeds.

**Two CLI rules:**

1. With `--image`, put **`--`** before the prompt (otherwise: `No prompt provided`).
2. From `~/samples` (not a git repo), add **`--skip-git-repo-check`** (otherwise: `Not inside a trusted directory`).

**Run this from anywhere (recommended for Part E):**

```bash
codex exec --skip-git-repo-check \
  --image ~/samples/invoice-page-1.png \
  -- "What text do you see on this image? Reply in one sentence."
```

**Alternative — run from inside a git repo (no skip flag):**

If you already cloned the repo in Part F, you can:

```bash
cd /opt/tally/tally-aws-all-config
codex exec --image ~/samples/invoice-page-1.png -- "What text do you see on this image? Reply in one sentence."
```

**Also works (prompt first):**

```bash
codex exec --skip-git-repo-check \
  "What text do you see on this image? Reply in one sentence." \
  -i ~/samples/invoice-page-1.png
```

**Two-page invoice?** Test page 1 first, then:

```bash
codex exec --skip-git-repo-check \
  --image ~/samples/invoice-page-1.png,~/samples/invoice-page-2.png \
  -- "List invoice number, party name, and total."
```

If Codex prints a sensible answer, your **Plus subscription + vision** path is good. Then continue to **Part F**.

**Optional — save output to a file:**

```bash
codex exec --skip-git-repo-check \
  --image ~/samples/invoice-page-1.png \
  -o /tmp/codex-test-out.txt \
  -- "Extract party name, invoice number, and total as JSON only."

cat /tmp/codex-test-out.txt
```

**Common errors at Step E2:**

| Error | Fix |
|-------|-----|
| `No prompt provided` | Add `--` before the quoted prompt |
| `Not inside a trusted directory` | Add `--skip-git-repo-check` or `cd` into your git clone |
| Image path not found | Use `ls ~/samples/` and the exact `invoice-page-1.png` name |

---

## Part F — Clone repo on EC2 and configure extractor-service

> **Start Part F only after Step E2 works.** Part F installs the HTTP API that OpenClaw will call later.

### Step F1 — Clone from GitHub

```bash
sudo mkdir -p /opt/tally
sudo chown ubuntu:ubuntu /opt/tally
cd /opt/tally

git clone https://github.com/meetpaladiya44/tally-aws-all-config.git
cd tally-aws-all-config
ls -la
# should show: extractor-service/  tally-skill/
```

If the repo is private, GitHub may ask for credentials. Options:

- Use a **Personal Access Token** as password when prompted
- Or set up SSH deploy key on EC2

---

### Step F2 — Install Node dependencies

```bash
cd /opt/tally/tally-aws-all-config/extractor-service
npm ci
```

If `npm ci` fails (no lock file), use:

```bash
npm install
```

---

### Step F3 — Create `.env` file

Generate a secret bearer token and **save it** (you will paste it twice: EC2 `.env` and later client OpenClaw env):

```bash
openssl rand -base64 48 | tr -d '\n'
# copy the output — this is your EXTRACTOR_BEARER
```

**Option A — copy from `.env.example` (after repo includes that file):**

```bash
cd /opt/tally/tally-aws-all-config/extractor-service
ls -la .env.example    # must exist; if missing, use Option B
cp .env.example .env
nano .env
```

Paste your bearer into `EXTRACTOR_BEARER=`, save (`Ctrl+O`, Enter, `Ctrl+X`).

**Option B — create `.env` manually (works even if `.env.example` was never on GitHub):**

```bash
cd /opt/tally/tally-aws-all-config/extractor-service

nano .env
```

Paste this block and replace `PASTE_YOUR_BEARER_HERE`:

```env
PORT=8080
EXTRACTOR_BEARER=PASTE_YOUR_BEARER_HERE
CODEX_BIN=codex
CODEX_MODEL=gpt-5.5
PDFTOPPM_BIN=pdftoppm
MAX_PAGES=10
UPLOAD_DIR=./uploads
IDEMPOTENCY_CACHE_DIR=./data
MAX_UPLOAD_BYTES=10485760
```

**Option C — one command (replace the bearer string):**

```bash
cd /opt/tally/tally-aws-all-config/extractor-service

BEARER='paste-your-openssl-token-here'
cat > .env <<EOF
PORT=8080
EXTRACTOR_BEARER=${BEARER}
CODEX_BIN=codex
CODEX_MODEL=gpt-5.5
PDFTOPPM_BIN=pdftoppm
MAX_PAGES=10
UPLOAD_DIR=./uploads
IDEMPOTENCY_CACHE_DIR=./data
MAX_UPLOAD_BYTES=10485760
EOF

chmod 600 .env
```

**Never commit `.env` to GitHub** (only `.env.example` is safe to commit).

**If `.env.example` was missing on clone:** your root `.gitignore` had `.env*` which blocked it. After pulling the fix, on your PC run:

```powershell
cd D:\tally-skill-openclaw-main
git add extractor-service/.env.example .gitignore
git commit -m "Track extractor-service .env.example"
git push
```

Then on EC2: `git pull` and `cp .env.example .env` will work for future clones.

---

### Step F4 — Start extractor with PM2

```bash
cd /opt/tally/tally-aws-all-config/extractor-service
pm2 start server.js --name extractor
pm2 save
pm2 startup
```

PM2 prints a `sudo env PATH=...` command — **copy and run that exact command**, then:

```bash
pm2 status
```

You should see `extractor` with status **online**.

---

### Step F5 — Health check (on EC2)

```bash
export EXTRACTOR_BEARER='paste-same-token-from-env-file'

curl -s -H "Authorization: Bearer $EXTRACTOR_BEARER" \
  http://127.0.0.1:8080/v1/health | jq .
```

Expected:

```json
{
  "status": "ok",
  "codex_logged_in": true,
  "version": "1.0.0"
}
```

If `codex_logged_in` is **false**, run `codex login --device-code` again as `ubuntu`, then `pm2 restart extractor`.

---

### Step F6 — Test extraction API with your sample file

Use the same invoice from Part E (`Invoice No.8933183031.PDF` and/or `invoice-page-*.png`).

Load bearer from `.env` (same folder as `server.js`):

```bash
cd /opt/tally/tally-aws-all-config/extractor-service
export EXTRACTOR_BEARER=$(grep '^EXTRACTOR_BEARER=' .env | cut -d= -f2-)
```

**PDF test** (extractor-service converts PDF → PNG internally):

```bash
curl -s -X POST http://127.0.0.1:8080/v1/extract \
  -H "Authorization: Bearer $EXTRACTOR_BEARER" \
  -F "file=@/home/ubuntu/Invoice No.8933183031.PDF" | jq .
```

(Quotes around the `-F` value are required because the filename has spaces.)

If the PDF is under `~/samples/` instead:

```bash
curl -s -X POST http://127.0.0.1:8080/v1/extract \
  -H "Authorization: Bearer $EXTRACTOR_BEARER" \
  -F "file=@/home/ubuntu/samples/Invoice No.8933183031.PDF" | jq .
```

**Image test** (single page PNG from Part E Method 3):

> **Expect 1–5 minutes with no printed output.** `curl -s` is silent while waiting. Do **not** press Ctrl+C unless it exceeds 5 minutes. Open a **second SSH window** and run `pm2 logs extractor --lines 0` first so you see `[codex] starting` / `[codex] finished`.

Terminal 1 — watch logs:

```bash
pm2 logs extractor --lines 0
```

Terminal 2 — run extract (180s max wait; shows errors if any):

```bash
cd /opt/tally/tally-aws-all-config/extractor-service
export EXTRACTOR_BEARER=$(grep '^EXTRACTOR_BEARER=' .env | cut -d= -f2-)

curl --max-time 180 -X POST http://127.0.0.1:8080/v1/extract \
  -H "Authorization: Bearer $EXTRACTOR_BEARER" \
  -F "file=@/home/ubuntu/samples/invoice-page-1.png" | jq .
```

If Terminal 1 shows `[codex] starting` but nothing after 5+ minutes, stop and test Codex manually (see troubleshooting below).

**Both pages** (optional — service uses first pages up to `MAX_PAGES` in `.env`):

```bash
# Test page 2 only
curl -s -X POST http://127.0.0.1:8080/v1/extract \
  -H "Authorization: Bearer $EXTRACTOR_BEARER" \
  -F "file=@/home/ubuntu/samples/invoice-page-2.png" | jq .
```

Expected success shape:

```json
{
  "status": "ok",
  "request_id": "...",
  "extracted": { "party": "...", "invoice_no": "...", "total": ... },
  "raw": "...",
  "pages": 1,
  "model": "gpt-5"
}
```

Watch logs if it fails:

```bash
pm2 logs extractor --lines 80
```

**`parse_error: "Empty Codex response"`** — Codex ran but the CLI wrote no text to the `-o` file (often caused by an old build using `--sandbox read-only`). Fix:

```bash
cd /opt/tally/tally-aws-all-config
git pull
cd extractor-service
pm2 restart extractor
pm2 logs extractor --lines 0
# retry F6 curl in another terminal
```

Sanity-check Codex alone (should print invoice fields in ~1–3 min):

```bash
OUT=/tmp/codex-manual-test.txt
time codex exec --skip-git-repo-check --full-auto \
  --image /home/ubuntu/samples/invoice-page-1.png \
  -o "$OUT" -- "Return JSON with invoice_no and total only."
cat "$OUT"
```

If `cat` is empty but `codex exec` exits 0, add to `.env`: `CODEX_EXTRA_ARGS=--dangerously-bypass-approvals-and-sandbox`, then `pm2 restart extractor`.

---

### Step F7 — Expose extractor to the internet (for client OpenClaw)

Your client machine must reach EC2 on HTTPS. Options:

**Option A — Quick dev test: SSH tunnel (no public URL)**

On your **Windows PC**:

```powershell
ssh -i "C:\Users\meetp\Downloads\tally-dev-key.pem" -L 8080:127.0.0.1:8080 ubuntu@3.110.xx.xx
```

Then on client set `EXTRACTOR_URL=http://127.0.0.1:8080` (only works while tunnel is open).

**Option B — Production: Cloudflare Tunnel (stable URL)**

On EC2:

```bash
# install cloudflared — see https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/install-and-setup/installation/
curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb -o cloudflared.deb
sudo dpkg -i cloudflared.deb

cloudflared tunnel login
cloudflared tunnel create tally-extractor
cloudflared tunnel route dns tally-extractor extractor.yourdomain.com
cloudflared tunnel run --url http://127.0.0.1:8080 tally-extractor
```

Use `https://extractor.yourdomain.com` as `EXTRACTOR_URL` on the client.

**Option C — Dev only: open port 8080 in security group**

If you added port 8080 for My IP in B2:

```bash
curl -s -H "Authorization: Bearer $EXTRACTOR_BEARER" \
  http://3.110.xx.xx:8080/v1/health | jq .
```

---

## Part G — Client CPU (Tally + OpenClaw)

This runs on the **machine beside TallyPrime** (your laptop or client office PC).

### Step G1 — Install TallyPrime

1. Install and open TallyPrime
2. Press **F1** → **Settings** → **Connectivity**
3. Set **TallyPrime acts as** = Server (or Both)
4. Port **9000**, **Allow Local TDL** = Yes
5. In browser on that machine: `http://localhost:9000` → should show Tally running message

---

### Step G2 — Install Node, OpenClaw, tallyca

On Windows (PowerShell as admin if needed):

```powershell
# Install Node 20 LTS from https://nodejs.org if not installed
npm install -g openclaw tallyca pm2
openclaw --version
tallyca --version
```

On Linux client, same as EC2 Node install + `npm i -g openclaw tallyca pm2`.

---

### Step G3 — Get tally-skill onto client

Either clone the same repo:

```powershell
git clone https://github.com/meetpaladiya44/tally-aws-all-config.git C:\tally\tally-aws-all-config
```

Or copy only `tally-skill` folder via USB/SCP.

---

### Step G4 — OpenClaw onboard

```bash
openclaw onboard
```

| Prompt | Answer |
|--------|--------|
| LLM | OpenAI API key **or** Codex Plus (your choice for chat reasoning) |
| Skill | `tally-prime-ca` |
| Channel | **Telegram** — paste BotFather token |
| Workdir | your choice |

Register skill:

```bash
cd C:\tally\tally-aws-all-config
openclaw skill add ./tally-skill --as tally-prime-ca
```

---

### Step G5 — Set environment variables on client

Create `C:\tally\ecosystem.config.cjs` (or `~/ecosystem.config.cjs` on Linux):

```javascript
module.exports = {
  apps: [{
    name: 'openclaw-tally',
    script: 'openclaw',
    args: 'serve --skill tally-prime-ca',
    env: {
      TALLY_URL: 'http://localhost:9000',
      EXTRACTOR_URL: 'https://extractor.yourdomain.com',
      EXTRACTOR_BEARER: 'SAME_TOKEN_AS_EC2_ENV',
    },
  }],
};
```

Start:

```bash
pm2 start ecosystem.config.cjs
pm2 save
pm2 logs openclaw-tally
```

**Rules:**

- `EXTRACTOR_BEARER` must match EC2 `extractor-service/.env` exactly
- `EXTRACTOR_URL` — no trailing slash
- Do **not** expose Tally port 9000 to the internet

---

## Part H — End-to-end test

| # | Check | Command / action |
|---|--------|------------------|
| H1 | EC2 Codex logged in | `curl .../v1/health` → `codex_logged_in: true` |
| H2 | EC2 extract works | `curl -F file=@~/Invoice No.8933183031.PDF .../v1/extract` → `status: ok` |
| H3 | Client Tally up | `curl http://localhost:9000` on client |
| H4 | OpenClaw running | `pm2 status` → openclaw-tally online |
| H5 | Telegram bot | Send `/start` to your bot |
| H6 | Full flow | Send invoice PDF to bot → check Tally for new voucher |

**Logs:**

```bash
# EC2
pm2 logs extractor --lines 100

# Client
pm2 logs openclaw-tally --lines 100
```

---

## Part I — Dev shortcut: everything on EC2 first

If you want to test **before** setting up a separate client machine:

1. EC2: extractor running (Parts C–F)
2. On your laptop: `ngrok http 9000` for Tally (dev only)
3. On EC2: install OpenClaw too, set `TALLY_URL` to ngrok URL, same `EXTRACTOR_URL=http://127.0.0.1:8080`
4. Send PDF to Telegram bot running on EC2

Production should still be: **extractor on EC2**, **OpenClaw + Tally on client**.

---

## Command cheat sheet

| Action | Where | Command |
|--------|-------|---------|
| SSH to EC2 | PC | `ssh -i key.pem ubuntu@<ip>` |
| Copy PDF to EC2 | PC | `scp -i key.pem "Invoice No.8933183031.PDF" ubuntu@<ip>:~/` |
| Codex image test | EC2 | `codex exec --skip-git-repo-check --image ~/samples/invoice-page-1.png -- "prompt"` |
| PDF → PNG | EC2 | `pdftoppm -png ~/'Invoice No.8933183031.PDF' ~/samples/invoice-page` |
| Health | EC2 | `curl -H "Authorization: Bearer $TOKEN" localhost:8080/v1/health` |
| Extract API (PDF) | EC2 | `curl -F file=@"/home/ubuntu/Invoice No.8933183031.PDF" -H "Authorization: Bearer $TOKEN" localhost:8080/v1/extract` |
| Extract API (PNG) | EC2 | `curl -F file=@/home/ubuntu/samples/invoice-page-1.png ...` |
| Restart extractor | EC2 | `pm2 restart extractor` |
| Re-login Codex | EC2 | `codex login --device-code` |
| Tally check | Client | `curl -s http://localhost:9000` |

---

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| `codex_logged_in: false` | `codex login --device-code` as `ubuntu`, then `pm2 restart extractor` |
| `codex exec` fails | Check Plus subscription; try `codex exec --image` with a small PNG first |
| `pdftoppm: command not found` | `sudo apt install poppler-utils` |
| `EXTRACTION_FAILED` | `pm2 logs extractor`; test `codex exec --image` manually |
| `unexpected argument '--ask-for-approval'` | `git pull` + `pm2 restart extractor` (older Codex CLI; service now uses `--full-auto`) |
| `Empty Codex response` | `git pull` + `pm2 restart extractor`; test `codex exec -o /tmp/t.txt` manually; see F6 note above |
| curl hangs, no output | Normal for 1–5 min; use `pm2 logs extractor`; add `--max-time 180`; don't use Ctrl+C early |
| Codex stuck in PM2 | Add to `.env`: `CODEX_EXTRA_ARGS=--dangerously-bypass-approvals-and-sandbox`, then `pm2 restart extractor` |
| `401 Unauthorized` | `EXTRACTOR_BEARER` mismatch between client and EC2 `.env` |
| SCP permission denied | `chmod 600 key.pem` / `icacls` on Windows |
| Git clone asks password | Use GitHub PAT as password, or SSH key |

---

## Repo layout

```
extractor-service/     # Run on EC2 — Codex Plus extraction API
tally-skill/           # Run on client — Tally + calls extractor
dev-testing.md         # This guide
```
