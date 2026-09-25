// The file format for taking saved queries and custom snippets out of the app — to another machine,
// or to a colleague — and back in.
//
// Both live in localStorage, which is per machine and per webview profile, so before this there was
// no way to move them at all. One JSON file carries either or both lists, under a header that says
// what the file is, so importing a random JSON file is refused in words rather than half-applied.
//
// Pure: no storage, no DOM, no Tauri. The call sites read the lists, hand them here, and write the
// result back — the same split `redisTransfer.ts` and `dumpBuilder.ts` use, and the reason the rules
// below (what counts as a duplicate, what happens to a clashing abbreviation) are tested.

import { ABBR_RE } from '../sql/liveTemplates';

export const QUERY_SHARE_FORMAT = 'tablegrid-queries';
export const QUERY_SHARE_VERSION = 1;

/**
 * A saved query as it travels. Only what someone else can use: no id (minted again on import), no
 * timestamp, no last-run result — and no `conn`/`db` either, see `buildShareFile`.
 */
export interface SharedQuery {
  name: string;
  sql: string;
}

/** A custom snippet as it travels — the fields the Snippet panel and live templates read. */
export interface SharedSnippet {
  name: string;
  category: string;
  description: string;
  template: string;
  abbr?: string;
  isSnippetSyntax?: boolean;
}

export interface ShareFile {
  savedQueries: SharedQuery[];
  snippets: SharedSnippet[];
}

/**
 * The file's text.
 *
 * `conn`/`db` are deliberately left out. They are this machine's server key (`mysql:host:port`), and
 * an entry tagged with one is shown only when that exact server is open (`matchesScope`) — so a
 * colleague whose host is spelled differently would import queries that then never appear. Untagged,
 * an imported query shows under every connection, which is what "here are my queries" means.
 */
export function buildShareFile(
  data: { savedQueries?: { name: string; sql: string }[]; snippets?: SharedSnippet[] },
  exportedAt: string,
): string {
  const out: Record<string, unknown> = {
    format: QUERY_SHARE_FORMAT,
    version: QUERY_SHARE_VERSION,
    exportedAt,
  };
  if (data.savedQueries) out.savedQueries = data.savedQueries.map((q) => ({ name: q.name, sql: q.sql }));
  if (data.snippets) out.snippets = data.snippets.map(pickSnippetFields);
  return JSON.stringify(out, null, 2);
}

function pickSnippetFields(s: SharedSnippet): SharedSnippet {
  const out: SharedSnippet = {
    name: s.name,
    category: s.category,
    description: s.description,
    template: s.template,
  };
  if (s.abbr) out.abbr = s.abbr;
  if (s.isSnippetSyntax) out.isSnippetSyntax = true;
  return out;
}

/** Why a file was refused. A key the call site translates — this module has no `t()`. */
export type ShareFileError = 'notJson' | 'wrongFormat' | 'newerVersion';

/**
 * The translation key for each refusal, as literal keys so `t()` type-checks them — a dynamic
 * `t(\`queryShare.${error}\`)` is exactly what the i18n setup forbids.
 */
export const SHARE_ERROR_KEY = {
  notJson: 'queryShare.errNotJson',
  wrongFormat: 'queryShare.errWrongFormat',
  newerVersion: 'queryShare.errNewerVersion',
} as const satisfies Record<ShareFileError, string>;

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

/**
 * Reads a file written by `buildShareFile`. Malformed ENTRIES are dropped and counted rather than
 * failing the file — one bad row among fifty is not a reason to import none of them — but a file
 * that is not this format at all is refused, since guessing at a foreign JSON shape would import
 * garbage under plausible names.
 */
export function parseShareFile(
  text: string,
): { ok: true; data: ShareFile; dropped: number } | { ok: false; error: ShareFileError } {
  let raw: any;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, error: 'notJson' };
  }
  if (!raw || typeof raw !== 'object' || raw.format !== QUERY_SHARE_FORMAT) {
    return { ok: false, error: 'wrongFormat' };
  }
  if (typeof raw.version === 'number' && raw.version > QUERY_SHARE_VERSION) {
    return { ok: false, error: 'newerVersion' };
  }

  let dropped = 0;
  const savedQueries: SharedQuery[] = [];
  for (const q of Array.isArray(raw.savedQueries) ? raw.savedQueries : []) {
    const name = str(q?.name);
    const sql = str(q?.sql);
    if (name === null || sql === null || !sql.trim()) {
      dropped++;
      continue;
    }
    savedQueries.push({ name: name.trim() || sql.trim().slice(0, 60), sql });
  }

  const snippets: SharedSnippet[] = [];
  for (const s of Array.isArray(raw.snippets) ? raw.snippets : []) {
    const name = str(s?.name);
    const template = str(s?.template);
    if (!name?.trim() || template === null || !template.trim()) {
      dropped++;
      continue;
    }
    snippets.push(
      pickSnippetFields({
        name: name.trim(),
        category: str(s.category) || 'Custom',
        description: str(s.description) || '',
        template,
        abbr: str(s.abbr) || undefined,
        isSnippetSyntax: s.isSnippetSyntax === true,
      }),
    );
  }

  return { ok: true, data: { savedQueries, snippets }, dropped };
}

/** Same name and same text, ignoring surrounding whitespace — importing a file twice adds nothing. */
const queryKey = (name: string, sql: string) => `${name.trim()}\u0000${sql.trim()}`;

/**
 * Which incoming saved queries are new. Returned in file order; the caller mints ids and writes.
 * A query already present (same name AND same text) is skipped; one that shares only its name is
 * kept, because two different queries both called "active users" are both worth having.
 */
export function newSavedQueries(
  existing: { name: string; sql: string }[],
  incoming: SharedQuery[],
): { added: SharedQuery[]; skipped: number } {
  const seen = new Set(existing.map((q) => queryKey(q.name, q.sql)));
  const added: SharedQuery[] = [];
  let skipped = 0;
  for (const q of incoming) {
    const key = queryKey(q.name, q.sql);
    if (seen.has(key)) {
      skipped++;
      continue;
    }
    seen.add(key);
    added.push(q);
  }
  return { added, skipped };
}

/**
 * Which incoming snippets are new, same rule as `newSavedQueries` (name + template).
 *
 * The abbreviation is the one field that must stay unique — two snippets answering to `sel` + Tab
 * would make Tab expand whichever the list happens to hold first. A clashing or invalid abbreviation
 * is therefore DROPPED from the imported snippet (it stays usable from the panel) and counted, rather
 * than overwriting the user's own or refusing the snippet.
 */
export function newSnippets(
  existing: { name: string; template: string; abbr?: string }[],
  incoming: SharedSnippet[],
  /** Abbreviations the built-in templates already use. */
  reservedAbbrs: Iterable<string> = [],
): { added: SharedSnippet[]; skipped: number; abbrDropped: number } {
  const seen = new Set(existing.map((s) => queryKey(s.name, s.template)));
  const taken = new Set<string>([...reservedAbbrs].map((a) => a.toLowerCase()));
  for (const s of existing) if (s.abbr) taken.add(s.abbr.toLowerCase());

  const added: SharedSnippet[] = [];
  let skipped = 0;
  let abbrDropped = 0;
  for (const s of incoming) {
    const key = queryKey(s.name, s.template);
    if (seen.has(key)) {
      skipped++;
      continue;
    }
    seen.add(key);
    const snippet = { ...s };
    if (snippet.abbr) {
      const lower = snippet.abbr.toLowerCase();
      if (!ABBR_RE.test(snippet.abbr) || taken.has(lower)) {
        delete snippet.abbr;
        abbrDropped++;
      } else {
        taken.add(lower);
      }
    }
    added.push(snippet);
  }
  return { added, skipped, abbrDropped };
}

/** `tablegrid-queries-20260925_101500.json`, reusing the export's timestamp. */
export function shareFileName(stamp: string, kind: 'queries' | 'snippets'): string {
  return `tablegrid-${kind}-${stamp}.json`;
}
