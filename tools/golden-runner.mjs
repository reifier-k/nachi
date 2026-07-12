import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const pages = [
  'golden-explosion',
  'golden-ambient',
  'golden-slash',
  'golden-charge',
  'golden-character',
  'golden-fluid',
  'golden-ultimate',
];
const baseUrl = new URL(process.env.GOLDEN_BASE_URL ?? 'http://127.0.0.1:5173/');
const runner = new URL('./spike-runner.mjs', import.meta.url);
const distDirectory = process.env.GOLDEN_DIST ? path.resolve(process.env.GOLDEN_DIST) : undefined;

function run(page) {
  const url = new URL(`${page}/`, baseUrl);
  return new Promise((resolve) => {
    const arguments_ = [fileURLToPath(runner), url.toString(), '--adapter', 'swiftshader'];
    if (distDirectory) arguments_.push('--dist', distDirectory);
    const child = spawn(process.execPath, arguments_, {
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.once('error', (error) => {
      resolve({ error: error.message, ok: false, page });
    });
    child.once('exit', (code, signal) => {
      let result;
      for (const line of stdout.trim().split('\n').reverse()) {
        try {
          result = JSON.parse(line);
          break;
        } catch {
          // Browser/driver output may precede the runner's final one-line JSON result.
        }
      }
      if (result === undefined) {
        result = {
          error: `Runner produced invalid JSON (exit ${code ?? signal ?? 'unknown'}).`,
          stdout: stdout.trim(),
        };
      }
      resolve({
        ...result,
        ok: code === 0 && result?.ok === true,
        page,
        ...(stderr.trim() === '' ? {} : { stderr: stderr.trim() }),
      });
    });
  });
}

const results = [];
for (const page of pages) {
  process.stdout.write(`[golden] ${page} ... `);
  const result = await run(page);
  results.push(result);
  console.log(result.ok ? 'PASS' : `FAIL: ${result.error ?? 'validation failed'}`);
}

const failures = results.filter(({ ok }) => !ok);
const summary = {
  baseUrl: baseUrl.toString(),
  ...(distDirectory === undefined ? {} : { distDirectory }),
  failed: failures.map(({ error, page, stderr }) => ({
    error: error ?? 'validation failed',
    page,
    ...(stderr === undefined ? {} : { stderr }),
  })),
  passed: results.filter(({ ok }) => ok).map(({ page }) => page),
  total: results.length,
};
console.log(JSON.stringify(summary, null, 2));
if (failures.length > 0) process.exitCode = 1;
