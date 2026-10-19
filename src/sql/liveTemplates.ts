/**
 * Live templates: type an abbreviation (`sel`, `ij`, `dup`, …), press Tab, and it expands into a
 * statement whose placeholders Tab walks through. The expansion itself is Monaco's snippet engine;
 * this module only decides WHAT is offered, so it imports no monaco and is unit-tested.
 *
 * Two sources:
 * - the built-ins below, written directly in Monaco snippet syntax;
 * - the user's own snippets from the Snippet panel that carry an abbreviation. Those are typed as
 *   plain SQL, so they go through `customBodyToSnippet`, which keeps only `${N}` / `${N:label}`
 *   and a few `${VAR}` names as live syntax and escapes every other `$`. That line is not
 *   cosmetic: Postgres writes `$1` for a parameter and `$$ … $$` around a function body, and read
 *   as snippet syntax both would silently vanish from the inserted text.
 */

/** The Monaco language ids in use (see `LANG_IDS` in sqlLanguage.ts). */
export type TemplateDialect = 'mysql' | 'pgsql' | 'genericsql';

export interface LiveTemplate {
  abbr: string;
  /** Monaco snippet syntax. */
  body: string;
  /** Absent = every dialect. */
  dialects?: TemplateDialect[];
  /**
   * Offered only where a statement can begin (see `atStatementStart`). Without it, `del` + Tab in
   * the middle of a WHERE — which used to complete the keyword — would drop a whole DELETE block
   * into the statement. User templates are never restricted: their owner chose the word.
   */
  statement?: boolean;
  /** A user template's display name, from the Snippet panel. Built-ins show their preview instead. */
  name?: string;
  custom?: boolean;
}

/**
 * Placeholder 1 is the TABLE wherever there is one, so the first thing typed after expanding is
 * the table name — which is also when table completion is showing — and the column placeholders
 * after it can then be completed from that table.
 */
export const BUILTIN_TEMPLATES: readonly LiveTemplate[] = [
  { abbr: 'sel', statement: true, body: 'SELECT ${2:*}\nFROM ${1:table}\nWHERE ${3:condition};$0' },
  { abbr: 'selc', statement: true, body: 'SELECT COUNT(*)\nFROM ${1:table}\nWHERE ${2:condition};$0' },
  { abbr: 'seld', statement: true, body: 'SELECT DISTINCT ${2:column}\nFROM ${1:table};$0' },
  { abbr: 'top', statement: true, body: 'SELECT *\nFROM ${1:table}\nLIMIT ${2:100};$0' },
  { abbr: 'ins', statement: true, body: 'INSERT INTO ${1:table} (${2:columns})\nVALUES (${3:values});$0' },
  { abbr: 'upd', statement: true, body: 'UPDATE ${1:table}\nSET ${2:column} = ${3:value}\nWHERE ${4:condition};$0' },
  { abbr: 'del', statement: true, body: 'DELETE FROM ${1:table}\nWHERE ${2:condition};$0' },
  // Ends right after ON: that is where the FK-based JOIN conditions are suggested.
  { abbr: 'ij', body: 'INNER JOIN ${1:table} ${2:alias} ON $0' },
  { abbr: 'lj', body: 'LEFT JOIN ${1:table} ${2:alias} ON $0' },
  { abbr: 'gb', body: 'GROUP BY ${1:column}\nORDER BY ${2:COUNT(*)} DESC$0' },
  { abbr: 'dup', statement: true, body: 'SELECT ${2:column}, COUNT(*) AS n\nFROM ${1:table}\nGROUP BY ${2:column}\nHAVING COUNT(*) > 1\nORDER BY n DESC;$0' },
  { abbr: 'cte', statement: true, body: 'WITH ${1:name} AS (\n  ${2:SELECT 1}\n)\nSELECT *\nFROM ${1:name};$0' },
  { abbr: 'case', body: 'CASE\n  WHEN ${1:condition} THEN ${2:result}\n  ELSE ${3:other}\nEND$0' },
  { abbr: 'exi', body: 'WHERE EXISTS (\n  SELECT 1\n  FROM ${1:table}\n  WHERE ${2:condition}\n)$0' },
  { abbr: 'ci', statement: true, body: 'CREATE INDEX ${1:idx_name}\nON ${2:table} (${3:column});$0' },
  { abbr: 'ac', statement: true, body: 'ALTER TABLE ${1:table}\nADD COLUMN ${2:name} ${3:type};$0' },
  { abbr: 'tx', statement: true, body: 'BEGIN;\n$0\nCOMMIT;' },
  { abbr: 'ret', body: 'RETURNING ${1:*}$0', dialects: ['pgsql', 'genericsql'] },
  { abbr: 'upsert', body: 'ON DUPLICATE KEY UPDATE ${1:column} = VALUES(${1:column})$0', dialects: ['mysql'] },
  { abbr: 'upsert', body: 'ON CONFLICT (${1:key}) DO UPDATE\nSET ${2:column} = EXCLUDED.${2:column}$0', dialects: ['pgsql', 'genericsql'] },
  { abbr: 'expl', statement: true, body: 'EXPLAIN ANALYZE\n$0', dialects: ['mysql', 'pgsql'] },
  { abbr: 'expl', statement: true, body: 'EXPLAIN QUERY PLAN\n$0', dialects: ['genericsql'] },
];

/**
 * Whether the caret sits where a statement can begin: nothing but the word being typed since the
 * last `;`, or right after `(` (a subquery, a CTE body). Approximate on purpose — a `;` inside a
 * string counts as a boundary — because the cost of a miss is only one template not offered.
 */
export function atStatementStart(textBefore: string): boolean {
  const head = textBefore.replace(/[A-Za-z0-9_]*$/, '');
  const sinceEnd = head.slice(head.lastIndexOf(';') + 1).replace(/--[^\n]*/g, '').trim();
  return sinceEnd === '' || sinceEnd.endsWith('(');
}

/** Letters, digits and `_`, starting with a letter — i.e. something that is one word in the editor. */
export const ABBR_RE = /^[A-Za-z][A-Za-z0-9_]{0,23}$/;

/** Monaco's own variables that are useful in SQL; any other `${NAME}` is kept as literal text. */
const SNIPPET_VARIABLES = new Set([
  'CURRENT_YEAR', 'CURRENT_MONTH', 'CURRENT_DATE', 'CURRENT_HOUR', 'CURRENT_MINUTE',
  'CURRENT_SECOND', 'UUID', 'CLIPBOARD',
]);

const escapeSnippetText = (s: string) => s.replace(/[\\$}]/g, (c) => `\\${c}`);

/**
 * A user template (plain SQL) as Monaco snippet syntax. Live: `${N}`, `${N:label}` (label without
 * `}`), `${VAR}` for the names above. Everything else is literal, `$1` and `$$` included.
 */
export function customBodyToSnippet(text: string): string {
  const re = /\$\{(\d+)(?::([^}]*))?\}|\$\{([A-Z_]+)\}/g;
  let out = '';
  let last = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m[3] !== undefined && !SNIPPET_VARIABLES.has(m[3])) continue;
    out += escapeSnippetText(text.slice(last, m.index));
    if (m[1] !== undefined) {
      out += m[2] !== undefined ? `\${${m[1]}:${escapeSnippetText(m[2])}}` : `\${${m[1]}}`;
    } else {
      out += `\${${m[3]}}`;
    }
    last = m.index + m[0].length;
  }
  return out + escapeSnippetText(text.slice(last));
}

/** The snippet as the user will see it inserted: labels in place of placeholders, escapes undone. */
export function snippetPreview(body: string): string {
  // One pass, escapes first: undoing them in a separate step would let `\$1` (a literal
  // Postgres parameter) be read as the tab stop `$1` and disappear from the preview.
  return body.replace(
    /\\([\\$}])|\$\{\d+:([^}]*)\}|\$\{\d+\}|\$\d+|\$\{([A-Z_]+)\}/g,
    (_m, escaped?: string, label?: string, variable?: string) => escaped ?? label ?? variable ?? '',
  );
}

/** The shape the Snippet panel stores (see SqlSnippetPanel's `SqlSnippet`). */
export interface StoredSnippet {
  name: string;
  template: string;
  abbr?: string;
}

/** Built-ins for the dialect, then the user's own; a user abbreviation shadows a built-in one. */
export function templatesFor(
  dialect: string,
  custom: readonly StoredSnippet[] = [],
  statementStart = true,
): LiveTemplate[] {
  const own: LiveTemplate[] = [];
  const taken = new Set<string>();
  for (const s of custom) {
    const abbr = (s.abbr || '').trim();
    if (!ABBR_RE.test(abbr) || taken.has(abbr.toLowerCase())) continue;
    taken.add(abbr.toLowerCase());
    own.push({ abbr, body: customBodyToSnippet(s.template), name: s.name, custom: true });
  }
  const builtins = BUILTIN_TEMPLATES.filter(
    (tpl) =>
      (!tpl.dialects || tpl.dialects.includes(dialect as TemplateDialect)) &&
      (statementStart || !tpl.statement) &&
      !taken.has(tpl.abbr.toLowerCase()),
  );
  return [...builtins, ...own];
}

/** localStorage key shared with the Snippet panel, which owns the writes. */
export const CUSTOM_SNIPPETS_KEY = 'tablegrid.sql_custom_snippets';

let cachedRaw: string | null = null;
let cachedList: StoredSnippet[] = [];

/**
 * The user's snippets, re-parsed only when the stored text changed — this runs on every
 * completion request, i.e. on every keystroke.
 */
export function readCustomSnippets(): StoredSnippet[] {
  let raw: string | null = null;
  try {
    raw = typeof localStorage !== 'undefined' ? localStorage.getItem(CUSTOM_SNIPPETS_KEY) : null;
  } catch {
    return [];
  }
  if (raw === cachedRaw) return cachedList;
  cachedRaw = raw;
  try {
    const parsed = raw ? JSON.parse(raw) : [];
    cachedList = Array.isArray(parsed) ? parsed : [];
  } catch {
    cachedList = [];
  }
  return cachedList;
}
