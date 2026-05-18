'use strict';

require('dotenv').config();

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const { invokeOpenClaw } = require('./openclaw');

const PORT = Number(process.env.PORT || 8787);
const BEARER = process.env.BRIDGE_BEARER;
const HMAC_SECRET = process.env.BRIDGE_HMAC_SECRET;
const TALLY_URL = process.env.TALLY_URL || 'http://localhost:9000';
const CACHE_DIR = process.env.IDEMPOTENCY_CACHE_DIR || path.join(__dirname, 'data');

if (!BEARER || !HMAC_SECRET) {
  console.error('BRIDGE_BEARER and BRIDGE_HMAC_SECRET are required');
  process.exit(1);
}

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

loadCache();

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

function verifyHmac(req, res, next) {
  const sigHeader = req.headers['x-signature'] || '';
  const expectedPrefix = 'hmac-sha256=';
  if (!sigHeader.startsWith(expectedPrefix)) {
    return res.status(401).json({
      status: 'error',
      error_code: 'INVALID_SIGNATURE',
      message: 'Missing X-Signature header',
    });
  }
  const provided = sigHeader.slice(expectedPrefix.length);
  const raw = req.rawBody || '';
  const computed = crypto.createHmac('sha256', HMAC_SECRET).update(raw, 'utf8').digest('hex');
  const a = Buffer.from(provided, 'hex');
  const b = Buffer.from(computed, 'hex');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(401).json({
      status: 'error',
      error_code: 'INVALID_SIGNATURE',
      message: 'HMAC signature mismatch',
    });
  }
  next();
}

app.use(
  express.json({
    verify: (req, _res, buf) => {
      req.rawBody = buf.toString('utf8');
    },
  })
);

app.get('/v1/health', verifyBearer, async (_req, res) => {
  let tally = 'down';
  let companyDefault = null;
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 5000);
    const r = await fetch(TALLY_URL, { signal: controller.signal });
    clearTimeout(t);
    const text = await r.text();
    if (text.includes('TallyPrime Server is Running') || text.includes('Running')) {
      tally = 'ok';
    }
  } catch {
    tally = 'down';
  }

  res.json({
    tally,
    company_default: companyDefault,
    version: '1.0.0',
  });
});

app.post('/v1/post-voucher', verifyBearer, verifyHmac, async (req, res) => {
  const idemKey = req.headers['idempotency-key'];
  if (!idemKey) {
    return res.status(400).json({
      status: 'error',
      error_code: 'MISSING_IDEMPOTENCY_KEY',
      message: 'Idempotency-Key header is required',
    });
  }

  const body = req.body;
  if (!body || typeof body !== 'object') {
    return res.status(400).json({
      status: 'error',
      error_code: 'INVALID_BODY',
      message: 'Request body must be JSON object',
    });
  }

  if (body.idempotency_key && body.idempotency_key !== idemKey) {
    return res.status(400).json({
      status: 'error',
      error_code: 'INVALID_BODY',
      message: 'idempotency_key in body must match Idempotency-Key header',
    });
  }

  body.idempotency_key = idemKey;

  if (!body.schema_version || !body.company || !body.voucher) {
    return res.status(400).json({
      status: 'error',
      error_code: 'INVALID_BODY',
      message: 'Missing schema_version, company, or voucher',
    });
  }

  if (idempotencyCache.has(idemKey)) {
    const cached = idempotencyCache.get(idemKey);
    return res.status(200).json({ ...cached, duplicate: true });
  }

  try {
    const health = await tallyReachable();
    if (!health) {
      return res.status(502).json({
        status: 'error',
        error_code: 'TALLY_UNREACHABLE',
        message: `Could not connect to Tally at ${TALLY_URL}`,
      });
    }

    const result = await invokeOpenClaw(body, 'post-voucher');

    if (result.status === 'needs_clarification') {
      return res.status(422).json(result);
    }

    if (result.status === 'error') {
      return res.status(502).json(result);
    }

    const response = {
      status: 'posted',
      guid: result.guid || idemKey,
      voucher_number: result.voucher_number || body.voucher?.number,
      company: result.company || body.company,
      summary: result.summary || 'Voucher posted to Tally',
      masters_created: result.masters_created || [],
    };

    saveCacheEntry(idemKey, response);
    return res.status(200).json(response);
  } catch (err) {
    console.error('post-voucher error:', err.message);
    return res.status(502).json({
      status: 'error',
      error_code: 'OPENCLAW_ERROR',
      message: err.message || 'OpenClaw invocation failed',
    });
  }
});

app.post('/v1/generate-pdf', verifyBearer, verifyHmac, async (req, res) => {
  try {
    const result = await invokeOpenClaw(req.body, 'generate-pdf');
    return res.status(200).json({
      status: 'ok',
      file_path: result.file_path || result.path,
      summary: result.summary,
    });
  } catch (err) {
    return res.status(502).json({
      status: 'error',
      error_code: 'OPENCLAW_ERROR',
      message: err.message,
    });
  }
});

app.get('/v1/report', verifyBearer, async (req, res) => {
  const { name, from, to, company } = req.query;
  if (!name) {
    return res.status(400).json({
      status: 'error',
      error_code: 'INVALID_BODY',
      message: 'Query param name is required',
    });
  }

  try {
    const result = await invokeOpenClaw(
      { action: 'report', name, from, to, company },
      'post-voucher'
    );
    return res.status(200).json(result);
  } catch (err) {
    return res.status(502).json({
      status: 'error',
      error_code: 'OPENCLAW_ERROR',
      message: err.message,
    });
  }
});

async function tallyReachable() {
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 5000);
    const r = await fetch(TALLY_URL, { signal: controller.signal });
    clearTimeout(t);
    const text = await r.text();
    return text.includes('Running') || r.ok;
  } catch {
    return false;
  }
}

app.listen(PORT, () => {
  console.log(`tally-bridge listening on :${PORT}`);
  console.log(`TALLY_URL=${TALLY_URL} OPENCLAW_MODE=${process.env.OPENCLAW_MODE || 'cli'}`);
});
