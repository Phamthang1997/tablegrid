import * as catalog from '../sql/catalog';
import { editorConnId } from '../sql/editorScope';

export interface DatabaseContextOptions {
  activeTable?: string | null;
  attachedTables?: string[];
  dbType?: string; // postgres, mysql, sqlite, etc.
  maxTables?: number;
}

export async function buildSchemaContext(options: DatabaseContextOptions): Promise<string> {
  const { activeTable, attachedTables = [], dbType = 'sql' } = options;

  let tablesToInclude: string[] = [];

  if (attachedTables.length > 0) {
    tablesToInclude = [...attachedTables];
  } else if (activeTable) {
    tablesToInclude = [activeTable];
  }

  // If no specific table, fetch all available tables in database
  if (tablesToInclude.length === 0) {
    try {
      const allTables = await catalog.getTables(editorConnId());
      tablesToInclude = allTables.slice(0, 10).map((t) => t.name);
    } catch {
      // Fallback
    }
  }

  const tableSchemas: string[] = [];

  for (const tableName of tablesToInclude) {
    try {
      const schema = await catalog.getSchema(editorConnId(), tableName);
      if (schema && schema.columns && schema.columns.length > 0) {
        const cols = schema.columns.map((c) => {
          let desc = `${c.name} (${c.type}`;
          if (c.isPrimaryKey) desc += ', PK';
          if (!c.nullable) desc += ', NOT NULL';
          desc += ')';
          return desc;
        }).join(', ');

        let tableDesc = `Table: ${tableName}\nColumns: ${cols}`;

        if (schema.foreignKeys && schema.foreignKeys.length > 0) {
          const fks = schema.foreignKeys.map((fk) => 
            `  - ${fk.column} -> ${fk.refTable}(${fk.refColumn})`
          ).join('\n');
          tableDesc += `\nForeign Keys:\n${fks}`;
        }

        tableSchemas.push(tableDesc);
      } else {
        tableSchemas.push(`Table: ${tableName}`);
      }
    } catch {
      tableSchemas.push(`Table: ${tableName}`);
    }
  }

  const dialect = getDialectName(dbType);

  const contextText = [
    `Target SQL Dialect: ${dialect}`,
    tableSchemas.length > 0 
      ? `Database Schema:\n${tableSchemas.join('\n\n')}`
      : 'No schema information available.',
  ].join('\n\n');

  return contextText;
}

export function getDialectName(dbType?: string): string {
  if (!dbType) return 'SQL Standard';
  const low = dbType.toLowerCase();
  if (low.includes('postgres') || low.includes('pg')) return 'PostgreSQL';
  if (low.includes('mysql') || low.includes('mariadb')) return 'MySQL';
  if (low.includes('sqlite')) return 'SQLite';
  if (low.includes('duckdb')) return 'DuckDB';
  if (low.includes('mssql') || low.includes('sqlserver')) return 'Microsoft SQL Server';
  if (low.includes('redis')) return 'Redis';
  return 'SQL';
}

export function buildSystemPrompt(schemaContext: string, customInstructions?: string): string {
  return `You are TableGrid AI Copilot, an expert database engineer and SQL assistant.
Your job is to help users write, explain, optimize, and debug SQL queries accurately based on their database schema.

Guidelines:
1. When generating SQL, output the SQL statement inside a markdown code block (\`\`\`sql ... \`\`\`).
2. Adhere strictly to the requested SQL dialect (e.g. PostgreSQL, MySQL, SQLite) and table/column names provided in the schema.
3. Keep your explanation clear, friendly, and concise. Explain JOINs, WHERE conditions, and indexes where appropriate.
4. Highlight table and column names in backticks (\`table_name\`, \`column_name\`) in your textual explanation.
5. If the user's question is in Vietnamese, respond in Vietnamese. If in English, respond in English.

${schemaContext}

${customInstructions ? `Additional User Instructions:\n${customInstructions}` : ''}`;
}

export function extractSqlFromText(text: string): string | undefined {
  const sqlMatch = text.match(/```(?:sql|SQL)?\s*([\s\S]*?)```/);
  if (sqlMatch && sqlMatch[1]) {
    return sqlMatch[1].trim();
  }
  return undefined;
}
