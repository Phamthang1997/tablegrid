// Integrates monaco-sql-languages (ANTLR parser + caret context) with database catalog.
// Context computed by monaco-sql-languages; completionService supplies catalog metadata.

import * as monaco from 'monaco-editor';
import { setupLanguageFeatures, LanguageIdEnum, EntityContextType } from 'monaco-sql-languages';
import { insertTargetBeforeCaret, buildInsertColumnsSnippet } from './insertColumns';
import type { CompletionService, ICompletionItem, CompletionSnippet } from 'monaco-sql-languages';
import 'monaco-sql-languages/esm/languages/mysql/mysql.contribution';
import 'monaco-sql-languages/esm/languages/pgsql/pgsql.contribution';
import 'monaco-sql-languages/esm/languages/generic/generic.contribution';
import * as catalog from './catalog';
import { editorConnId } from './editorScope';
import { buildJoinConditions } from './joinConditions';
import { collectTableRefs, statementAt, valuePosition } from './statements';
import { bumpUsage, rankSort } from './usageStats';
import { getDoc, formatDocMarkdown } from '../utils/docsService';
import { enumValues, typeFamily } from '../utils/columnType';
import i18n from '../i18n';

const BUMP_CMD = 'tablegrid.bumpUsage';

/** Type labels in suggest popup matching hover documentation keys. */
const tableKind = (type: string) =>
  i18n.t(type === 'view' ? 'sqlEditor.hoverKindView' : 'sqlEditor.hoverKindTable');

// Frequently used keywords prioritized over uncommon statements.
const COMMON_KEYWORDS = new Set([
  'SELECT', 'FROM', 'WHERE', 'JOIN', 'LEFT JOIN', 'INNER JOIN', 'RIGHT JOIN', 'ON',
  'GROUP BY', 'ORDER BY', 'HAVING', 'LIMIT', 'OFFSET', 'INSERT', 'INSERT INTO',
  'UPDATE', 'DELETE', 'SET', 'VALUES', 'AND', 'OR', 'NOT', 'IN', 'LIKE', 'AS',
  'DISTINCT', 'COUNT', 'SUM', 'AVG', 'MIN', 'MAX', 'CASE', 'WHEN', 'THEN', 'ELSE',
  'END', 'WITH', 'UNION', 'IS NULL', 'IS NOT NULL', 'ASC', 'DESC', 'BETWEEN', 'EXISTS',
]);
// Callback on item selection -> increments usage frequency count.
const bumpCommand = (name: string) => ({ id: BUMP_CMD, title: '', arguments: [name] });

export function langIdForDbType(dbType: string): string {
  if (dbType === 'postgres') return LanguageIdEnum.PG;
  if (dbType === 'mysql') return LanguageIdEnum.MYSQL;
  return LanguageIdEnum.GENERIC; // sqlite: uses generic SQL grammar
}

// Supported language IDs registered for hover/formatting providers.
export const LANG_IDS: string[] = [LanguageIdEnum.MYSQL, LanguageIdEnum.PG, LanguageIdEnum.GENERIC];

// Generates short table aliases: snake_case -> initials (order_details -> od);
// camelCase -> uppercase letters (orderDetails -> od); single words -> first letter.
function genAlias(table: string, taken: Set<string>): string {
  let base: string;
  const parts = table.split(/[_\s]+/).filter(Boolean);
  if (parts.length > 1) base = parts.map(p => p[0]).join('');
  else if (/[a-z][A-Z]/.test(table)) base = table[0] + (table.slice(1).match(/[A-Z]/g) || []).join('');
  else base = table.slice(0, 1);
  base = (base || 't').toLowerCase();
  let a = base;
  let n = 1;
  while (taken.has(a)) { a = base + n; n++; }
  taken.add(a);
  return a;
}

const completionService: CompletionService = async (model, position, _ctx, suggestions, entities, snippets) => {
  const items: ICompletionItem[] = [];

  // Fallback degradation mode when ANTLR parser fails on mid-typed queries:
  // scopes from text scanner still provide table/column suggestions and JOIN conditions.
  
  
  const parserFailed = !suggestions;
  const keywords = suggestions?.keywords ?? [];
  const syntaxHints = suggestions?.syntax ?? [];

  // 1) Keywords (dialect-specific from parser). Common keywords ranked first.
  
  
  const keywordSet = new Set<string>();
  const langId = model.getLanguageId();
  for (const kw of keywords) {
    keywordSet.add(kw.toUpperCase());
    const docEntry = getDoc(kw, langId);
    items.push({
      label: kw,
      kind: docEntry ? monaco.languages.CompletionItemKind.Function : monaco.languages.CompletionItemKind.Keyword,
      detail: docEntry
        ? i18n.t('sqlEditor.cmplSqlFunction', { engine: docEntry.engine })
        : i18n.t('sqlEditor.cmplKeyword'),
      documentation: docEntry ? { value: formatDocMarkdown(docEntry) } : undefined,
      insertText: kw,
      sortText: rankSort(COMMON_KEYWORDS.has(kw.toUpperCase()) ? '4' : '5', kw),
      command: bumpCommand(kw),
    });
  }

  // 2) Dialect snippets from monaco-sql-languages returned with deduped keyword collisions.
  
  
  
  for (const sn of (snippets || []) as CompletionSnippet[]) {
    if (keywordSet.has(sn.prefix.toUpperCase())) continue;
    const body = Array.isArray(sn.body) ? sn.body.join('\n') : sn.body;
    items.push({
      label: sn.prefix,
      kind: monaco.languages.CompletionItemKind.Snippet,
      detail: i18n.t('sqlEditor.cmplSnippet'),
      documentation: { value: ['```sql', body.replace(/\$\{\d+:?([^}]*)\}/g, '$1').replace(/\$\d+/g, ''), '```'].join('\n') },
      insertText: sn.insertText || body,
      insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
      filterText: `${sn.prefix} ${sn.label}`,
      sortText: 'z_' + sn.prefix,
    });
  }

  // 2) Table aliases and scoped tables.
  //
  // Combines ANTLR entities and text-based scanning (`collectTableRefs`) to survive incomplete syntax.
  
  
  
  
  
  const aliasMap = new Map<string, string>(); // alias|name (lower) -> table name
  const aliasByTable = new Map<string, string>(); // table name -> alias for prefixing
  const scopeTables: string[] = [];
  const addTableRef = (tbl: string, alias?: string) => {
    if (!tbl) return;
    if (!scopeTables.some(t => t.toLowerCase() === tbl.toLowerCase())) scopeTables.push(tbl);
    aliasMap.set(tbl.toLowerCase(), tbl);
    if (alias) {
      aliasMap.set(alias.toLowerCase(), tbl);
      if (!aliasByTable.has(tbl)) aliasByTable.set(tbl, alias);
    }
  };

  for (const e of entities || []) {
    if ((e as any).entityContextType === EntityContextType.TABLE) {
      const tbl = String((e as any).text || '').split('.').pop() || '';
      const alias = (e as any)['_alias']?.text;
      addTableRef(tbl, alias ? String(alias) : undefined);
    }
  }

  const fullText = model.getValue();
  const textBefore = model.getValueInRange({
    startLineNumber: 1, startColumn: 1,
    endLineNumber: position.lineNumber, endColumn: position.column,
  });

  // Scoped strictly to statement containing caret.
  const currentStmt = statementAt(fullText, model.getOffsetAt(position));
  for (const ref of collectTableRefs(currentStmt?.text ?? textBefore)) {
    addTableRef(ref.table, ref.alias);
  }

  // 2b) Suggests `JOIN ON` conditions from foreign keys or matching column names after ON keyword.
  const inOnClause = /\bON\s+[\w.`"]*$/i.test(textBefore);
  let joinConds: string[] = [];
  if (inOnClause) {
    // `buildJoinConditions` receives injected `getSchema` for isolated unit testing.
    
    joinConds = await buildJoinConditions(scopeTables, aliasByTable, (tbl) =>
      catalog.getSchema(editorConnId(), tbl),
    );
    joinConds.forEach((c, i) => items.push({
      label: c,
      kind: monaco.languages.CompletionItemKind.Snippet,
      detail: i18n.t('sqlEditor.cmplJoinCondition'),
      insertText: c,
      sortText: '0_' + i, // highest priority
    }));
  }

  // Debug via `window.__sqlCompletionDebug = true` in DevTools to inspect completion candidates.
  
  
  if ((globalThis as any).__sqlCompletionDebug) {
    const entityTables = (entities || [])
      .filter(e => (e as any).entityContextType === EntityContextType.TABLE)
      .map(e => `${(e as any).text}${(e as any)['_alias']?.text ? ' ' + (e as any)['_alias'].text : ''}`);
    // Logged as ONE flat string, not an object: DevTools collapses nested arrays/objects
    // behind `Array(4)` / `…`, and copying the console then loses exactly the fields worth
    // reading (joinConds above all). Keep every value inline so a paste carries it.
    console.log(
      '[sql-completion]' +
        ` tail=${JSON.stringify(textBefore.slice(-40))}` +
        ` inOnClause=${inOnClause}` +
        ` parserFailed=${parserFailed}` +
        ` syntax=[${syntaxHints.map(s => s.syntaxContextType).join(' ')}]` +
        ` entityTables=[${entityTables.join(' | ')}]` +
        ` scopeTables=[${scopeTables.join(' ')}]` +
        ` aliasByTable={${[...aliasByTable].map(([tbl, a]) => `${tbl}:${a}`).join(' ')}}` +
        ` joinConds=[${joinConds.join(' | ')}]`
    );
  }

  // 2b) Value position completion (`WHERE status = `, `IN (`, `LIKE `) -> enum/boolean values.
  //
  // Sourced strictly from catalog schema types without live database queries.
  
  
  
  //
  // Avoids table scan queries on production connections.
  
  
  const valueAt = valuePosition(textBefore);
  if (valueAt) {
    const dot = valueAt.column.lastIndexOf('.');
    const colName = dot >= 0 ? valueAt.column.slice(dot + 1) : valueAt.column;
    const prefix = dot >= 0 ? valueAt.column.slice(0, dot).toLowerCase() : null;
    // Qualified prefix -> lookup specific table; otherwise check all scope tables.
    const owners = prefix
      ? scopeTables.filter(tb => tb.toLowerCase() === prefix || aliasByTable.get(tb)?.toLowerCase() === prefix)
      : Array.from(new Set(scopeTables));

    for (const tbl of owners) {
      const schema = await catalog.getSchema(editorConnId(), tbl);
      const col = (schema?.columns || []).find(c => c.name.toLowerCase() === colName.toLowerCase());
      if (!col) continue;

      const family = typeFamily(col.type);
      const values = family === 'bool' ? ['TRUE', 'FALSE'] : enumValues(col.type);
      if (!values.length) continue;

      values.forEach((v, i) => {
        // Boolean literals are keywords -> unquoted.
        const literal = family === 'bool' ? v : `'${v.replace(/'/g, "''")}'`;
        items.push({
          label: v,
          kind: monaco.languages.CompletionItemKind.Value,
          detail: i18n.t('sqlEditor.cmplColumnValue', { table: tbl }),
          // Opening quote already typed -> inserts unquoted content.
          insertText: valueAt.quoted && family !== 'bool' ? `${v.replace(/'/g, "''")}'` : literal,
          filterText: v,
          sortText: '00_value_' + String(i).padStart(3, '0'),
        });
      });
      break; // first matching column is sufficient
    }
  }

  // 2c) Directly following SELECT -> '*' is top suggestion before columns/tables.
  // Adds explicit column list snippet when scope tables are known.
  if (/\bselect\s+(distinct\s+|all\s+)?$/i.test(textBefore)) {
    items.push({
      label: '*',
      kind: monaco.languages.CompletionItemKind.Field,
      detail: i18n.t('sqlEditor.cmplAllColumns'),
      insertText: '*',
      filterText: '*',
      sortText: '00_star', // ranks above JOIN conditions ('0_...')
      preselect: true,
    });
    for (const tbl of Array.from(new Set(scopeTables))) {
      const schema = await catalog.getSchema(editorConnId(), tbl);
      const cols = schema?.columns || [];
      if (!cols.length) continue;
      const pfx = aliasByTable.get(tbl) || tbl;
      const multi = new Set(scopeTables).size > 1;
      const list = cols.map(c => (multi ? `${pfx}.${c.name}` : c.name)).join(', ');
      items.push({
        label: `${multi ? `${pfx}.` : ''}* → ${i18n.t('sqlEditor.cmplListColumns', { n: cols.length })}`,
        kind: monaco.languages.CompletionItemKind.Snippet,
        detail: i18n.t('sqlEditor.cmplAllColumnsOf', { table: tbl }),
        documentation: { value: ['```sql', list, '```'].join('\n') },
        insertText: list,
        filterText: '*',
        sortText: '00_starlist_' + pfx,
      });
    }
  }

  // 2d) Directly following `INSERT INTO <table> ` -> the table's real column list.
  //
  // Uses `getSchemaDetailed`, NOT `getSchema`: the bulk-primed cache carries no
  // `autoIncrement`/`generated`/`identityAlways`, and suggesting a column the database writes
  // itself produces a statement that fails (MySQL 3105). One IPC call for a table the user just
  // named by hand, cached afterwards.
  const insertTarget = insertTargetBeforeCaret(textBefore);
  if (insertTarget) {
    const schema = await catalog.getSchemaDetailed(editorConnId(), insertTarget);
    const snippet = buildInsertColumnsSnippet(schema?.columns || []);
    if (snippet) {
      items.push({
        label: snippet.text.replace(' VALUES ($1)', ''),
        kind: monaco.languages.CompletionItemKind.Snippet,
        detail: i18n.t('sqlEditor.cmplInsertColumns', { n: snippet.count, table: insertTarget }),
        documentation: { value: ['```sql', snippet.text.replace('$1', ''), '```'].join('\n') },
        insertText: snippet.text,
        insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
        sortText: '00_insertcols',
        preselect: true,
      });
    }
  }

  // 3) Checks for "alias." prefix directly before caret.
  const line = model.getValueInRange({
    startLineNumber: position.lineNumber,
    startColumn: 1,
    endLineNumber: position.lineNumber,
    endColumn: position.column,
  });
  const dot = line.match(/([A-Za-z_][\w$]*)\s*\.\s*[\w$]*$/);
  const prefixAlias = dot ? dot[1].toLowerCase() : null;

  // 4) Semantic suggestions according to parser request at caret.
  const emitTables = async () => {
    // Automatically assigns alias when inserting tables in FROM/JOIN (excluding INTO/UPDATE/DROP...)
    const stripped = textBefore.replace(/[\w$."`]*$/, '').trimEnd();
    const afterJoin = /\bjoin$/i.test(stripped);
    const wantAlias = afterJoin || /\bfrom$/i.test(stripped) || (stripped.endsWith(',') && /\bfrom\b/i.test(textBefore));
    const taken = new Set<string>();
    aliasByTable.forEach(a => taken.add(a.toLowerCase()));

    // A table the caret's statement can already join to is ranked above the rest of the catalog and,
    // right after `JOIN`, carries its own `ON` clause. This reads the catalog cache ONLY
    // (`getCachedSchema`), so the ranking costs no IPC: the cache is primed in the background by
    // `getTables`, and until it lands every table reports no relation and the list simply falls
    // back to the plain frequency order.
    const cachedSchema = async (tbl: string) => catalog.getCachedSchema(editorConnId(), tbl);
    // Appending `ON …` to a re-picked table would produce a second one, so look for an `ON`
    // already sitting after the caret first — up to the end of the STATEMENT, not of the line,
    // since a hand-formatted join puts its condition on the next one.
    const after = fullText.slice(model.getOffsetAt(position));
    const restOfStatement = after.slice(0, after.indexOf(';') < 0 ? after.length : after.indexOf(';'));
    const canAppendOn = afterJoin && !/\bon\b/i.test(restOfStatement);

    // The ranking below is worthless on a cold cache, and the very first `JOIN` of a session is
    // exactly when it is cold — `getTables` only fires the prime and walks away. Awaited ONLY on
    // this path (it is capped, and it is the one place whose answer depends on the cache rather
    // than merely improving with it).
    if (afterJoin && scopeTables.length) await catalog.ensureCatalogPrimed(editorConnId());

    const tables = await catalog.getTables(editorConnId());

    // Aliases first, because a JOIN condition has to name the candidate by the alias it will be
    // inserted with. `new Set(taken)` per item keeps each one isolated, so this stays independent
    // of order - which is what makes resolving the conditions together below correct.
    const aliasOf = new Map<string, string>();
    if (wantAlias) {
      for (const tb of tables) aliasOf.set(tb.name, genAlias(tb.name, new Set(taken)));
    }

    // Resolved TOGETHER rather than one per iteration. `Promise.all` is wrong at almost every other
    // await-in-a-loop in this codebase - those are sequential DB reads, and firing N of them at once
    // would hit the user's production database with a burst (see the triage note in CLAUDE.md). This
    // one reads `getCachedSchema`, i.e. a Map already in memory, so there is nothing to burst.
    const condsOf = new Map<string, string[]>();
    if (afterJoin && scopeTables.length) {
      const built = await Promise.all(
        tables.map(tb => {
          const aliasForCond = new Map(aliasByTable);
          const alias = aliasOf.get(tb.name);
          if (alias) aliasForCond.set(tb.name, alias);
          // FK only: the same-name fallback would call every table joinable in a schema where each
          // one has an `id`, and a ranking that promotes everything ranks nothing.
          return buildJoinConditions([...scopeTables, tb.name], aliasForCond, cachedSchema, { fkOnly: true });
        }),
      );
      tables.forEach((tb, i) => condsOf.set(tb.name, built[i]));
    }

    for (const tb of tables) {
      let insertText = tb.name;
      const alias = aliasOf.get(tb.name) ?? null;
      if (alias) {
        // Inserts alias as plain text rather than snippet placeholder to prevent accidental overwrites.
        insertText = `${tb.name} ${alias}`;
      }

      const conds = condsOf.get(tb.name) ?? [];
      if (conds.length && canAppendOn) insertText = `${insertText} ON ${conds[0]}`;

      items.push({
        label: tb.name,
        kind: tb.type === 'view'
          ? monaco.languages.CompletionItemKind.Interface
          : monaco.languages.CompletionItemKind.Class,
        detail: tableKind(tb.type)
          + (alias ? ` · alias ${alias}` : '')
          + (conds.length ? ` · ${i18n.t('sqlEditor.cmplJoinsOn', { cond: conds[0] })}` : ''),
        // More than one FK to the tables in scope: the popup shows the first, the doc panel all of them.
        documentation: conds.length > 1
          ? { value: ['```sql', conds.map(c => `ON ${c}`).join('\n'), '```'].join('\n') }
          : undefined,
        insertText,
        // '1z' sorts between the column tier ('1') and the plain table tier ('2'); '15' would NOT,
        // since '5' < '_'. A column is never emitted at a JOIN caret, but the ladder stays honest
        // either way (completionOrder.test.ts pins it).
        sortText: conds.length ? rankSort('1z', tb.name) : rankSort('2', tb.name),
        command: bumpCommand(tb.name),
      });
    }
  };

  const emitColumns = async () => {
    // Resolves target tables: dot alias > scope tables > all cached tables
    let targetTables: string[];
    // cacheOnly: scanning all tables reads from cache only to avoid hundreds of IPC calls.
    
    
    let cacheOnly = false;
    if (prefixAlias && aliasMap.has(prefixAlias)) {
      targetTables = [aliasMap.get(prefixAlias)!];
    } else if (scopeTables.length) {
      targetTables = Array.from(new Set(scopeTables));
    } else {
      targetTables = (await catalog.getTables(editorConnId())).map(t => t.name);
      cacheOnly = true;
    }
    const multi = targetTables.length > 1;
    // Multi-table without alias prefix: auto-prefixes table/alias to columns (customers.customerName)
    const qualify = multi && !prefixAlias;
    // Caps column suggestions to avoid CPU overhead on large schemas with hundreds of tables.
    
    const MAX_COLUMN_ITEMS = 1500;
    let columnCount = 0;
    for (const tb of targetTables) {
      if (columnCount >= MAX_COLUMN_ITEMS) break;
      const schema = cacheOnly ? catalog.getCachedSchema(editorConnId(), tb) : await catalog.getSchema(editorConnId(), tb);
      const prefix = aliasByTable.get(tb) || tb;
      for (const col of schema?.columns || []) {
        if (columnCount >= MAX_COLUMN_ITEMS) break;
        columnCount++;
        items.push({
          label: col.name,
          kind: col.isPrimaryKey
            ? monaco.languages.CompletionItemKind.Constant
            : monaco.languages.CompletionItemKind.Field,
          detail: `${col.type}${multi ? ` · ${tb}` : ''}${col.isPrimaryKey ? ' · PK' : ''}`,
          insertText: qualify ? `${prefix}.${col.name}` : col.name,
          sortText: rankSort('1', col.name),
          command: bumpCommand(col.name),
        });
      }
    }
    // Also suggests table names in scope for dot completion when no prefix is typed
    if (!prefixAlias) {
      for (const tb of Array.from(new Set(scopeTables))) {
        const p = aliasByTable.get(tb) || tb;
        items.push({
          label: p,
          kind: monaco.languages.CompletionItemKind.Class,
          detail: i18n.t('sqlEditor.hoverKindTable') + (aliasByTable.get(tb) ? ` (${tb})` : ''),
          insertText: p,
          sortText: rankSort('3', p),
          command: bumpCommand(tb),
        });
      }
    }
  };

  if (parserFailed) {
    // Infer completion context from preceding text: FROM/JOIN -> tables, otherwise columns/keywords.
    
    const wantsTable = /\b(from|join)\s+[\w$."`]*$/i.test(textBefore);
    if (wantsTable) await emitTables();
    else await emitColumns();
  } else {
    for (const s of syntaxHints) {
      const type = s.syntaxContextType;
      if (type === EntityContextType.TABLE || type === EntityContextType.VIEW) await emitTables();
      else if (type === EntityContextType.COLUMN) await emitColumns();
    }
  }

  return items;
};

let initialized = false;
export function setupSqlCompletion(): void {
  if (initialized) return;
  initialized = true;
  // Increments usage frequency when a suggestion is accepted
  try {
    (monaco.editor as any).registerCommand(BUMP_CMD, (_accessor: any, name: string) => bumpUsage(name));
  } catch { /* already registered */ }
  const config = {
    completionItems: {
      enable: true,
      completionService,
      triggerCharacters: ['.', ' '],
    },
  } as any;
  setupLanguageFeatures(LanguageIdEnum.MYSQL, config);
  setupLanguageFeatures(LanguageIdEnum.PG, config);
  setupLanguageFeatures(LanguageIdEnum.GENERIC, config);
}
