// Publish guard — the last line before anything reaches a public URL.
//
// Ported from v1's check-fixtures.mjs and kept SHAPE-based on purpose: a
// denylist of real names/hostnames would have to spell out the very things
// we are keeping out of a public repo, which would be the leak it is meant
// to prevent. So we assert what content may look like, never what it may
// not say.
//
//   node guard.mjs <dir>            scan a generator output directory
//   (P6 adds a second caller that scans the SEEDED DATABASE — clean input
//    does not prove clean derived data, because summaries/facts/entities
//    are LLM-written and can hallucinate real-sounding names.)
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

// RFC 2606 reserved documentation domains, and nothing else.
const ALLOWED_EMAIL_DOMAIN = /^(?:[a-z0-9-]+\.)*example\.(?:com|org|net)$/i;
const ALLOWED_URL_HOST = /^(?:(?:[a-z0-9-]+\.)*example\.(?:com|org|net)|localhost|127\.0\.0\.1)$/i;

const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
const URL_RE = /\bhttps?:\/\/([a-z0-9.-]+)/gi;
// RFC1918 + link-local + shared address space
const PRIVATE_IP_RE = /\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|169\.254\.\d{1,3}\.\d{1,3}|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3})\b/g;
// Credential shapes that must never appear in demo content
const SECRET_RE = /\b(?:sk-[a-zA-Z0-9]{16,}|ghp_[a-zA-Z0-9]{20,}|AKIA[0-9A-Z]{12,}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/g;

export function scanText(text, where, findings) {
  for (const m of text.matchAll(EMAIL_RE)) {
    const domain = m[0].split('@')[1];
    if (!ALLOWED_EMAIL_DOMAIN.test(domain)) findings.push({ where, kind: 'email', value: m[0] });
  }
  for (const m of text.matchAll(URL_RE)) {
    if (!ALLOWED_URL_HOST.test(m[1])) findings.push({ where, kind: 'url-host', value: m[1] });
  }
  for (const m of text.matchAll(PRIVATE_IP_RE)) findings.push({ where, kind: 'private-ip', value: m[0] });
  for (const m of text.matchAll(SECRET_RE)) findings.push({ where, kind: 'credential-shape', value: m[0].slice(0, 12) + '…' });
  return findings;
}

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out); else out.push(p);
  }
  return out;
}

export function scanDir(dir) {
  const findings = [];
  for (const p of walk(dir)) {
    // Binary formats: scan the extractable text we recorded, not the bytes
    // (a PNG's pixel data is noise and would false-positive forever).
    if (/\.(png|pdf|xlsx|docx)$/i.test(p)) continue;
    let text;
    try { text = readFileSync(p, 'utf8'); } catch { continue; }
    scanText(text, p.replace(dir, '').replace(/^\//, ''), findings);
  }
  return findings;
}

function main() {
  const dir = process.argv[2];
  if (!dir) { console.error('usage: node guard.mjs <dir>'); process.exit(2); }
  const findings = scanDir(dir);
  if (findings.length) {
    console.error(`✗ publish guard: ${findings.length} finding(s)\n`);
    for (const f of findings.slice(0, 50)) console.error(`  [${f.kind}] ${f.value}  ← ${f.where}`);
    if (findings.length > 50) console.error(`  … and ${findings.length - 50} more`);
    console.error('\nNothing may be published while findings stand.');
    process.exit(1);
  }
  console.log('✓ publish guard clean — all emails RFC 2606, no foreign URL hosts, no private IPs, no credential shapes');
}

if (import.meta.url === `file://${process.argv[1]}`) main();
