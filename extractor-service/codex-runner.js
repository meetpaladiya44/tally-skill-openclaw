'use strict';

const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const execFileAsync = promisify(execFile);

const DEFAULT_SCHEMA_HINT = JSON.stringify(
  {
    party: '',
    party_gstin: '',
    company_gstin: '',
    invoice_no: '',
    date: 'YYYY-MM-DD',
    voucher_type: 'Purchase|Sales|Receipt|Payment|Journal|CreditNote|DebitNote',
    items: [
      {
        description: '',
        hsn: '',
        qty: 0,
        unit: '',
        rate: 0,
        tax_rate: 0,
        amount: 0,
      },
    ],
    cgst: 0,
    sgst: 0,
    igst: 0,
    taxable_amount: 0,
    total: 0,
    narration: '',
    confidence: { overall: 0, fields: {} },
  },
  null,
  2
);

const DEFAULT_PROMPT =
  'Extract all invoice or bill fields from the attached document image(s). Return ONLY valid JSON matching the schema. Include per-field confidence 0-1 in confidence.fields. Do not invent values; use null for missing fields.';

/**
 * Check whether Codex CLI appears logged in (auth file present).
 */
function isCodexLoggedIn() {
  const home = os.homedir();
  const candidates = [
    path.join(home, '.codex', 'auth.json'),
    path.join(home, '.config', 'codex', 'auth.json'),
  ];
  return candidates.some((p) => {
    try {
      return fs.statSync(p).isFile();
    } catch {
      return false;
    }
  });
}

/**
 * Convert PDF pages to PNG files via pdftoppm.
 * @param {string} pdfPath
 * @param {string} outDir
 * @param {number} maxPages
 * @returns {Promise<string[]>}
 */
async function pdfToPngPaths(pdfPath, outDir, maxPages) {
  const pdftoppm = process.env.PDFTOPPM_BIN || 'pdftoppm';
  const prefix = path.join(outDir, 'page');
  await execFileAsync(pdftoppm, ['-png', '-f', '1', '-l', String(maxPages), pdfPath, prefix], {
    timeout: 60000,
  });

  const files = fs
    .readdirSync(outDir)
    .filter((f) => f.startsWith('page') && f.endsWith('.png'))
    .sort()
    .map((f) => path.join(outDir, f));

  if (files.length === 0) {
    throw new Error('PDF conversion produced no PNG pages. Install poppler-utils (pdftoppm).');
  }
  return files;
}

/**
 * Parse JSON from Codex output file or stdout.
 * @param {string} text
 * @returns {object}
 */
function parseExtractedJson(text) {
  const trimmed = (text || '').trim();
  if (!trimmed) {
    return { raw_text: '', parse_error: 'Empty Codex response' };
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    const match = trimmed.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        return JSON.parse(match[0]);
      } catch {
        /* fall through */
      }
    }
  }

  return { raw_text: trimmed.slice(0, 8000), parse_error: 'Could not parse JSON from Codex output' };
}

/**
 * Run Codex CLI with image(s) and return structured extraction.
 * @param {object} params
 * @param {string[]} params.imagePaths - Absolute paths to PNG/JPEG/WebP/GIF
 * @param {string} [params.prompt]
 * @param {string} [params.schemaHint]
 * @param {string} [params.requestId]
 * @returns {Promise<{ extracted: object, raw: string, model: string, pages: number }>}
 */
async function runCodex({ imagePaths, prompt, schemaHint, requestId }) {
  if (!imagePaths || imagePaths.length === 0) {
    throw new Error('At least one image path is required for Codex extraction');
  }

  const bin = process.env.CODEX_BIN || 'codex';
  const model = process.env.CODEX_MODEL || 'gpt-5';
  const reqId = requestId || `req-${Date.now()}`;
  const outFile = path.join(os.tmpdir(), `codex-out-${reqId.replace(/[^a-zA-Z0-9_-]/g, '_')}.txt`);

  const schema = schemaHint || DEFAULT_SCHEMA_HINT;
  const userPrompt = prompt || DEFAULT_PROMPT;
  const fullPrompt = `${userPrompt}\n\nSchema:\n${schema}\n\nReturn ONLY valid JSON, no markdown fences or prose.`;

  const imageArg = imagePaths.join(',');
  const args = ['exec'];
  if (model) {
    args.push('--model', model);
  }
  args.push('--image', imageArg, '-o', outFile, fullPrompt);

  try {
    await execFileAsync(bin, args, {
      env: process.env,
      timeout: 120000,
      maxBuffer: 20 * 1024 * 1024,
    });
  } catch (err) {
    const msg = err.stderr?.toString() || err.stdout?.toString() || err.message;
    throw new Error(`Codex CLI failed: ${String(msg).slice(0, 500)}`);
  }

  let raw = '';
  if (fs.existsSync(outFile)) {
    raw = fs.readFileSync(outFile, 'utf8');
    try {
      fs.unlinkSync(outFile);
    } catch {
      /* ignore */
    }
  }

  const extracted = parseExtractedJson(raw);

  return {
    extracted,
    raw: raw.slice(0, 50000),
    model,
    pages: imagePaths.length,
  };
}

/**
 * Prepare image paths from uploaded file buffer/path.
 * @param {object} file - multer file { path, mimetype, originalname }
 * @param {string} workDir - temp directory for this request
 * @returns {Promise<string[]>}
 */
async function prepareImagePaths(file, workDir) {
  const maxPages = Number(process.env.MAX_PAGES || 10);
  const mime = (file.mimetype || '').toLowerCase();

  if (mime === 'application/pdf') {
    return pdfToPngPaths(file.path, workDir, maxPages);
  }

  const allowed = ['image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'image/gif'];
  if (allowed.includes(mime) || /\.(png|jpe?g|webp|gif)$/i.test(file.originalname || '')) {
    return [file.path];
  }

  throw new Error(`Unsupported file type: ${mime || file.originalname}. Use PDF, PNG, JPEG, WebP, or GIF.`);
}

module.exports = {
  runCodex,
  prepareImagePaths,
  isCodexLoggedIn,
  DEFAULT_SCHEMA_HINT,
  DEFAULT_PROMPT,
};
