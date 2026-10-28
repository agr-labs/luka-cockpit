#!/usr/bin/env node
// Assemble the static deployable site into dist/.
//
// The runtime needs the generated model and the recordings, but NOT the source
// STLs, the MJCF, or the URDF — those are build inputs and would add 15 MB to
// every deploy for no benefit.
//
// Fails loudly if any single file exceeds Cloudflare Pages' 25 MiB per-asset limit.

import { cp, mkdir, rm, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DIST = join(ROOT, 'dist');

const FILES = [
  'index.html',
  'styles.css',
  'README.md',
];
const DIRS = [
  'src',
  'config',
  'docs',
  'model/generated',
  'model/recordings',
];
const MODEL_DOCS = [
  'model/PROVENANCE.md',
  'model/BUILD_REPORT.md',
  'model/LICENSE-MulanPSL2',
  'model/measurements.csv',
];

const PAGES_MAX_BYTES = 25 * 1024 * 1024;

async function walk(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await walk(p));
    else if (entry.isFile()) out.push(p);
  }
  return out;
}

async function main() {
  await rm(DIST, { recursive: true, force: true });
  await mkdir(DIST, { recursive: true });

  for (const f of FILES) await cp(join(ROOT, f), join(DIST, f));

  // Stamp the build so the page knows it is static without probing (a failed
  // /api/health probe would log a 404 in every visitor's console).
  const indexPath = join(DIST, 'index.html');
  const html = await readFile(indexPath, 'utf8');
  await writeFile(
    indexPath,
    html.replace('<meta charset="utf-8" />',
      '<meta charset="utf-8" />\n<meta name="luka-env" content="static" />'),
  );
  for (const d of DIRS) await cp(join(ROOT, d), join(DIST, d), { recursive: true });
  for (const f of MODEL_DOCS) {
    try { await cp(join(ROOT, f), join(DIST, f)); } catch { /* optional */ }
  }

  // Cloudflare Pages headers. The app shell must revalidate; the big immutable
  // payloads can be cached hard because every deploy publishes new content.
  await writeFile(join(DIST, '_headers'), [
    '/*',
    '  X-Content-Type-Options: nosniff',
    '',
    '/model/generated/*',
    '  Cache-Control: public, max-age=86400',
    '',
    '/model/recordings/*',
    '  Cache-Control: public, max-age=86400',
    '',
    '/*.html',
    '  Cache-Control: no-cache',
    '',
  ].join('\n'));

  // Report
  const files = await walk(DIST);
  let total = 0;
  const rows = [];
  for (const f of files) {
    const st = await stat(f);
    total += st.size;
    rows.push({ path: relative(DIST, f), size: st.size });
  }
  rows.sort((a, b) => b.size - a.size);

  const mb = (n) => `${(n / 1e6).toFixed(2)} MB`;
  console.log(`\ndist/ · ${files.length} files · ${mb(total)}\n`);
  console.log('largest:');
  for (const r of rows.slice(0, 6)) console.log(`  ${mb(r.size).padStart(10)}  ${r.path}`);

  const oversized = rows.filter((r) => r.size > PAGES_MAX_BYTES);
  if (oversized.length) {
    console.error('\nFAIL: exceeds Cloudflare Pages 25 MiB per-asset limit:');
    for (const r of oversized) console.error(`  ${r.path} (${mb(r.size)})`);
    process.exit(1);
  }
  const headroom = PAGES_MAX_BYTES - rows[0].size;
  console.log(`\nheadroom under the 25 MiB per-asset limit: ${mb(headroom)} (largest file ${rows[0].path})`);
  console.log('sim build: no /api, so the page boots in SIM mode by design.\n');
}

main().catch((err) => { console.error(err); process.exit(1); });
