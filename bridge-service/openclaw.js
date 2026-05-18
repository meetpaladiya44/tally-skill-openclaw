'use strict';

const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);

/**
 * Invoke Instance B OpenClaw with tally-skill to process bridge JSON.
 * @param {object} payload - Canonical voucher JSON
 * @param {'post-voucher'|'generate-pdf'} action
 * @returns {Promise<object>}
 */
async function invokeOpenClaw(payload, action = 'post-voucher') {
  const mode = (process.env.OPENCLAW_MODE || 'cli').toLowerCase();

  if (mode === 'http') {
    return invokeHttp(payload, action);
  }
  return invokeCli(payload, action);
}

async function invokeCli(payload, action) {
  const bin = process.env.OPENCLAW_CLI || 'openclaw';
  const skill = process.env.OPENCLAW_SKILL || 'tally-prime-ca';
  const input =
    action === 'post-voucher'
      ? `Post this voucher to Tally exactly as given. Do not invent fields. Return JSON only with status, guid, voucher_number, company, summary, masters_created. Payload:\n${JSON.stringify(payload)}`
      : `Generate PDF using tallyca per tally-skill. Request:\n${JSON.stringify(payload)}`;

  const { stdout, stderr } = await execFileAsync(
    bin,
    ['run', '--skill', skill, '--input', input],
    {
      env: process.env,
      timeout: 120000,
      maxBuffer: 10 * 1024 * 1024,
    }
  );

  if (stderr && !stdout) {
    throw new Error(stderr.slice(0, 500));
  }

  return parseAgentJson(stdout);
}

async function invokeHttp(payload, action) {
  const base = process.env.OPENCLAW_HTTP_URL;
  if (!base) {
    throw new Error('OPENCLAW_HTTP_URL is required when OPENCLAW_MODE=http');
  }

  const body = {
    skill: process.env.OPENCLAW_SKILL || 'tally-prime-ca',
    input:
      action === 'post-voucher'
        ? { action: 'post-voucher', payload }
        : { action: 'generate-pdf', ...payload },
  };

  const res = await fetch(base, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120000),
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`OpenClaw HTTP ${res.status}: ${text.slice(0, 300)}`);
  }

  return parseAgentJson(text);
}

function parseAgentJson(text) {
  const trimmed = (text || '').trim();
  if (!trimmed) {
    return { status: 'error', error_code: 'OPENCLAW_ERROR', message: 'Empty response from OpenClaw' };
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

  return {
    status: 'posted',
    summary: trimmed.slice(0, 500),
    raw: trimmed,
  };
}

module.exports = { invokeOpenClaw };
