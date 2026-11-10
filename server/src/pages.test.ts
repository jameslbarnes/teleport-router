import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Every page is one product: one stylesheet, colours and typefaces by name, nothing fetched from
 * another site, and every file a page needs is in the image. These checks keep it that way.
 */
const root = (path = '') => fileURLToPath(new URL(`../../${path}`, import.meta.url));
const read = (path: string) => readFileSync(root(path), 'utf8');

const dockerfile = read('Dockerfile');
// Files the image copies from the repository root into /app/.
const shipped = [...dockerfile.matchAll(/^COPY (?!--from)(.+) \/app\/$/gm)].flatMap(m => m[1].split(/\s+/)).filter(f => !f.endsWith('/'));
const pages = shipped.filter(f => f.endsWith('.html'));
const home = ['web/src/pages/index.astro', 'web/src/pages/index-body.partial.html'];
const styled = [...pages, ...home, 'group-setup.css', 'router.css', 'web/public/styles/index.css', 'sharing-notice.js'];

const COLOUR = /#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/g;
/** Colour literals outside the place they are defined, ignoring SVG paint in markup and HTML entities. */
function strayColours(path: string): string[] {
  let text = read(path);
  if (path === 'router.css') text = text.replace(/:root\s*\{[^}]*\}/g, ''); // the one place colours are named
  text = text.replace(/&#\d+;|&#x[0-9a-f]+;/gi, '').replace(/href="#[^"]*"/g, '').replace(/url\(#[^)]*\)/g, '');
  return [...text.matchAll(COLOUR)].map(m => m[0]).filter(c => !/^#(?:[a-z-]+)$/i.test(c) || /^#[0-9a-f]{3,8}$/i.test(c));
}

describe('pages', () => {
  it('ship every file the image names', () => {
    for (const file of shipped) expect(existsSync(root(file)), file).toBe(true);
    for (const dir of ['vendor', 'assets/fonts']) expect(existsSync(root(dir)), dir).toBe(true);
    expect(pages.length).toBeGreaterThan(10);
  });

  it('are in the image if the server routes to them', () => {
    const http = read('server/src/http.ts');
    const routed = http.match(/\[('\/[a-z-]+'(?:, )?)+\]\.includes\(filePath\)/)![0].match(/'\/[a-z-]+'/g)!.map(s => s.slice(2, -1));
    for (const name of routed) expect(shipped, `/${name}`).toContain(`${name}.html`);
    for (const name of ['group-setup', 'join', 'profile', 'entry']) expect(shipped).toContain(`${name}.html`);
  });

  it('share one stylesheet, one icon and a description', () => {
    for (const page of [...pages, home[0]]) {
      const html = read(page);
      expect(html, page).toMatch(/<link rel="stylesheet" href="\/router\.css\?v=\d+"/);
      expect(html, page).toMatch(/<link rel="icon" href="\/favicon\.svg"/);
      expect(html, page).toMatch(/<meta name="description" content="[^"]{20,}"/);
      expect(html, page).toMatch(/<title>[^<]+<\/title>/);
      // The shared sheet comes first, so a page can only add to it.
      const own = html.search(/<style|<link rel="stylesheet" href="\/(?!router\.css)/);
      if (own >= 0) expect(html.indexOf('/router.css'), page).toBeLessThan(own);
    }
  });

  it('take colours and typefaces from the shared tokens only', () => {
    for (const file of styled) {
      expect(strayColours(file), file).toEqual([]);
      if (file !== 'router.css') expect(read(file), file).not.toMatch(/font-family:\s*(?!\s|var\(|inherit)/);
    }
  });

  it('keep a visible focus ring and readable sizes', () => {
    for (const file of styled) {
      const text = read(file);
      expect(text, file).not.toMatch(/outline:\s*(none|0)\b/);
      const tooSmall = [...text.matchAll(/font-size:\s*(0?\.\d+)rem/g)].map(m => Number(m[1])).filter(n => n < 0.75);
      expect(tooSmall, file).toEqual([]);
    }
  });

  it('ask no other site for anything', () => {
    for (const page of [...pages, ...home]) {
      const html = read(page);
      const loads = [...html.matchAll(/<(?:script|link|img|iframe)\b[^>]*\b(?:src|href)="(https?:)?\/\/[^"]+"[^>]*>/g)].map(m => m[0])
        .filter(tag => !/^<link rel="canonical"/.test(tag));
      expect(loads, page).toEqual([]);
      expect(html, page).not.toContain('fonts.googleapis.com');
    }
  });

  it('use one word per thing in what people read', () => {
    for (const page of [...pages, home[1]]) {
      // Visible text only: drop scripts, styles, tags and attribute values.
      const visible = read(page).replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, '').replace(/<[^>]+>/g, ' ');
      for (const [word, instead] of [[/\bidentity key\b/i, 'Router key'], [/\bsecret key\b/i, 'Router key'], [/\bjournal\b/i, 'notebook'],
        [/\bClaudes\b/, 'agents'], [/\blogged in\b/i, 'signed in'], [/\bbuffer time\b/i, 'wait before publishing']] as const) {
        expect(visible, `${page}: say "${instead}"`).not.toMatch(word);
      }
    }
  });
});
