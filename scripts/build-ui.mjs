import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const UI_SRC_DIR = path.join(ROOT_DIR, 'ui', 'src');
const UI_DIST_DIR = path.join(ROOT_DIR, 'ui', 'dist');
const TEMPLATE_PATH = path.join(UI_SRC_DIR, 'template.html');
const ENTRY_JS_PATH = path.join(UI_SRC_DIR, 'main.js');
const ENTRY_CSS_PATH = path.join(UI_SRC_DIR, 'styles.css');
const OUT_HTML_PATH = path.join(UI_DIST_DIR, 'monitor.html');

const [jsResult, cssResult] = await Promise.all([
  esbuild.build({
    entryPoints: [ENTRY_JS_PATH],
    bundle: true,
    write: false,
    format: 'iife',
    platform: 'browser',
    target: 'es2022',
    minify: true,
    legalComments: 'none',
  }),
  esbuild.build({
    entryPoints: [ENTRY_CSS_PATH],
    bundle: true,
    write: false,
    minify: true,
    legalComments: 'none',
  }),
]);

const template = readFileSync(TEMPLATE_PATH, 'utf8');
const bundledJs = jsResult.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
const bundledCss = cssResult.outputFiles[0].text.replace(/<\/style/gi, '<\\/style');

if (!template.includes('<!--INLINE_CSS-->') || !template.includes('<!--INLINE_JS-->')) {
  throw new Error('ui/src/template.html must contain <!--INLINE_CSS--> and <!--INLINE_JS--> markers');
}

const html = template
  .replace('<!--INLINE_CSS-->', () => `<style>\n${bundledCss}\n</style>`)
  .replace('<!--INLINE_JS-->', () => `<script>\n${bundledJs}\n</script>`);

mkdirSync(UI_DIST_DIR, { recursive: true });
writeFileSync(OUT_HTML_PATH, html, 'utf8');

const sizeKb = (Buffer.byteLength(html, 'utf8') / 1024).toFixed(1);
console.log(`Built ${path.relative(ROOT_DIR, OUT_HTML_PATH)} (${sizeKb} KB)`);
