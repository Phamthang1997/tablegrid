/**
 * The palette the ER canvas paints with.
 *
 * A canvas cannot let CSS resolve a colour for it, so every `--win-*` token the diagram uses
 * has to be turned into a plain string first. `getComputedStyle` is the expensive part of that
 * — it flushes pending style — so it runs **once per theme**, never inside a frame or inside a
 * card render. Everything downstream takes the resolved object.
 *
 * `id` is what card bitmaps are keyed by: a theme switch changes it, which invalidates the
 * whole bitmap cache without anyone having to remember to clear it.
 */

export interface ERPalette {
  /** Cache identity. Changes whenever any colour below might have changed. */
  id: string;
  cardBg: string;
  cardBorder: string;
  accent: string;
  headerBg: string;
  viewHeaderBg: string;
  viewAccent: string;
  title: string;
  textPrimary: string;
  textSecondary: string;
  textDisabled: string;
  badgeBg: string;
  badgeBorder: string;
  pk: string;
  fk: string;
  pkRow: string;
  fkRow: string;
  relLine: string;
  marqueeFill: string;
  fontSans: string;
  fontMono: string;
}

const FALLBACK_SANS =
  'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
const FALLBACK_MONO = '"JetBrains Mono", ui-monospace, Consolas, monospace';

/**
 * Colours that are NOT tokens.
 *
 * Each one is a literal in `index.css` today, in the rules this renderer replaces — the view
 * tint of a header, the two key colours, the two row tints. Kept as literals here rather than
 * invented as new tokens, so the canvas looks like the cards it replaced; if they ever become
 * tokens, they become lookups here and nowhere else.
 */
const VIEW_ACCENT = '#a855f7';
const VIEW_HEADER_BG = 'rgba(168, 85, 247, 0.08)';
const PK_COLOR = '#f59e0b';
const FK_COLOR = '#3b82f6';
const PK_ROW = 'rgba(245, 158, 11, 0.05)';
const FK_ROW = 'rgba(59, 130, 246, 0.04)';

let cached: ERPalette | null = null;
/** Bumped by `invalidateErPalette`, so a forced refresh cannot collide with a cached id. */
let revision = 0;

function token(style: CSSStyleDeclaration, name: string, fallback: string): string {
  const value = style.getPropertyValue(name).trim();
  return value || fallback;
}

/** The document's own notion of which theme is active, as the cache key. */
function themeId(): string {
  if (typeof document === 'undefined') return `none#${revision}`;
  return `${document.documentElement.getAttribute('data-theme') ?? 'system'}#${revision}`;
}

/**
 * The active palette. Cheap to call every frame: it only compares a string unless the theme
 * actually changed.
 */
export function erPalette(): ERPalette {
  const id = themeId();
  if (cached && cached.id === id) return cached;

  const style = getComputedStyle(document.documentElement);
  cached = {
    id,
    cardBg: token(style, '--win-bg-card', '#1e293b'),
    cardBorder: token(style, '--win-border', '#334155'),
    accent: token(style, '--win-accent', '#3b82f6'),
    headerBg: token(style, '--win-bg-hover', 'rgba(0, 0, 0, 0.03)'),
    viewHeaderBg: VIEW_HEADER_BG,
    viewAccent: VIEW_ACCENT,
    title: token(style, '--win-text-primary', '#f8fafc'),
    textPrimary: token(style, '--win-text-primary', '#e2e8f0'),
    textSecondary: token(style, '--win-text-secondary', '#94a3b8'),
    textDisabled: token(style, '--win-text-disabled', '#64748b'),
    badgeBg: token(style, '--win-bg-window', '#0f172a'),
    badgeBorder: token(style, '--win-border', '#334155'),
    pk: PK_COLOR,
    fk: FK_COLOR,
    pkRow: PK_ROW,
    fkRow: FK_ROW,
    relLine: token(style, '--win-text-secondary', '#94a3b8'),
    marqueeFill: 'rgba(59, 130, 246, 0.08)',
    fontSans: token(style, '--win-font-sans', FALLBACK_SANS),
    fontMono: token(style, '--win-font-mono', FALLBACK_MONO),
  };
  return cached;
}

/**
 * Forget the resolved palette.
 *
 * Needed for the one change a theme attribute does not describe: web fonts finishing loading.
 * Until they do, `fillText` silently draws the fallback family, and a cached bitmap would keep
 * that wrong metric forever — so the caller bumps this and re-renders once `document.fonts` is
 * ready.
 */
export function invalidateErPalette(): void {
  revision += 1;
  cached = null;
}
