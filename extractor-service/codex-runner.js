'use strict';

const { execFile, spawn } = require('node:child_process');
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
 * Run a command with prompt on stdin (Codex reads instructions when argv ends with `-`).
 * @param {string} bin
 * @param {string[]} args
 * @param {string} stdinText
 * @param {number} timeoutMs
 * @returns {Promise<{ stdout: string, stderr: string, code: number }>}
 */
function spawnWithStdin(bin, args, stdinText, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGTERM');
      reject(new Error(`Codex CLI timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, code: code ?? 1 });
    });

    child.stdin.write(stdinText);
    child.stdin.end();
  });
}

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
 * @param {string} [params.workDir]
 * @returns {Promise<{ extracted: object, raw: string, model: string, pages: number }>}
 */
async function runCodex({ imagePaths, prompt, schemaHint, requestId, workDir }) {
  if (!imagePaths || imagePaths.length === 0) {
    throw new Error('At least one image path is required for Codex extraction');
  }

  const bin = process.env.CODEX_BIN || 'codex';
  const model = process.env.CODEX_MODEL || 'gpt-5';
  const timeoutMs = Number(process.env.CODEX_TIMEOUT_MS || 180000);
  const reqId = requestId || `req-${Date.now()}`;
  const absWorkDir = workDir ? path.resolve(workDir) : null;
  const baseDir = absWorkDir || os.tmpdir();
  const outFile = path.join(baseDir, `codex-out-${reqId.replace(/[^a-zA-Z0-9_-]/g, '_')}.txt`);
  const absImages = imagePaths.map((p) => path.resolve(p));

  const schema = schemaHint || DEFAULT_SCHEMA_HINT;
  const userPrompt = prompt || DEFAULT_PROMPT;
  const fullPrompt = `${userPrompt}\n\nSchema:\n${schema}\n\nReturn ONLY valid JSON, no markdown fences or prose.`;

  if (absWorkDir) {
    try {
      fs.writeFileSync(path.join(absWorkDir, 'prompt.txt'), fullPrompt, 'utf8');
    } catch {
      /* ignore */
    }
  }

  const args = ['exec', '--skip-git-repo-check', '-s', 'workspace-write'];
  const extraParts = (process.env.CODEX_EXTRA_ARGS || '').split(/\s+/).filter(Boolean);
  const hasSandboxOverride =
    extraParts.some((p) => p === '-s') ||
    extraParts.some((p) => p.startsWith('--sandbox')) ||
    extraParts.some((p) => p.includes('bypass-approvals'));
  if (hasSandboxOverride) {
    args.pop();
    args.pop(); // drop default -s workspace-write
  }
  if (extraParts.length) {
    args.push(...extraParts);
  }
  if (absWorkDir) {
    args.push('--cd', absWorkDir);
  }
  if (model) {
    args.push('--model', model);
  }
  for (const img of absImages) {
    args.push('-i', img);
  }
  args.push('-o', outFile, '-');

  const logArgs = args.filter((a) => a !== '-').slice(0, 14).join(' ');
  console.error(`[codex] starting: ${bin} ${logArgs} ... (prompt on stdin) -> ${outFile}`);

  let stdout = '';
  let stderr = '';
  try {
    const result = await spawnWithStdin(bin, args, fullPrompt, timeoutMs);
    stdout = result.stdout;
    stderr = result.stderr;
    if (result.code !== 0) {
      const msg = stderr || stdout || `exit code ${result.code}`;
      console.error(`[codex] failed: ${String(msg).slice(0, 300)}`);
      throw new Error(`Codex CLI failed: ${String(msg).slice(0, 500)}`);
    }
  } catch (err) {
    if (!err.message?.includes('Codex CLI failed')) {
      console.error(`[codex] failed: ${String(err.message).slice(0, 300)}`);
    }
    throw err;
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
  if (!raw.trim() && stdout.trim()) {
    raw = stdout;
    console.error('[codex] used stdout fallback (output file was empty)');
  }

  if (!raw.trim()) {
    console.error(
      `[codex] empty output; outFile=${outFile} exists=${fs.existsSync(outFile)} stderr=${stderr.slice(0, 200)}`
    );
  } else {
    console.error(`[codex] finished, ${raw.length} chars from Codex`);
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
  parseExtractedJson,
  DEFAULT_SCHEMA_HINT,
  DEFAULT_PROMPT,
};
