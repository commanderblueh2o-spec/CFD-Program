// Bundles the ES modules into one self-contained HTML file (no dependencies, works
// from file:// and from GitHub Pages). Output: dist/coatsim.html and docs/index.html.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const pkg = JSON.parse(read('package.json'));

const CORE = ['materials', 'physics', 'geometry', 'linalg', 'metrics', 'film', 'processes', 'presets', 'compare'].map((m) => `src/core/${m}.js`);
const UI = ['colormap', 'schema', 'charts', 'heatmap', 'view3d', 'app'].map((m) => `src/ui/${m}.js`);

function bundle(files, seen = new Set()) {
  let out = '';
  for (const f of files) {
    let src = read(f);
    const names = [];
    src = src.replace(/^export\s+(async\s+)?(function|class|const|let|var)\s+([A-Za-z_$][\w$]*)/gm, (m, a, kind, name) => { names.push(name); return `${a || ''}${kind} ${name}`; });
    if (/^\s*export\s/m.test(src)) throw new Error(`${f}: unsupported export form`);
    src = src.replace(/^\s*import\s[^;]*;\s*$/gm, '');
    for (const n of names) { if (seen.has(n)) throw new Error(`duplicate export ${n} in ${f}`); seen.add(n); }
    out += `// ---- ${f}\nconst { ${names.join(', ')} } = (() => {\n${src}\nreturn { ${names.join(', ')} };\n})();\n`;
  }
  return out;
}

const core = bundle(CORE);
const workerSrc = `'use strict';\n${core}\n${bundle(['src/worker.js'], new Set(core.match(/const \{ ([^}]*) \}/g).flatMap((l) => l.slice(8, -2).split(', '))))}`;
let app = `'use strict';\nconst WORKER_SRC = ${JSON.stringify(workerSrc)};\n${core}\n${bundle(UI, new Set(core.match(/const \{ ([^}]*) \}/g).flatMap((l) => l.slice(8, -2).split(', '))))}`;
app = app.replace("const VERSION = '1.0.0';", `const VERSION = '${pkg.version}';`);
app = app.replace('/*WORKER_CREATE*/', "worker = new Worker(URL.createObjectURL(new Blob([WORKER_SRC], { type: 'text/javascript' })));");
app = app.replace(/<\/script/gi, '<\\/script');
let html = read('src/ui/index.html');
html = html.replace('/*CSS*/', () => read('src/ui/styles.css'));
html = html.replace('/*APP*/', () => app);
fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
fs.writeFileSync(path.join(root, 'dist/coatsim.html'), html);
fs.writeFileSync(path.join(root, 'docs/index.html'), html);
console.log(`built dist/coatsim.html and docs/index.html (${(html.length / 1024).toFixed(0)} kB), v${pkg.version}`);
