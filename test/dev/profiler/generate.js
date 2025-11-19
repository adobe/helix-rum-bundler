#!/usr/bin/env node
/* eslint-disable */
import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PROFILER_DIR = __dirname;
const TEMPLATE_FILE = path.join(PROFILER_DIR, 'index.template.html');
const OUTPUT_FILE = path.join(PROFILER_DIR, 'index.html');

function parseArgs(argv) {
  const args = { file: null };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if ((a === '-f' || a === '--file') && i + 1 < argv.length) {
      args.file = argv[i + 1];
      i += 1;
    }
  }
  return args;
}

async function findLatestMemoryJson() {
  const entries = await fs.readdir(PROFILER_DIR);
  const files = entries
    .filter((f) => /^memory-.*\.json$/.test(f))
    .map((f) => path.join(PROFILER_DIR, f));
  if (files.length === 0) {
    return null;
  }
  const stats = await Promise.all(files.map(async (fp) => {
    const st = await fs.stat(fp);
    return { fp, mtime: st.mtimeMs };
  }));
  stats.sort((a, b) => b.mtime - a.mtime);
  return stats[0].fp;
}

async function readLoops(jsonPath) {
  const raw = await fs.readFile(jsonPath, 'utf-8');
  const data = JSON.parse(raw);
  if (!Array.isArray(data)) {
    throw new Error(`Expected array of loops in ${jsonPath}`);
  }
  // Ensure each item is an array (loop)
  return data.map((loop) => Array.isArray(loop) ? loop : []);
}

function injectEmbeddedData(html, payload) {
  const json = JSON.stringify(payload);
  const script = `<script id="embedded-memory-data" type="application/json">${json}</script>`;
  const placeholder = '<!-- __EMBEDDED_MEMORY_DATA__ -->';
  if (html.includes(placeholder)) {
    return html.replace(placeholder, script);
  }
  // Fallback: inject before closing body
  if (html.includes('</body>')) {
    return html.replace('</body>', `${script}\n</body>`);
  }
  return `${html}\n${script}\n`;
}

async function main() {
  const args = parseArgs(process.argv);
  const sourceFile = args.file
    ? path.resolve(process.cwd(), args.file)
    : await findLatestMemoryJson();

  if (!sourceFile) {
    // eslint-disable-next-line no-console
    console.error('No memory-*.json found. Provide a file with --file path/to/memory-*.json');
    process.exit(1);
  }

  const loops = await readLoops(sourceFile);
  const template = await fs.readFile(TEMPLATE_FILE, 'utf-8');

  const payload = {
    generatedAt: new Date().toISOString(),
    sourceFile: path.relative(PROFILER_DIR, sourceFile),
    loops,
  };

  const out = injectEmbeddedData(template, payload);
  await fs.writeFile(OUTPUT_FILE, out, 'utf-8');

  // eslint-disable-next-line no-console
  console.log(`Generated ${path.relative(process.cwd(), OUTPUT_FILE)} from ${path.relative(process.cwd(), sourceFile)}`);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});


