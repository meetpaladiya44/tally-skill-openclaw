'use strict';

require('dotenv').config();

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const multer = require('multer');
const {
  runCodex,
  prepareImagePaths,
  isCodexLoggedIn,
  DEFAULT_SCHEMA_HINT,
} = require('./codex-runner');

const PORT = Number(process.env.PORT || 8080);
const BEARER = process.env.EXTRACTOR_BEARER;
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, 'uploads');
const CACHE_DIR = process.env.IDEMPOTENCY_CACHE_DIR || path.join(__dirname, 'data');
const MAX_UPLOAD_BYTES = Number(process.env.MAX_UPLOAD_BYTES || 10 * 1024 * 1024);

if (!BEARER) {
  console.error('EXTRACTOR_BEARER is required');
  process.exit(1);
}

fs.mkdirSync(UPLOAD_DIR, { recursive: true });
fs.mkdirSync(CACHE_DIR, { recursive: true });

const idempotencyCache = new Map();

function loadCache() {
  try {
    const files = fs.readdirSync(CACHE_DIR).filter((f) => f.endsWith('.json'));
    for (const file of files) {
      const key = file.replace(/\.json$/, '');
      const data = JSON.parse(fs.readFileSync(path.join(CACHE_DIR, file), 'utf8'));
      idempotencyCache.set(key, data);
    }
  } catch {
    /* empty cache */
  }
}

function saveCacheEntry(key, response) {
  idempotencyCache.set(key, response);
  const safe = key.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 200);
  fs.writeFileSync(path.join(CACHE_DIR, `${safe}.json`), JSON.stringify(response), 'utf8');
}

function rmDirRecursive(dir) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) rmDirRecursive(p);
    else fs.unlinkSync(p);
  }
  fs.rmdirSync(dir);
}

loadCache();

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    const dir = path.join(UPLOAD_DIR, `job-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`);
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (_req, file, cb) => {
    const safe = (file.originalname || 'upload').replace(/[^a-zA-Z0-9._-]/g, '_');
    cb(null, safe);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_UPLOAD_BYTES },
});

const app = express();

function verifyBearer(req, res, next) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (token !== BEARER) {
    return res.status(401).json({
      status: 'error',
      error_code: 'UNAUTHORIZED',
      message: 'Invalid or missing bearer token',
    });
  }
  next();
}

app.get('/v1/health', verifyBearer, (_req, res) => {
  res.json({
    status: 'ok',
    codex_logged_in: isCodexLoggedIn(),
    version: '1.0.0',
  });
});

app.post('/v1/extract', verifyBearer, upload.single('file'), async (req, res) => {
  const idemKey = req.headers['idempotency-key'];
  if (idemKey && idempotencyCache.has(idemKey)) {
    const cached = idempotencyCache.get(idemKey);
    return res.status(200).json({ ...cached, duplicate: true });
  }

  if (!req.file) {
    return res.status(400).json({
      status: 'error',
      error_code: 'MISSING_FILE',
      message: 'multipart field "file" is required (PDF or image)',
    });
  }

  const requestId =
    req.body?.request_id ||
    req.headers['x-request-id'] ||
    crypto.randomUUID?.() ||
    `req-${Date.now()}`;

  const workDir = req.file.destination;
  const prompt = req.body?.prompt;
  const schemaHint = req.body?.schema_hint || DEFAULT_SCHEMA_HINT;

  try {
    if (!isCodexLoggedIn()) {
      return res.status(503).json({
        status: 'error',
        error_code: 'CODEX_NOT_LOGGED_IN',
        message: 'Codex CLI is not logged in on this host. Run: codex login --device-code',
      });
    }

    console.log(`extract start request_id=${requestId} file=${req.file.originalname}`);
    const imagePaths = await prepareImagePaths(req.file, workDir);
    const result = await runCodex({
      imagePaths,
      prompt,
      schemaHint,
      requestId,
      workDir,
    });

    const response = {
      status: 'ok',
      request_id: requestId,
      extracted: result.extracted,
      raw: result.raw,
      pages: result.pages,
      model: result.model,
    };

    if (idemKey) {
      saveCacheEntry(idemKey, response);
    }

    console.log(`extract done request_id=${requestId} pages=${result.pages}`);
    return res.status(200).json(response);
  } catch (err) {
    console.error('extract error:', err.message);
    return res.status(502).json({
      status: 'error',
      error_code: 'EXTRACTION_FAILED',
      message: err.message || 'Codex extraction failed',
      request_id: requestId,
    });
  } finally {
    try {
      rmDirRecursive(workDir);
    } catch {
      /* ignore cleanup errors */
    }
  }
});

app.use((err, _req, res, _next) => {
  if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({
      status: 'error',
      error_code: 'FILE_TOO_LARGE',
      message: `File exceeds ${MAX_UPLOAD_BYTES} bytes`,
    });
  }
  console.error('unhandled error:', err);
  return res.status(500).json({
    status: 'error',
    error_code: 'INTERNAL_ERROR',
    message: err.message || 'Internal server error',
  });
});

app.listen(PORT, () => {
  console.log(`tally-extractor-service listening on :${PORT}`);
  console.log(`CODEX_BIN=${process.env.CODEX_BIN || 'codex'} codex_logged_in=${isCodexLoggedIn()}`);
});
