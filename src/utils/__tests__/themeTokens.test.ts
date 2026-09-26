/// <reference types="node" />
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// Every stylesheet and component under src/. Read with node:fs rather than `?raw` like
// safeMode.test.ts: Vitest does not process CSS, and `import.meta.glob` of a .css file comes back
// EMPTY — which would make every token look undefined, or (worse) every check vacuous.
const SRC = join(__dirname, '..', '..');
const files: [string, string][] = (readdirSync(SRC, { recursive: true }) as string[])
  .filter((f) => /\.(css|ts|tsx)$/.test(f) && !f.includes('__tests__'))
  .map((f) => [f.replace(/\\/g, '/'), withoutComments(readFileSync(join(SRC, f), 'utf8'))]);

/** Comments may name a token to explain it — `/* … *\/` blocks and whole `//` lines are dropped. */
function withoutComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/** Custom properties some source defines: `--x:` in a stylesheet, `'--x':` in a style object. */
function definedTokens(): Set<string> {
  const out = new Set<string>();
  for (const [file, text] of files) {
    const re = file.endsWith('.css')
      ? /(--[A-Za-z0-9-]+)\s*:/g
      : /['"`](--[A-Za-z0-9-]+)['"`]\s*(?:as\s+string\s*\])?\s*[:\]]/g;
    for (const m of text.matchAll(re)) out.add(m[1]);
  }
  return out;
}

describe('theme tokens', () => {
  /**
   * A `var()` naming a token nothing defines is invisible in review and wrong at runtime: without
   * a fallback the whole declaration is invalid — `var(--win-bg-input)` was written forty times
   * with no definition anywhere, so those inputs had no background at all — and with one, the
   * "themed" colour is the fallback literal in BOTH themes (`var(--win-bg-subtle, #f0f2f5)` was a
   * light panel on the dark theme).
   */
  it('every var() names a token some stylesheet or style object defines', () => {
    const defined = definedTokens();
    const missing: string[] = [];
    for (const [file, text] of files) {
      for (const m of text.matchAll(/var\(\s*(--[A-Za-z0-9-]+)/g)) {
        if (!defined.has(m[1])) missing.push(`${'src/' + file}: ${m[1]}`);
      }
    }
    expect([...new Set(missing)]).toEqual([]);
  });

  /**
   * `fill`/`stroke`/`color` as a JSX ATTRIBUTE becomes an SVG presentation attribute (lucide turns
   * its `color` prop into `stroke`), and a `var()` there is not something to rely on — the icon
   * can render with no colour at all. `style={{ stroke: 'var(--…)' }}` is the working spelling.
   */
  it('no SVG attribute carries a var()', () => {
    const offenders: string[] = [];
    for (const [file, text] of files) {
      if (!file.endsWith('.tsx')) continue;
      for (const m of text.matchAll(/\s(fill|stroke|color)="var\([^"]*"/g)) {
        offenders.push(`src/${file}: ${m[0].trim()}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('actually finds the sources it checks', () => {
    // Guards the glob itself: a pattern that matched nothing would pass the test above.
    expect(files.some(([f]) => f === 'index.css')).toBe(true);
    expect(definedTokens().has('--win-accent')).toBe(true);
    expect(definedTokens().has('--tab-group-color')).toBe(true);
  });
});
