// Builds the Practice Writer as a claude.ai Artifact page.
//
// The Artifact host wraps the page in its own <!doctype><html><head><body>
// skeleton, so the page file holds only a <title>, styles and the body
// content. Stylesheets and scripts are published next to it unchanged.
//
//   node scripts/build-artifact.mjs            → dist/practice-artifact.html
//   node scripts/build-artifact.mjs --files    → also prints the files map
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(join(root, 'practice.html'), 'utf8');

const title = html.match(/<title>[\s\S]*?<\/title>/)[0];
const body = html.match(/<body[^>]*>([\s\S]*)<\/body>/)[1].trim();
const sheets = [...html.matchAll(/<link rel="stylesheet" href="([^"]+)">/g)].map((m) => m[1]);

// Host-specific layout: the host pads :root by the safe-area insets, so the
// sticky bar sits at the inset and a fixed band paints the area above it.
const hostCss = `<style>
.topbar { top: env(safe-area-inset-top, 0px); padding-top: 12px; }
body::before { content: ""; position: fixed; inset: 0 0 auto; height: env(safe-area-inset-top, 0px); z-index: 10; background: var(--bg); }
</style>`;

const page = [
  title,
  '<meta name="description" content="Daily swim practices from the season plan and gear chart, with a coach to text, debriefs and learning.">',
  ...sheets.map((h) => `<link rel="stylesheet" href="${h}">`),
  hostCss,
  '<script>window.PW_ARTIFACT = 1;</script>',
  body,
  '',
].join('\n');

mkdirSync(join(root, 'dist'), { recursive: true });
writeFileSync(join(root, 'dist/practice-artifact.html'), page);

// Only what the page loads: stylesheets plus every module reachable from the
// entry script through static imports.
const files = {};
for (const s of sheets) files[s] = s;
const seen = new Set();
const visit = (rel) => {
  if (seen.has(rel)) return;
  seen.add(rel);
  files[rel] = rel;
  const src = readFileSync(join(root, rel), 'utf8');
  for (const m of src.matchAll(/(?:^|\n)\s*(?:import|export)\s[^;]*?from\s+['"](\.[^'"]+)['"]/g)) visit(posix.normalize(posix.join(posix.dirname(rel), m[1])));
  for (const m of src.matchAll(/(?:^|\n)\s*import\s+['"](\.[^'"]+)['"]/g)) visit(posix.normalize(posix.join(posix.dirname(rel), m[1])));
};
visit('src/practice-app.js');
files['icon.svg'] = 'icon.svg';
if (process.argv.includes('--files')) console.log(JSON.stringify(files, null, 2));
console.log(`wrote dist/practice-artifact.html (${page.length} bytes), ${Object.keys(files).length} supporting files`);
