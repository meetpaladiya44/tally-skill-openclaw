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

Terminal 2 — run extract (300s max wait; shows errors if any):

```bash
cd /opt/tally/tally-aws-all-config/extractor-service
export EXTRACTOR_BEARER=$(grep '^EXTRACTOR_BEARER=' .env | cut -d= -f2-)

curl --max-time 120 -X POST http://127.0.0.1:8080/v1/extract \
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

**`EXTRACTION_FAILED` / empty output / `Reading additional input from stdin` in PM2 logs** — the service must pipe the prompt on stdin (argv prompt is ignored by many Codex builds). Fix:

```bash
cd /opt/tally/tally-aws-all-config
git pull
cd extractor-service
pm2 restart extractor
pm2 logs extractor --lines 0
# retry F6 curl in another terminal
```

Sanity-check Codex alone with **stdin prompt** (matches how the service runs; ~1–5 min):

```bash
OUT=/tmp/codex-manual-test.txt
printf '%s' 'Return JSON with invoice_no and total only.' | \
  time codex exec --skip-git-repo-check -s workspace-write \
    -i /home/ubuntu/samples/invoice-page-1.png \
    -o "$OUT" -
cat "$OUT"
```

If `cat` is empty but `codex exec` exits 0, add to `.env`:

```env
CODEX_EXTRA_ARGS=--dangerously-bypass-approvals-and-sandbox
CODEX_TIMEOUT_MS=300000
```

Then `pm2 restart extractor`.

---

### Step F7 — Let the client PC reach the extractor (pick one path)

> **Running OpenClaw on the same EC2 as extractor?** Skip F7 and Part G on Windows. Use **[Part I — Dev mode: all on EC2](#part-i--dev-mode-openclaw--extractor-on-ec2-tally-on-laptop-ngrok)** instead (`EXTRACTOR_URL=http://127.0.0.1:8080`).

**Before F7 — you must have:**

- [ ] F5 health on EC2: `codex_logged_in: true`
- [ ] F6 extract on EC2: `status: ok` with real fields (`invoice_no`, `total`, …)
- [ ] `EXTRACTOR_BEARER` copied from EC2 `extractor-service/.env`

**What you are doing:** OpenClaw on the **client PC** (Part G) must call the extractor API. F7 connects that PC to EC2. Pick **one** row below and use the matching `EXTRACTOR_URL` in Step G5.

| Path | When to use | `EXTRACTOR_URL` on client (G5) |
|------|-------------|----------------------------------|
| **A — SSH tunnel** | Dev; no public URL; tunnel on same PC as OpenClaw | `http://127.0.0.1:18080` |
| **C — Direct EC2 IP** | Security group has port **8080 / My IP** (Part B2) | `http://YOUR_EC2_PUBLIC_IP:8080` |
| **B — Cloudflare Tunnel** | Production; stable HTTPS | `https://extractor.yourdomain.com` |

---

#### Option A — SSH tunnel (Windows PC → EC2)

**Where:** Windows PowerShell (not inside the SSH session).

**A1 — Open the tunnel** (leave this window open):

```powershell
ssh -4 -i "C:\Users\meetp\Downloads\tally-dev-key.pem" -L 127.0.0.1:18080:127.0.0.1:8080 ubuntu@YOUR_EC2_PUBLIC_IP
```

- `-4` = IPv4 only (helps on Windows)
- **18080** on your PC forwards to **8080** on EC2 (extractor)
- Replace `YOUR_EC2_PUBLIC_IP` with your instance public IPv4

**If you see** `bind [127.0.0.1]:8080: Permission denied` — port 8080 is already in use on Windows. Use **18080** as above (do not use local port 8080).

**A2 — Check what is using port 8080** (optional, in a second PowerShell window):

```powershell
netstat -ano | findstr :8080
```

Stop the program using that PID, or keep using local port **18080** in the SSH command.

**A3 — Verify tunnel from Windows** (second PowerShell window; tunnel window still open):

```powershell
$TOKEN = "paste-EXTRACTOR_BEARER-from-EC2-.env"
curl.exe -H "Authorization: Bearer $TOKEN" http://127.0.0.1:18080/v1/health
```

Expected: `"status":"ok"` and `"codex_logged_in":true`.

**For Part G5 use:** `EXTRACTOR_URL: 'http://127.0.0.1:18080'` (tunnel must stay open whenever OpenClaw extracts invoices).

---

#### Option C — Direct EC2 IP (no tunnel)

**Where:** EC2 first, then Windows.

**C1 — On EC2 (SSH):**

```bash
export EXTRACTOR_BEARER=$(grep '^EXTRACTOR_BEARER=' /opt/tally/tally-aws-all-config/extractor-service/.env | cut -d= -f2-)
curl -s -H "Authorization: Bearer $EXTRACTOR_BEARER" http://127.0.0.1:8080/v1/health | jq .
```

**C2 — On Windows PC** (replace IP; no SSH tunnel):

```powershell
$TOKEN = "paste-EXTRACTOR_BEARER-from-EC2-.env"
curl.exe -H "Authorization: Bearer $TOKEN" http://YOUR_EC2_PUBLIC_IP:8080/v1/health
```

If C2 fails: AWS Console → EC2 → Security group → Inbound rule **Custom TCP 8080** source **My IP**.

**For Part G5 use:** `EXTRACTOR_URL: 'http://YOUR_EC2_PUBLIC_IP:8080'`

---

#### Option B — Cloudflare Tunnel (production)

**Where:** EC2 (SSH).

```bash
# install cloudflared — see https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/install-and-setup/installation/
curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb -o cloudflared.deb
sudo dpkg -i cloudflared.deb

cloudflared tunnel login
cloudflared tunnel create tally-extractor
cloudflared tunnel route dns tally-extractor extractor.yourdomain.com
cloudflared tunnel run --url http://127.0.0.1:8080 tally-extractor
```

**For Part G5 use:** `EXTRACTOR_URL: 'https://extractor.yourdomain.com'` (no trailing slash).

---

## Part G — Client PC (TallyPrime + OpenClaw)

### What is the “client” machine?

| Term | Machine | What runs there |
|------|---------|-----------------|
| **EC2** | AWS server | `extractor-service`, Codex CLI |
| **Client** | PC beside Tally — usually **your Windows laptop** | TallyPrime (`:9000`), OpenClaw, Telegram bot, `tally-skill` |

**“Set `EXTRACTOR_URL` on the client”** means: put it in `C:\tally\ecosystem.config.cjs` (Step G5) so OpenClaw can call the extractor when a user sends a PDF. You do **not** set this on EC2 (unless using Part I all-on-EC2 shortcut).

If Tally + OpenClaw are on the **same laptop** where you run the SSH tunnel (Option A), that laptop **is** the client.

---

### Step G1 — Install TallyPrime

**Where:** Client PC (Windows).

1. Install and open TallyPrime
2. Press **F1** → **Settings** → **Connectivity**
3. Set **TallyPrime acts as** = Server (or Both)
4. Port **9000**, **Allow Local TDL** = Yes
5. In browser on that machine: `http://localhost:9000` → should show Tally running message

---

### Step G2 — Install Node, OpenClaw, tallyca

**Where:** Client PC.

**Windows (PowerShell; admin if npm global install fails):**

```powershell
# Install Node 20 LTS from https://nodejs.org if not installed
npm install -g openclaw tallyca pm2
openclaw --version
tallyca --version
```

**Linux client:** same as EC2 Node install + `npm i -g openclaw tallyca pm2`.

---

### Step G3 — Get tally-skill onto client

**Where:** Client PC.

```powershell
git clone https://github.com/meetpaladiya44/tally-aws-all-config.git C:\tally\tally-aws-all-config
```

Or copy only the `tally-skill` folder via USB/SCP.

---

### Step G4 — OpenClaw onboard

**Where:** Client PC.

```powershell
openclaw onboard
```

| Prompt | Answer |
|--------|--------|
| LLM | OpenAI API key **or** Codex Plus (your choice for chat reasoning) |
| Skill | `tally-prime-ca` |
| Channel | **Telegram** — paste BotFather token |
| Workdir | your choice |

Register skill:

```powershell
cd C:\tally\tally-aws-all-config
openclaw skill add ./tally-skill --as tally-prime-ca
```

---

### Step G5 — Set environment variables on client

**Where:** Client PC.

Create folder and config file:

```powershell
mkdir C:\tally -Force
notepad C:\tally\ecosystem.config.cjs
```

Paste **one** of the blocks below. Change `EXTRACTOR_BEARER` to the **exact** value from EC2 `extractor-service/.env`.

**Option A — SSH tunnel (F7 Option A; tunnel must be running on this PC):**

```javascript
module.exports = {
  apps: [{
    name: 'openclaw-tally',
    script: 'openclaw',
    args: 'serve --skill tally-prime-ca',
    env: {
      TALLY_URL: 'http://localhost:9000',
      EXTRACTOR_URL: 'http://127.0.0.1:18080',
      EXTRACTOR_BEARER: 'PASTE_SAME_TOKEN_AS_EC2_ENV',
    },
  }],
};
```

**Option C — Direct EC2 IP (F7 Option C; no tunnel):**

```javascript
module.exports = {
  apps: [{
    name: 'openclaw-tally',
    script: 'openclaw',
    args: 'serve --skill tally-prime-ca',
    env: {
      TALLY_URL: 'http://localhost:9000',
      EXTRACTOR_URL: 'http://YOUR_EC2_PUBLIC_IP:8080',
      EXTRACTOR_BEARER: 'PASTE_SAME_TOKEN_AS_EC2_ENV',
    },
  }],
};
```

**Option B — Cloudflare (F7 Option B):**

```javascript
module.exports = {
  apps: [{
    name: 'openclaw-tally',
    script: 'openclaw',
    args: 'serve --skill tally-prime-ca',
    env: {
      TALLY_URL: 'http://localhost:9000',
      EXTRACTOR_URL: 'https://extractor.yourdomain.com',
      EXTRACTOR_BEARER: 'PASTE_SAME_TOKEN_AS_EC2_ENV',
    },
  }],
};
```

**G6 — Start OpenClaw with PM2**

**Where:** Client PC.

```powershell
cd C:\tally
pm2 start ecosystem.config.cjs
pm2 save
pm2 logs openclaw-tally
```

**Rules:**

- `EXTRACTOR_BEARER` must match EC2 `extractor-service/.env` exactly
- `EXTRACTOR_URL` — no trailing slash
- Do **not** expose Tally port 9000 to the internet
- Option A: keep the SSH tunnel PowerShell window open while testing

---

## Part H — End-to-end test

Run in order. Fix any step before the next.

| # | Where | Check | Command / action |
|---|-------|--------|------------------|
| H1 | EC2 | Codex logged in | `curl -s -H "Authorization: Bearer $EXTRACTOR_BEARER" http://127.0.0.1:8080/v1/health \| jq .` → `codex_logged_in: true` |
| H2 | EC2 | Extract works | F6 PNG/PDF curl → `status: ok` with `invoice_no`, `total` |
| H3 | Client | Tally up | PowerShell: `curl.exe http://localhost:9000` → Tally message |
| H4 | Client | F7 path works | Option A: `curl.exe ... http://127.0.0.1:18080/v1/health` **or** Option C: `curl.exe ... http://EC2_IP:8080/v1/health` |
| H5 | Client | OpenClaw running | `pm2 status` → `openclaw-tally` **online** |
| H6 | Client | Telegram bot | Send `/start` to your bot |
| H7 | Client | Full flow | Send invoice PDF/image to bot → confirm voucher in TallyPrime |

**Logs:**

```bash
# EC2 (SSH)
pm2 logs extractor --lines 100
```

```powershell
# Client PC
pm2 logs openclaw-tally --lines 100
```

---

## Part I — Dev mode: OpenClaw + extractor on EC2, Tally on laptop (ngrok)

Use this path when **both** `extractor-service` and **OpenClaw** run on your **AWS EC2**, and **TallyPrime** runs on your **Windows laptop**. This is common for dev before moving OpenClaw beside Tally in production.

### How the pieces connect (no magic pipe)

The extractor **does not push** data to OpenClaw. Two separate PM2 processes talk over **HTTP on localhost**:

| Process | PM2 name | Role | AI / auth |
|---------|----------|------|-----------|
| `extractor-service` | `extractor` | `POST /v1/extract` → JSON | **Codex CLI** + **ChatGPT Plus** (`codex login` on EC2) |
| OpenClaw + `tally-skill` | `openclaw-tally` | Telegram bot; runs `curl` per SKILL.md | **OpenAI API key** from `openclaw onboard` (agent reasoning) |

When you send a PDF on Telegram:

1. OpenClaw saves the attachment on EC2.
2. The agent runs **Step 1a** in `tally-skill/SKILL.md` — a `curl` to `http://127.0.0.1:8080/v1/extract` with `EXTRACTOR_BEARER`.
3. Extractor runs Codex on the image/PDF and returns `extracted` JSON.
4. The agent uses that JSON and posts a voucher to `TALLY_URL` (your laptop via ngrok).

```text
Telegram → OpenClaw (EC2) ──curl──► extractor :8080 (EC2) ──codex──► ChatGPT Plus
                │
                └──curl XML──► TALLY_URL (ngrok) ──► TallyPrime :9000 (Windows laptop)
```

**Skip Part F7** (SSH tunnel / public extractor URL) — OpenClaw and extractor share the same machine; use `EXTRACTOR_URL=http://127.0.0.1:8080`.

**Two different OpenAI-related setups (both correct):**

- `openclaw onboard` → OpenAI **API key** for the agent (chat, tools, following the skill).
- EC2 `codex login` → **ChatGPT Plus** for extraction only. The onboard API key is **not** used by the extractor.

---

### Part I prerequisites

- [ ] Parts C–F done on EC2 (`extractor` PM2 online, F6 extract returns real fields)
- [ ] TallyPrime on laptop: server on port **9000**, browser `http://localhost:9000` works
- [ ] Telegram bot token from BotFather
- [ ] OpenAI API key for OpenClaw agent (separate from Plus/Codex on extractor)

---

### I1 — Keep extractor running (EC2)

**Where:** EC2 SSH.

```bash
pm2 status
pm2 logs extractor --lines 20
```

---

### I2 — Install OpenClaw and tally-skill on EC2

**Where:** EC2 SSH.

```bash
# If not already installed (same as Part C Node + global packages)
npm install -g openclaw tallyca pm2

openclaw onboard
```

| Prompt | Answer |
|--------|--------|
| LLM | **OpenAI API key** (for agent — not used for PDF extraction) |
| Channel | **Telegram** — BotFather token |
| Skill / workdir | your choice |

Register the skill:

```bash
cd /opt/tally/tally-aws-all-config
openclaw skill add ./tally-skill --as tally-prime-ca
```

---

### I3 — PM2 config on EC2 (localhost extractor + ngrok Tally)

**Where:** EC2 SSH.

```bash
mkdir -p ~/tally-openclaw
nano ~/tally-openclaw/ecosystem.config.cjs
```

Paste (replace placeholders):

```javascript
module.exports = {
  apps: [{
    name: 'openclaw-tally',
    script: 'openclaw',
    args: 'serve --skill tally-prime-ca',
    env: {
      TALLY_URL: 'https://YOUR-NGROK-SUBDOMAIN.ngrok-free.app',
      EXTRACTOR_URL: 'http://127.0.0.1:8080',
      EXTRACTOR_BEARER: 'PASTE_SAME_TOKEN_AS_extractor-service_.env',
    },
  }],
};
```

Start:

```bash
cd ~/tally-openclaw
pm2 start ecosystem.config.cjs
pm2 save
pm2 logs openclaw-tally
```

You should now have **two** PM2 apps: `extractor` and `openclaw-tally`.

---

### I4 — Expose Tally from Windows laptop (ngrok)

**Where:** Windows laptop (Tally must be open with XML/HTTP on port 9000).

```powershell
# Install ngrok from https://ngrok.com/download then:
ngrok http 9000
```

Copy the **https** forwarding URL (e.g. `https://abc123.ngrok-free.app`). Put it in EC2 `ecosystem.config.cjs` as `TALLY_URL` (no trailing slash).

**Where:** EC2 SSH — restart OpenClaw after updating `TALLY_URL`:

```bash
pm2 restart openclaw-tally
```

Verify Tally reachable from EC2:

```bash
export TALLY_URL='https://YOUR-NGROK-SUBDOMAIN.ngrok-free.app'
curl -s --max-time 15 "$TALLY_URL"
```

Expected: XML containing `TallyPrime Server is Running` (or similar).

---

### I5 — Manual test: same curls the agent runs (SKILL Step 1a)

**Where:** EC2 SSH. Simulates `tally-skill/SKILL.md` Step 1a before using Telegram.

```bash
export EXTRACTOR_URL=http://127.0.0.1:8080
export EXTRACTOR_BEARER=$(grep '^EXTRACTOR_BEARER=' /opt/tally/tally-aws-all-config/extractor-service/.env | cut -d= -f2-)

# 1a.1 health
curl -s -H "Authorization: Bearer $EXTRACTOR_BEARER" "$EXTRACTOR_URL/v1/health" | jq .

# 1a.2 extract (use your sample PNG)
curl -s --max-time 300 -X POST "$EXTRACTOR_URL/v1/extract" \
  -H "Authorization: Bearer $EXTRACTOR_BEARER" \
  -F "file=@/home/ubuntu/samples/invoice-page-1.png" \
  -F "prompt=Extract GST invoice fields for Tally voucher posting" | jq .
```

Success: `"status":"ok"` and `extracted` with `invoice_no`, `total`, etc. If this works, the agent can call the same URLs from `EXTRACTOR_URL` / `EXTRACTOR_BEARER` in PM2 env.

---

### I5b — Verify the Telegram bot uses your skill + extractor

**Why:** If `pm2 logs openclaw-tally` is empty during a Telegram chat but the bot still replies, a **different** OpenClaw process (from `openclaw onboard`, without `EXTRACTOR_URL`) may be answering. That process uses the **OpenAI API** to read PDFs directly — **not** Codex Plus via the extractor.

**Where:** EC2 SSH.

```bash
# All OpenClaw processes (expect ONE if only PM2 should run Telegram)
ps -ef | grep -i openclaw | grep -v grep

# PM2 app env (must show EXTRACTOR_URL and EXTRACTOR_BEARER)
pm2 list
pm2 describe openclaw-tally
# Note the pm2 id, then:
pm2 env <id>

# Skills loaded
openclaw skill list
```

**Use only one tally skill for testing.** If both `tally-prime-ca` (local repo) and a ClawHub `tally-skill` appear, remove the ClawHub copy:

```bash
openclaw skill remove tally-skill
openclaw skill list
```

Re-register local skill if needed:

```bash
cd /opt/tally/tally-aws-all-config
openclaw skill add ./tally-skill --as tally-prime-ca
```

**Smoke run — prove extractor receives Telegram uploads:**

Terminal 1:

```bash
pm2 logs extractor --lines 0 | grep --line-buffered '\[extract\]'
```

Terminal 2: send a **new** invoice PDF on Telegram (not a text-only message).

**Expected in Terminal 1 within ~1–5 min** (filename must match your PDF, **not** `invoice-page-1.png`):

```text
[extract] start request_id=... file=Invoice_No.8933180859.PDF mime=application/pdf size=... ip=127.0.0.1 ...
[extract] pdf-converted request_id=... pages=1 images=page-1.png
[codex] starting: ...
[codex] finished, NNN chars from Codex
[extract] done request_id=... pages=1 model=gpt-5.5 raw_chars=... invoice_hint=...
```

**Telegram reply must include:** `Extractor request_id: <same uuid>` (required by `tally-skill`).

If you see **no** `[extract] start` with your PDF filename, the bot did **not** call the extractor — fix I5c below.

---

### I5c — Stop rogue OpenClaw daemons (only PM2 should answer Telegram)

`openclaw onboard` may have started a background gateway that still owns your Telegram bot. That process usually **lacks** `EXTRACTOR_URL` / `EXTRACTOR_BEARER`.

**Where:** EC2 SSH.

```bash
ps -ef | grep -i openclaw | grep -v grep
```

For each PID **not** listed under `pm2 list` as `openclaw-tally`, stop it:

```bash
kill <PID>
# or if it respawns:
pkill -f 'openclaw.*gateway'
```

Then ensure only PM2 runs the bot:

```bash
pm2 restart openclaw-tally
pm2 logs openclaw-tally --lines 0
```

Send `/start` on Telegram again and repeat I5b smoke run.

---

### I6 — End-to-end checklist (Part I dev)

| # | Where | Check |
|---|-------|--------|
| I6.1 | EC2 | `pm2 status` → `extractor` and `openclaw-tally` **online** |
| I6.2 | EC2 | I5 health + extract curls succeed |
| I6.3 | Laptop | `http://localhost:9000` — Tally up |
| I6.4 | EC2 | `curl $TALLY_URL` via ngrok succeeds |
| I6.5 | Telegram | Send `/start` to your bot |
| I6.6 | EC2 | I5b smoke run: `[extract] start file=YourInvoice.PDF` (not only `invoice-page-1.png`) |
| I6.7 | Telegram | Reply includes `Extractor request_id: ...` matching extractor logs |
| I6.8 | Telegram | Voucher in Tally; confirm amounts match extractor JSON |

**Logs during I6.6–I6.8:**

```bash
# EC2 — grep-friendly extractor trace
pm2 logs extractor --lines 0 | grep --line-buffered '\[extract\]'

# EC2 — OpenClaw agent steps
pm2 logs openclaw-tally --lines 0
```

---

### Part I vs production layout

| | Dev (Part I) | Production (Part G + F7) |
|--|----------------|---------------------------|
| Extractor | EC2 | EC2 |
| OpenClaw | EC2 | Client PC beside Tally |
| Tally | Laptop + ngrok | `localhost:9000` on client |
| `EXTRACTOR_URL` | `http://127.0.0.1:8080` | Tunnel, public IP, or Cloudflare (F7) |
| `TALLY_URL` | ngrok HTTPS URL | `http://localhost:9000` |

---

### What to skip when using Part I

| Section | Skip? |
|---------|--------|
| **F7** | Yes — extractor is localhost on EC2 |
| **Part G on Windows** | Yes — do I2–I3 on EC2 instead |
| **F7 SSH tunnel from laptop** | Yes |

---

## Command cheat sheet

| Action | Where | Command |
|--------|-------|---------|
| SSH to EC2 | PC | `ssh -i key.pem ubuntu@<ip>` |
| SSH tunnel (F7 A) | PC | `ssh -4 -i key.pem -L 127.0.0.1:18080:127.0.0.1:8080 ubuntu@<ip>` |
| Health via tunnel | PC | `curl.exe -H "Authorization: Bearer $TOKEN" http://127.0.0.1:18080/v1/health` |
| Health via public IP | PC | `curl.exe -H "Authorization: Bearer $TOKEN" http://<ec2-ip>:8080/v1/health` |
| Copy PDF to EC2 | PC | `scp -i key.pem "Invoice No.8933183031.PDF" ubuntu@<ip>:~/` |
| Codex image test | EC2 | `codex exec --skip-git-repo-check --image ~/samples/invoice-page-1.png -- "prompt"` |
| PDF → PNG | EC2 | `pdftoppm -png ~/'Invoice No.8933183031.PDF' ~/samples/invoice-page` |
| Health | EC2 | `curl -H "Authorization: Bearer $TOKEN" localhost:8080/v1/health` |
| Extract API (PDF) | EC2 | `curl -F file=@"/home/ubuntu/Invoice No.8933183031.PDF" -H "Authorization: Bearer $TOKEN" localhost:8080/v1/extract` |
| Extract API (PNG) | EC2 | `curl -F file=@/home/ubuntu/samples/invoice-page-1.png ...` |
| Restart extractor | EC2 | `pm2 restart extractor` |
| Re-login Codex | EC2 | `codex login --device-code` |
| Tally check | Client | `curl -s http://localhost:9000` |
| Part I: OpenClaw on EC2 | EC2 | `EXTRACTOR_URL=http://127.0.0.1:8080` in ecosystem.config.cjs |
| Part I: ngrok Tally | Laptop | `ngrok http 9000` → set `TALLY_URL` on EC2 |
| Part I: both PM2 apps | EC2 | `pm2 status` → `extractor` + `openclaw-tally` |
| SKILL 1a test (Part I) | EC2 | `curl POST $EXTRACTOR_URL/v1/extract -F file=@...` |
| Grep extractor requests | EC2 | `pm2 logs extractor \| grep '\[extract\]'` |

---

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| `codex_logged_in: false` | `codex login --device-code` as `ubuntu`, then `pm2 restart extractor` |
| `codex exec` fails | Check Plus subscription; try `codex exec --image` with a small PNG first |
| `pdftoppm: command not found` | `sudo apt install poppler-utils` |
| `EXTRACTION_FAILED` | `pm2 logs extractor`; test `codex exec --image` manually |
| `unexpected argument '--ask-for-approval'` | `git pull` + `pm2 restart extractor` (older Codex CLI) |
| `Reading additional input from stdin` in logs | Old build — `git pull` + `pm2 restart`; service must pipe prompt on stdin |
| `EXTRACTION_FAILED` / empty `extracted` | `git pull` + restart; run stdin manual test in F6; add `CODEX_EXTRA_ARGS` bypass |
| curl hangs, no output | Normal for 1–5 min; use `pm2 logs extractor`; use `--max-time 300`; don't use Ctrl+C early |
| Codex stuck in PM2 | Add to `.env`: `CODEX_EXTRA_ARGS=--dangerously-bypass-approvals-and-sandbox`, then `pm2 restart extractor` |
| `401 Unauthorized` | `EXTRACTOR_BEARER` mismatch between client and EC2 `.env` |
| `bind [127.0.0.1]:8080: Permission denied` (SSH `-L`) | Port 8080 in use on Windows — use `-L 127.0.0.1:18080:127.0.0.1:8080` and `EXTRACTOR_URL=http://127.0.0.1:18080`; or use F7 Option C |
| SCP permission denied | `chmod 600 key.pem` / `icacls` on Windows |
| Git clone asks password | Use GitHub PAT as password, or SSH key |
| OpenClaw on EC2: how does extractor connect? | HTTP only — agent runs `curl` to `127.0.0.1:8080`; see Part I |
| `curl $TALLY_URL` fails from EC2 | ngrok not running, wrong URL, or Tally server off on laptop |
| Agent extracts but Tally fails | Fix ngrok + `TALLY_URL`; test `curl $TALLY_URL` from EC2 |
| Telegram works but extractor logs only `invoice-page-1.png` | Those are manual F6 curls — bot never called extractor; run I5b/I5c |
| Voucher posted, no `Extractor request_id` in Telegram reply | Rogue OpenClaw or skill skipped Step 1a — kill extra processes; use local `tally-prime-ca` |
| `pm2 logs openclaw-tally` empty during chat | Wrong process owns Telegram — I5c |

---

## Repo layout

```
extractor-service/     # Run on EC2 — Codex Plus extraction API
tally-skill/           # Run on client — Tally + calls extractor
dev-testing.md         # This guide
```
