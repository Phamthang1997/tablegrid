// Masking sensitive columns on the way OUT of the database — Export database, Copy database,
// Export table — so a production dump can be handed to a developer.
//
// The values are rewritten in Rust (`datagen/mask.rs`, the `mask_rows` command): its `fake` rule
// is the data generator itself, and a TypeScript twin of the generators would drift. What lives
// here is the plumbing, pure and tested:
//  - the rule types (the JSON `mask_rows` takes),
//  - `suggestMaskRule`, which proposes a rule from a column's name and type,
//  - `withMasking`, which wraps a `DumpReader`-shaped reader so every page of a masked table goes
//    through `mask_rows` before anything writes it. Every export path reads through such a reader
//    (`dumpReaderFor`, or `getTableData` directly in ExportTableDialog), so one wrapper covers SQL,
//    CSV, JSON, XLSX and the copy alike — and there is no second place to forget.
//
// A masked value is deterministic per value under the run's key (HMAC in Rust): the same e-mail
// masks the same way in every table, so the dump's JOINs and UNIQUE indexes still hold. The key is
// drawn per run (`newMaskKey`) and never stored.

export type MaskKind =
  | 'keep'
  | 'null'
  | 'redact'
  | 'partial'
  | 'emailMask'
  | 'hashEmail'
  | 'hash'
  | 'digits'
  | 'card'
  | 'fake'
  | 'dateShift';

export interface MaskRule {
  kind: MaskKind;
  options?: Record<string, unknown>;
}

/** column -> rule, for one table. */
export type TableMaskRules = Record<string, MaskRule>;
/** table -> its columns' rules. */
export type MaskRules = Record<string, TableMaskRules>;

export interface MaskPlan {
  /** The run's HMAC key (`newMaskKey`). */
  key: string;
  rules: MaskRules;
}

/** The rule kinds in the order the picker lists them. */
export const MASK_KINDS: MaskKind[] = [
  'keep', 'hashEmail', 'emailMask', 'fake', 'digits', 'card', 'partial', 'hash', 'dateShift', 'redact', 'null',
];

/** The datagen generators a `fake` rule offers (ids of `datagen/column.rs`). */
export const FAKE_GENERATORS = [
  'fullName', 'firstName', 'lastName', 'email', 'username', 'phone', 'address', 'street', 'city',
  'zipCode', 'company', 'jobTitle', 'ipv4', 'ipv6', 'macAddress', 'url', 'sentence', 'uuid',
] as const;

export interface MaskColumnInfo {
  name: string;
  type?: string;
  isPrimaryKey?: boolean;
  isForeignKey?: boolean;
}

const has = (name: string, re: RegExp) => re.test(name);

/**
 * A rule proposed from a column's name (and type), or null when the column does not look
 * sensitive. A key column is never proposed: masking a primary or foreign key rewrites the
 * relations themselves, which the user has to choose deliberately (and the panel warns about).
 *
 * The proposal favours rules that keep a dump usable: `hashEmail` rather than `emailMask` for an
 * e-mail, because `u****@example.com` collapses every Mary into one value and a UNIQUE index on
 * the column then fails the restore.
 */
export function suggestMaskRule(col: MaskColumnInfo): MaskRule | null {
  if (col.isPrimaryKey || col.isForeignKey) return null;
  // Word boundaries on `_` as well: `emailVerified` and `customer_email` both match `email`.
  const n = col.name.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase();
  const type = (col.type || '').toLowerCase();
  const isText = !type || /char|text|string|clob|json|enum|uuid/.test(type);
  const isDate = /date|time/.test(type);

  if (has(n, /(^|_)(password|passwd|pwd|pass_?hash|secret|salt|token|api_?key|otp)(_|$)/)) {
    return { kind: 'redact' };
  }
  if (has(n, /e_?mail/) && isText) return { kind: 'hashEmail' };
  if (has(n, /(^|_)(phone|mobile|tel|telephone|fax|sdt|so_?dien_?thoai|cell_?phone)(_|$)/)) return { kind: 'digits' };
  if (has(n, /(credit_?card|card_?(no|num|number)|cc_?(no|num|number)|(^|_)pan(_|$))/)) {
    return { kind: 'card', options: { keepStart: 1 } };
  }
  if (has(n, /(iban|bank_?account|account_?(no|num|number))/)) return { kind: 'digits' };
  if (has(n, /(ssn|social_?security|national_?id|passport|(^|_)cmnd(_|$)|(^|_)cccd(_|$)|tax_?(id|code)|identity_?(no|number|card))/)) {
    return { kind: 'hash', options: { length: 12 } };
  }
  if (has(n, /(birth|(^|_)dob(_|$)|ngay_?sinh)/) && (isDate || !type)) return { kind: 'dateShift', options: { days: 180 } };
  if (!isText) return null;
  if (has(n, /^(first_?name|given_?name|fname|ten)$/)) return { kind: 'fake', options: { generator: 'firstName' } };
  if (has(n, /^(last_?name|surname|family_?name|lname|ho)$/)) return { kind: 'fake', options: { generator: 'lastName' } };
  if (has(n, /(full_?name|^name_full$|(customer|contact|user|person|employee|account)_?name|display_?name|ho_?ten)/)) {
    return { kind: 'fake', options: { generator: 'fullName' } };
  }
  if (has(n, /(^|_)(user_?name|login)(_|$)/)) return { kind: 'hash', options: { prefix: 'user_', length: 10 } };
  if (has(n, /(^|_)(address|addr|street|address_?line\d?|dia_?chi)(_|$)/)) return { kind: 'fake', options: { generator: 'address' } };
  if (has(n, /(^|_)(ip|ip_?addr(ess)?|client_?ip|remote_?ip)(_|$)/)) return { kind: 'fake', options: { generator: 'ipv4' } };
  return null;
}

/** Suggestions for every column of every table; tables with nothing to propose are left out. */
export function suggestMaskRules(tables: Record<string, MaskColumnInfo[]>): MaskRules {
  const out: MaskRules = {};
  for (const [table, cols] of Object.entries(tables)) {
    const rules: TableMaskRules = {};
    for (const c of cols) {
      const r = suggestMaskRule(c);
      if (r) rules[c.name] = r;
    }
    if (Object.keys(rules).length) out[table] = rules;
  }
  return out;
}

/** The rules that actually change something, limited to `tables` when given. */
export function activeRules(rules: MaskRules, tables?: string[]): MaskRules {
  const keep = tables ? new Set(tables) : null;
  const out: MaskRules = {};
  for (const [table, cols] of Object.entries(rules)) {
    if (keep && !keep.has(table)) continue;
    const active = Object.fromEntries(Object.entries(cols).filter(([, r]) => r.kind !== 'keep'));
    if (Object.keys(active).length) out[table] = active;
  }
  return out;
}

export function countActiveRules(rules: MaskRules, tables?: string[]): number {
  return Object.values(activeRules(rules, tables)).reduce((n, cols) => n + Object.keys(cols).length, 0);
}

/** A run's key: 32 bytes from the OS RNG, hex. Never persisted — see the module comment. */
export function newMaskKey(
  rand: (a: Uint8Array<ArrayBuffer>) => Uint8Array = (a) => crypto.getRandomValues(a),
): string {
  return Array.from(rand(new Uint8Array(new ArrayBuffer(32))), (b) => b.toString(16).padStart(2, '0')).join('');
}

type PageReader = {
  getTableData(table: string, page?: number, pageSize?: number): Promise<{ rows: any[]; totalCount: number | null }>;
};

export type MaskFn = (key: string, columns: TableMaskRules, rows: any[]) => Promise<any[]>;

/**
 * The same reader, with each page of a masked table rewritten by `mask` before it is returned.
 * A failure of `mask` propagates: the export stops instead of writing what it could not mask.
 */
export function withMasking<R extends PageReader>(reader: R, plan: MaskPlan | null | undefined, mask: MaskFn): R {
  if (!plan) return reader;
  const rules = activeRules(plan.rules);
  if (!Object.keys(rules).length) return reader;
  return {
    ...reader,
    getTableData: async (table: string, page?: number, pageSize?: number) => {
      const data = await reader.getTableData(table, page, pageSize);
      const cols = rules[table];
      if (!cols || !data.rows?.length) return data;
      return { ...data, rows: await mask(plan.key, cols, data.rows) };
    },
  };
}

/** Columns that carry a rule AND are a key: the relation itself is rewritten, so the panel warns. */
export function maskedKeyColumns(rules: MaskRules, tables: Record<string, MaskColumnInfo[]>): string[] {
  const out: string[] = [];
  for (const [table, cols] of Object.entries(activeRules(rules))) {
    for (const col of Object.keys(cols)) {
      const info = tables[table]?.find((c) => c.name === col);
      if (info?.isPrimaryKey || info?.isForeignKey) out.push(`${table}.${col}`);
    }
  }
  return out;
}

// ─── Saved rules ────────────────────────────────────────────────────────────────────────────
// Kept per database scope (the caller passes `scopeKey(config, db, schema)` from connKey.ts), so
// the rules set up once for a production database are there next time. Only RULES are stored —
// never the key and never a value.

const STORE_PREFIX = 'tf_mask_rules:';

export function loadMaskRules(scope: string, storage: Pick<Storage, 'getItem'> = localStorage): MaskRules {
  try {
    const raw = storage.getItem(STORE_PREFIX + scope);
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === 'object' ? (parsed as MaskRules) : {};
  } catch {
    return {};
  }
}

export function saveMaskRules(scope: string, rules: MaskRules, storage: Pick<Storage, 'setItem'> = localStorage): void {
  try {
    storage.setItem(STORE_PREFIX + scope, JSON.stringify(rules));
  } catch {
    /* quota or a private window: the rules just are not remembered */
  }
}
