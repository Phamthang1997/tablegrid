// Beautifies / minifies SQL. Uses sql-formatter (dialect-aware parser) rather than naive regex
// to reliably preserve CTEs, nested subqueries, CASE WHEN, window functions, etc.
import { format as sqlFormat } from 'sql-formatter';

export type SqlDialect = 'mysql' | 'postgresql' | 'sqlite' | 'duckdb' | 'sql';

export function formatterDialect(dbType?: string): SqlDialect {
  switch (dbType) {
    case 'mysql': return 'mysql';
    case 'postgres': return 'postgresql';
    case 'sqlite': return 'sqlite';
    case 'duckdb': return 'duckdb';
    default: return 'sql';
  }
}

// Preserves all supported parameter placeholders (:name, ?, %name%, ${name})
// so formatter does not treat them as syntax errors.
const PARAM_TYPES = {
  positional: true,
  named: [':', '@'],
  custom: [{ regex: String.raw`%[\w.]+%` }, { regex: String.raw`\$\{[\w.]+\}` }],
} as const;

/**
 * Beautifies SQL for given dialect. Incomplete statements that trigger parser errors
 * return the original unmodified text safely.
 */
export function formatSql(sql: string, dbType?: string): string {
  if (!sql.trim()) return sql;
  try {
    return sqlFormat(sql, {
      language: formatterDialect(dbType),
      keywordCase: 'upper',
      dataTypeCase: 'upper',
      functionCase: 'upper',
      identifierCase: 'preserve',
      indentStyle: 'standard',
      tabWidth: 2,
      useTabs: false,
      linesBetweenQueries: 1,
      expressionWidth: 80,
      paramTypes: PARAM_TYPES as any,
    });
  } catch {
    return sql;
  }
}

/**
 * Minifies to single line: strips comments, collapses whitespace, removes redundant spaces around punctuation.
 * Contents inside string literals ('...', "...", `...`) are preserved VERBATIM.
 */
export function minifySql(sql: string): string {
  if (!sql.trim()) return sql;
  const n = sql.length;
  let out = '';
  const endsWithSpace = () => out.endsWith(' ');
  const addSpace = () => {
    // Avoids leading spaces, spaces after '(', or repeated whitespace
    if (!out || endsWithSpace() || out.endsWith('(')) return;
    out += ' ';
  };

  let i = 0;
  while (i < n) {
    const c = sql[i];
    const c2 = sql[i + 1];

    // Line comments: -- ... \n | Block comments: /* ... */
    if (c === '-' && c2 === '-') {
      while (i < n && sql[i] !== '\n') i++;
      addSpace();
      continue;
    }
    if (c === '/' && c2 === '*') {
      i += 2;
      while (i < n && !(sql[i] === '*' && sql[i + 1] === '/')) i++;
      i += 2;
      addSpace();
      continue;
    }

    // Quoted strings / identifiers: copied verbatim (including '' escapes)
    if (c === "'" || c === '"' || c === '`') {
      const quote = c;
      out += c;
      i++;
      while (i < n) {
        out += sql[i];
        if (sql[i] === quote) {
          if (quote === "'" && sql[i + 1] === "'") { out += sql[i + 1]; i += 2; continue; }
          i++;
          break;
        }
        i++;
      }
      continue;
    }

    if (/\s/.test(c)) {
      addSpace();
      i++;
      continue;
    }

    // Strips whitespace preceding closing punctuation
    if ((c === ',' || c === ';' || c === ')') && endsWithSpace()) out = out.slice(0, -1);
    out += c;
    i++;
  }

  return out.trim();
}
