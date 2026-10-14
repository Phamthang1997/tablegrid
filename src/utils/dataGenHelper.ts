/**
 * Types and pure helpers for the Data Generator (`src-tauri/src/data_generator.rs`).
 *
 * The types are the TypeScript twin of the JSON that `get_generation_targets`,
 * `preview_generated_data` and `generate_data` exchange — change the shape in Rust and change
 * it here too, the same way `dbHelper.ts` mirrors `database.rs`.
 *
 * What is deliberately NOT here: the generators themselves. Values are produced only in Rust,
 * and the preview calls the backend, so there is no second implementation to keep in sync (see
 * the header of `data_generator.rs`). This file holds the spec plumbing — labels, option field
 * descriptions, validation — all pure, so it is unit-testable under Vitest's node environment.
 * i18n-facing helpers return translation KEYS; the component calls `t()`.
 */

// ===================== Targets (what the database offers) =====================

export interface GenFkTarget {
  refTable: string;
  refColumn: string;
}

export interface GenColumnTarget {
  name: string;
  type: string;
  nullable: boolean;
  isPrimaryKey: boolean;
  autoIncrement: boolean;
  hasDefault: boolean;
  maxLength: number | null;
  scale: number | null;
  enumValues: string[];
  fk: GenFkTarget | null;
  /** Backend's guess, from the FK, the column name and then the declared type. */
  suggestedGenerator: string;
  suggestedOptions: Record<string, unknown>;
}

export interface GenTableTarget {
  table: string;
  columns: GenColumnTarget[];
}

export interface GenTargets {
  success: boolean;
  dbType: string;
  tables: GenTableTarget[];
  /** FK-safe insertion order (parents first), computed by the backend. */
  order: string[];
  warnings: string[];
}

// ===================== Spec (what to generate) =====================

export type GenCase = 'upper' | 'lower' | 'title';

export interface GenColumnSpec {
  column: string;
  generator: string;
  nullPercent?: number;
  emptyPercent?: number;
  unique?: boolean;
  prefix?: string;
  suffix?: string;
  case?: GenCase;
  options?: Record<string, unknown>;
}

export interface GenTableSpec {
  table: string;
  rows: number;
  /** `append` (default) keeps existing rows, `truncate` deletes them first. */
  mode?: 'append' | 'truncate';
  columns: GenColumnSpec[];
}

export interface GenSpec {
  seed?: number;
  tables: GenTableSpec[];
  options?: {
    disableConstraints?: boolean;
    batchSize?: number;
    commitEveryBatches?: number;
  };
}

export interface GenProgress {
  type: 'start' | 'table' | 'progress' | 'done' | 'error';
  table?: string;
  rows?: number;
  done?: number;
  total?: number;
  totalDone?: number;
  totalRows?: number;
  tables?: string[];
  inserted?: Record<string, number>;
  elapsedMs?: number;
  cancelled?: boolean;
  message?: string;
}

export interface GenResult {
  success: boolean;
  cancelled?: boolean;
  elapsedMs?: number;
  inserted?: Record<string, number>;
  warnings?: string[];
}

export interface GenPreview {
  success: boolean;
  columns: string[];
  data: Record<string, unknown>[];
  warnings: string[];
}

// ===================== Generator catalogue =====================

/**
 * Generator ids grouped for the dropdown, in display order. Must stay in step with the `match`
 * in `ColState::base_cell` — an id here that Rust does not know fails at generation time with
 * "Generator '<id>' không được hỗ trợ".
 */
export const GENERATOR_GROUPS: { groupKey: string; ids: string[] }[] = [
  {
    groupKey: 'dataGen.groupBasic',
    ids: [
      'skip',
      'null',
      'integer',
      'bigint',
      'decimal',
      'float',
      'bool',
      'sequence',
      'string',
      'text',
      'paragraph',
      'sentence',
      'word',
      'title',
      'uuid',
      'json',
      'blob',
      'vector',
      'date',
      'time',
      'datetime',
      'year',
      'latitude',
      'longitude',
    ],
  },
  {
    groupKey: 'dataGen.groupPattern',
    ids: ['template', 'regex', 'list', 'weightedList', 'enumValues', 'expression', 'foreignKey'],
  },
  {
    groupKey: 'dataGen.groupPerson',
    ids: ['firstName', 'lastName', 'fullName', 'username', 'email', 'password', 'phone', 'gender'],
  },
  {
    groupKey: 'dataGen.groupPlace',
    ids: ['address', 'street', 'city', 'country', 'countryCode', 'zipCode', 'timezone'],
  },
  {
    groupKey: 'dataGen.groupBusiness',
    ids: [
      'company',
      'department',
      'jobTitle',
      'productName',
      'sku',
      'currencyCode',
      'orderStatus',
      'creditCard',
    ],
  },
  {
    groupKey: 'dataGen.groupTech',
    ids: ['ipv4', 'ipv6', 'macAddress', 'domain', 'url', 'hexColor', 'mimeType', 'fileName'],
  },
];

/**
 * Generator id -> label key. A literal map rather than `t(\`dataGen.gen_${id}\`)`: a dynamic key
 * is not type-checked and silently renders the raw key when it is missing (see CLAUDE.md).
 */
export const GENERATOR_LABEL_KEYS: Record<string, string> = {
  skip: 'dataGen.genSkip',
  null: 'dataGen.genNull',
  integer: 'dataGen.genInteger',
  bigint: 'dataGen.genBigint',
  decimal: 'dataGen.genDecimal',
  float: 'dataGen.genFloat',
  bool: 'dataGen.genBool',
  sequence: 'dataGen.genSequence',
  string: 'dataGen.genString',
  text: 'dataGen.genText',
  paragraph: 'dataGen.genParagraph',
  sentence: 'dataGen.genSentence',
  word: 'dataGen.genWord',
  title: 'dataGen.genTitle',
  uuid: 'dataGen.genUuid',
  json: 'dataGen.genJson',
  blob: 'dataGen.genBlob',
  vector: 'dataGen.genVector',
  date: 'dataGen.genDate',
  time: 'dataGen.genTime',
  datetime: 'dataGen.genDatetime',
  year: 'dataGen.genYear',
  latitude: 'dataGen.genLatitude',
  longitude: 'dataGen.genLongitude',
  template: 'dataGen.genTemplate',
  regex: 'dataGen.genRegex',
  list: 'dataGen.genList',
  weightedList: 'dataGen.genWeightedList',
  enumValues: 'dataGen.genEnumValues',
  expression: 'dataGen.genExpression',
  foreignKey: 'dataGen.genForeignKey',
  firstName: 'dataGen.genFirstName',
  lastName: 'dataGen.genLastName',
  fullName: 'dataGen.genFullName',
  username: 'dataGen.genUsername',
  email: 'dataGen.genEmail',
  password: 'dataGen.genPassword',
  phone: 'dataGen.genPhone',
  gender: 'dataGen.genGender',
  address: 'dataGen.genAddress',
  street: 'dataGen.genStreet',
  city: 'dataGen.genCity',
  country: 'dataGen.genCountry',
  countryCode: 'dataGen.genCountryCode',
  zipCode: 'dataGen.genZipCode',
  timezone: 'dataGen.genTimezone',
  company: 'dataGen.genCompany',
  department: 'dataGen.genDepartment',
  jobTitle: 'dataGen.genJobTitle',
  productName: 'dataGen.genProductName',
  sku: 'dataGen.genSku',
  currencyCode: 'dataGen.genCurrencyCode',
  orderStatus: 'dataGen.genOrderStatus',
  creditCard: 'dataGen.genCreditCard',
  ipv4: 'dataGen.genIpv4',
  ipv6: 'dataGen.genIpv6',
  macAddress: 'dataGen.genMacAddress',
  domain: 'dataGen.genDomain',
  url: 'dataGen.genUrl',
  hexColor: 'dataGen.genHexColor',
  mimeType: 'dataGen.genMimeType',
  fileName: 'dataGen.genFileName',
};

export function generatorLabelKey(id: string): string {
  return GENERATOR_LABEL_KEYS[id] ?? 'dataGen.genUnknown';
}

export function generatorGroupKey(id: string): string {
  return GENERATOR_GROUPS.find((g) => g.ids.includes(id))?.groupKey ?? 'dataGen.groupBasic';
}

export function isKnownGenerator(id: string): boolean {
  return id in GENERATOR_LABEL_KEYS;
}

// ===================== Option fields =====================

export type OptionFieldKind = 'number' | 'text' | 'date' | 'bool' | 'select' | 'list' | 'sql';

export interface OptionField {
  /** Key inside `GenColumnSpec.options`. */
  key: string;
  kind: OptionFieldKind;
  labelKey: string;
  /** For `select`: the allowed raw values; labels come from `optionChoiceLabelKey`. */
  choices?: string[];
  placeholderKey?: string;
}

const NUMBER_RANGE: OptionField[] = [
  { key: 'min', kind: 'number', labelKey: 'dataGen.optMin' },
  { key: 'max', kind: 'number', labelKey: 'dataGen.optMax' },
  { key: 'distribution', kind: 'select', labelKey: 'dataGen.optDistribution', choices: ['uniform', 'normal', 'exponential'] },
];

const LOCALE_FIELD: OptionField = {
  key: 'locale',
  kind: 'select',
  labelKey: 'dataGen.optLocale',
  choices: ['en', 'vi'],
};

/**
 * Which inputs the options panel shows per generator. Declarative on purpose: the dialog renders
 * this list instead of carrying a switch per generator, so adding a generator is one entry here
 * plus one label key.
 */
export const OPTION_FIELDS: Record<string, OptionField[]> = {
  integer: NUMBER_RANGE,
  bigint: NUMBER_RANGE,
  float: NUMBER_RANGE,
  year: [
    { key: 'min', kind: 'number', labelKey: 'dataGen.optMin' },
    { key: 'max', kind: 'number', labelKey: 'dataGen.optMax' },
  ],
  decimal: [...NUMBER_RANGE, { key: 'scale', kind: 'number', labelKey: 'dataGen.optScale' }],
  bool: [{ key: 'truePercent', kind: 'number', labelKey: 'dataGen.optTruePercent' }],
  sequence: [
    { key: 'start', kind: 'number', labelKey: 'dataGen.optStart' },
    { key: 'step', kind: 'number', labelKey: 'dataGen.optStep' },
  ],
  string: [
    { key: 'minLength', kind: 'number', labelKey: 'dataGen.optMinLength' },
    { key: 'maxLength', kind: 'number', labelKey: 'dataGen.optMaxLength' },
    {
      key: 'charset',
      kind: 'select',
      labelKey: 'dataGen.optCharset',
      choices: ['alnum', 'alpha', 'ALPHA', 'digits', 'hex'],
    },
  ],
  password: [{ key: 'length', kind: 'number', labelKey: 'dataGen.optLength' }],
  text: [{ key: 'maxLength', kind: 'number', labelKey: 'dataGen.optMaxLength' }],
  paragraph: [{ key: 'maxLength', kind: 'number', labelKey: 'dataGen.optMaxLength' }],
  blob: [{ key: 'length', kind: 'number', labelKey: 'dataGen.optByteLength' }],
  vector: [
    { key: 'dimensions', kind: 'number', labelKey: 'dataGen.optDimensions' },
    { key: 'normalize', kind: 'bool', labelKey: 'dataGen.optNormalize' },
    { key: 'sparse', kind: 'bool', labelKey: 'dataGen.optSparse' },
    { key: 'nonZero', kind: 'number', labelKey: 'dataGen.optNonZero' },
  ],
  date: [
    { key: 'min', kind: 'date', labelKey: 'dataGen.optMinDate', placeholderKey: 'dataGen.phDate' },
    { key: 'max', kind: 'date', labelKey: 'dataGen.optMaxDate', placeholderKey: 'dataGen.phDate' },
  ],
  datetime: [
    { key: 'min', kind: 'text', labelKey: 'dataGen.optMinDate', placeholderKey: 'dataGen.phDateTime' },
    { key: 'max', kind: 'text', labelKey: 'dataGen.optMaxDate', placeholderKey: 'dataGen.phDateTime' },
  ],
  template: [
    { key: 'pattern', kind: 'text', labelKey: 'dataGen.optPattern', placeholderKey: 'dataGen.phTemplate' },
  ],
  regex: [
    { key: 'pattern', kind: 'text', labelKey: 'dataGen.optRegex', placeholderKey: 'dataGen.phRegex' },
  ],
  list: [{ key: 'values', kind: 'list', labelKey: 'dataGen.optValues', placeholderKey: 'dataGen.phList' }],
  enumValues: [{ key: 'values', kind: 'list', labelKey: 'dataGen.optValues', placeholderKey: 'dataGen.phList' }],
  weightedList: [
    { key: 'values', kind: 'list', labelKey: 'dataGen.optWeightedValues', placeholderKey: 'dataGen.phWeightedList' },
  ],
  expression: [{ key: 'sql', kind: 'sql', labelKey: 'dataGen.optSql', placeholderKey: 'dataGen.phSql' }],
  // No "only existing values" switch: values always come from the parent table *plus* whatever
  // this run generated for it, which is the only combination that works for both an
  // auto-increment parent key and a reference cycle. See `prepare_table` in data_generator.rs.
  foreignKey: [
    { key: 'refTable', kind: 'text', labelKey: 'dataGen.optRefTable' },
    { key: 'refColumn', kind: 'text', labelKey: 'dataGen.optRefColumn' },
  ],
  email: [{ key: 'domains', kind: 'list', labelKey: 'dataGen.optDomains', placeholderKey: 'dataGen.phDomains' }, LOCALE_FIELD],
  firstName: [LOCALE_FIELD],
  lastName: [LOCALE_FIELD],
  fullName: [LOCALE_FIELD],
  username: [LOCALE_FIELD],
  phone: [LOCALE_FIELD],
  city: [LOCALE_FIELD],
  street: [LOCALE_FIELD],
  address: [LOCALE_FIELD],
  json: [{ key: 'keys', kind: 'list', labelKey: 'dataGen.optJsonKeys', placeholderKey: 'dataGen.phList' }],
};

export function optionFields(generator: string): OptionField[] {
  return OPTION_FIELDS[generator] ?? [];
}

/** Literal keys for the `select` choices, for the same reason as `GENERATOR_LABEL_KEYS`. */
const CHOICE_LABEL_KEYS: Record<string, string> = {
  uniform: 'dataGen.distUniform',
  normal: 'dataGen.distNormal',
  exponential: 'dataGen.distExponential',
  alnum: 'dataGen.charsetAlnum',
  alpha: 'dataGen.charsetAlpha',
  ALPHA: 'dataGen.charsetAlphaUpper',
  digits: 'dataGen.charsetDigits',
  hex: 'dataGen.charsetHex',
  en: 'dataGen.localeEn',
  vi: 'dataGen.localeVi',
};

export function optionChoiceLabelKey(value: string): string {
  return CHOICE_LABEL_KEYS[value] ?? 'dataGen.genUnknown';
}

/** Generators whose output is text, i.e. where prefix/suffix/case/empty% do anything. */
export function isTextGenerator(generator: string): boolean {
  return !['integer', 'bigint', 'decimal', 'float', 'bool', 'sequence', 'year', 'latitude', 'longitude', 'blob', 'vector', 'expression', 'skip', 'null'].includes(
    generator,
  );
}

// ===================== Spec construction =====================

export function columnSpecFromTarget(col: GenColumnTarget): GenColumnSpec {
  const spec: GenColumnSpec = {
    column: col.name,
    generator: col.suggestedGenerator,
    options: { ...col.suggestedOptions },
  };
  // A nullable column gets a few NULLs so the generated data exercises them; a NOT NULL one
  // must never get any.
  if (col.nullable && col.suggestedGenerator !== 'skip') spec.nullPercent = 5;
  // A unique-looking key stays unique. PKs that are not auto-increment come back as `sequence`,
  // which is already collision-free.
  if (col.isPrimaryKey && col.suggestedGenerator !== 'skip' && col.suggestedGenerator !== 'sequence') {
    spec.unique = true;
  }
  return spec;
}

export function tableSpecFromTarget(target: GenTableTarget, rows: number): GenTableSpec {
  return {
    table: target.table,
    rows,
    mode: 'append',
    columns: target.columns.map(columnSpecFromTarget),
  };
}

// ===================== Value space (unique feasibility) =====================

/**
 * Number of distinct strings a template can produce. TS twin of `template_space` in
 * `data_generator.rs`; it only feeds the "unique may run out" warning, never generation, so a
 * drift here can at worst mean a missing or spurious warning.
 */
export function templateSpace(pattern: string): number {
  let total = 1;
  const chars = [...pattern];
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i];
    if (c === '\\') {
      i++;
      continue;
    }
    const n = c === '#' ? 10 : c === '@' || c === '?' ? 26 : c === '*' ? 36 : 1;
    total *= n;
    if (!Number.isFinite(total)) return Number.POSITIVE_INFINITY;
  }
  return total;
}

/**
 * How many distinct values the column can produce, or `null` when it cannot be estimated
 * (regex, lorem text, names — bounded but not worth counting).
 */
export function estimateValueSpace(spec: GenColumnSpec): number | null {
  const opts = spec.options ?? {};
  const num = (key: string): number | undefined => {
    const v = opts[key];
    if (typeof v === 'number') return v;
    if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
    return undefined;
  };
  switch (spec.generator) {
    case 'sequence':
      return Number.POSITIVE_INFINITY;
    case 'bool':
    case 'gender':
      return 2;
    case 'integer':
    case 'bigint':
    case 'year': {
      const min = num('min') ?? 1;
      const max = num('max') ?? (spec.generator === 'bigint' ? 1_000_000_000 : 100_000);
      return Math.abs(max - min) + 1;
    }
    case 'decimal': {
      const min = num('min') ?? 0;
      const max = num('max') ?? 10_000;
      const scale = num('scale') ?? 2;
      return Math.abs(max - min) * Math.pow(10, scale) + 1;
    }
    case 'template':
      return templateSpace(String(opts.pattern ?? '??-####'));
    case 'list':
    case 'enumValues':
    case 'weightedList':
      return Array.isArray(opts.values) ? opts.values.length : 0;
    case 'foreignKey':
      // Bounded by the parent table, which only the backend knows.
      return null;
    case 'string': {
      const minLen = num('minLength') ?? 5;
      const maxLen = Math.max(num('maxLength') ?? 12, minLen);
      const alphabet =
        opts.charset === 'digits' ? 10 : opts.charset === 'hex' ? 16 : opts.charset === 'alpha' || opts.charset === 'ALPHA' ? 26 : 36;
      // Only the longest length matters for the order of magnitude.
      const space = Math.pow(alphabet, maxLen);
      return Number.isFinite(space) ? space : Number.POSITIVE_INFINITY;
    }
    case 'uuid':
      return Number.POSITIVE_INFINITY;
    default:
      return null;
  }
}

// ===================== Validation =====================

export interface GenIssue {
  level: 'error' | 'warning';
  table?: string;
  column?: string;
  /** Translation key; `params` feeds the `{{...}}` placeholders. */
  key: string;
  params?: Record<string, string | number>;
}

const DATE_GENERATORS = ['date', 'datetime'];

/**
 * Everything that can be judged without touching the database. An `error` blocks the run; a
 * `warning` is shown but does not. What is NOT validated here (and cannot be): whether a regex is
 * inside the supported subset, and whether a FK parent has rows — both are reported by the
 * backend, which happens on the first preview.
 */
export function validateSpec(spec: GenSpec): GenIssue[] {
  const issues: GenIssue[] = [];
  if (!spec.tables.length) {
    issues.push({ level: 'error', key: 'dataGen.errNoTable' });
    return issues;
  }

  for (const table of spec.tables) {
    if (!Number.isFinite(table.rows) || table.rows <= 0) {
      issues.push({ level: 'error', table: table.table, key: 'dataGen.errRows', params: { table: table.table } });
    }
    const active = table.columns.filter((c) => c.generator !== 'skip');
    if (!active.length) {
      issues.push({ level: 'error', table: table.table, key: 'dataGen.errAllSkipped', params: { table: table.table } });
    }

    for (const col of active) {
      const where = { table: table.table, column: col.column };
      const params = { table: table.table, column: col.column };
      const opts = col.options ?? {};

      if (!isKnownGenerator(col.generator)) {
        issues.push({ level: 'error', ...where, key: 'dataGen.errUnknownGenerator', params: { ...params, name: col.generator } });
        continue;
      }
      for (const [key, value] of [
        ['nullPercent', col.nullPercent],
        ['emptyPercent', col.emptyPercent],
      ] as const) {
        if (value !== undefined && (value < 0 || value > 100)) {
          issues.push({ level: 'error', ...where, key: 'dataGen.errPercent', params: { ...params, field: key } });
        }
      }
      if (col.unique && col.nullPercent === 100) {
        issues.push({ level: 'error', ...where, key: 'dataGen.errUniqueAllNull', params });
      }

      const numeric = ['integer', 'bigint', 'decimal', 'float', 'year'].includes(col.generator);
      if (numeric) {
        const min = Number(opts.min);
        const max = Number(opts.max);
        if (Number.isFinite(min) && Number.isFinite(max) && min > max) {
          issues.push({ level: 'error', ...where, key: 'dataGen.errMinMax', params });
        }
        const scale = Number(opts.scale);
        if (opts.scale !== undefined && (!Number.isFinite(scale) || scale < 0 || scale > 10)) {
          issues.push({ level: 'error', ...where, key: 'dataGen.errScale', params });
        }
      }
      if (DATE_GENERATORS.includes(col.generator)) {
        const min = String(opts.min ?? '').trim();
        const max = String(opts.max ?? '').trim();
        if (min && max && min > max) {
          issues.push({ level: 'error', ...where, key: 'dataGen.errMinMax', params });
        }
      }
      if (['list', 'enumValues', 'weightedList'].includes(col.generator)) {
        if (!Array.isArray(opts.values) || opts.values.length === 0) {
          issues.push({ level: 'error', ...where, key: 'dataGen.errListEmpty', params });
        }
      }
      if ((col.generator === 'template' || col.generator === 'regex') && !String(opts.pattern ?? '').trim()) {
        issues.push({ level: 'error', ...where, key: 'dataGen.errPatternEmpty', params });
      }
      if (col.generator === 'expression' && !String(opts.sql ?? '').trim()) {
        issues.push({ level: 'error', ...where, key: 'dataGen.errExprEmpty', params });
      }
      if (col.generator === 'vector') {
        // Rust clamps these rather than failing, so a typo would quietly generate something else.
        const dims = Number(opts.dimensions ?? 3);
        const nonZero = Number(opts.nonZero ?? 10);
        const badDims = !Number.isInteger(dims) || dims < 1 || dims > 16000;
        const badNonZero = !!opts.sparse && (!Number.isInteger(nonZero) || nonZero < 1 || nonZero > dims);
        if (badDims || badNonZero) {
          issues.push({ level: 'error', ...where, key: 'dataGen.errVectorDims', params });
        }
      }
      if (col.generator === 'foreignKey' && (!String(opts.refTable ?? '').trim() || !String(opts.refColumn ?? '').trim())) {
        issues.push({ level: 'error', ...where, key: 'dataGen.errFkMissing', params });
      }

      // Feasibility of `unique`: catching this here beats failing after N inserted rows.
      if (col.unique && table.rows > 0) {
        const space = estimateValueSpace(col);
        if (space !== null && space < table.rows) {
          issues.push({
            level: space === 0 ? 'error' : 'warning',
            ...where,
            key: 'dataGen.warnUniqueSpace',
            params: { ...params, n: Math.floor(space), rows: table.rows },
          });
        }
      }
    }
  }

  return issues;
}

export function hasBlockingIssue(issues: GenIssue[]): boolean {
  return issues.some((i) => i.level === 'error');
}

// ===================== Formatting =====================

/** `1 234 567` in the active locale. */
export function formatCount(n: number, locale: string): string {
  return Number(n || 0).toLocaleString(locale);
}

/**
 * `12.3s` / `1m 05s`. Takes `t` as an argument because a module-level helper cannot call the
 * hook (see `formatRestoreEta` in `ConnectionManager.tsx`).
 */
export function formatDuration(ms: number, t: (key: string, params?: Record<string, unknown>) => string): string {
  if (!Number.isFinite(ms) || ms < 0) return '';
  if (ms < 1000) return t('dataGen.durationMs', { n: Math.round(ms) });
  const totalSeconds = ms / 1000;
  if (totalSeconds < 60) return t('dataGen.durationSec', { n: totalSeconds.toFixed(1) });
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = Math.floor(totalSeconds % 60);
  return t('dataGen.durationMin', { m: minutes, s: String(seconds).padStart(2, '0') });
}

/** Remaining time from the rows done so far. `null` until there is enough to extrapolate. */
export function estimateRemainingMs(doneRows: number, totalRows: number, elapsedMs: number): number | null {
  if (doneRows <= 0 || totalRows <= doneRows || elapsedMs <= 0) return null;
  const perRow = elapsedMs / doneRows;
  return Math.round(perRow * (totalRows - doneRows));
}

/** Total rows a spec will insert. */
export function totalRowsOf(spec: GenSpec): number {
  return spec.tables.reduce((sum, t) => sum + (Number.isFinite(t.rows) ? t.rows : 0), 0);
}

/**
 * Parses the textarea used by `list` / `weightedList` / `domains`.
 * One value per line; `value | weight` for a weighted list (weight defaults to 1).
 */
export function parseListInput(text: string, weighted: boolean): unknown[] {
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '');
  if (!weighted) return lines;
  return lines.map((line) => {
    const idx = line.lastIndexOf('|');
    if (idx < 0) return [line, 1];
    const weight = Number(line.slice(idx + 1).trim());
    return [line.slice(0, idx).trim(), Number.isFinite(weight) && weight > 0 ? weight : 1];
  });
}

/** Inverse of `parseListInput`, for filling the textarea from an existing spec. */
export function formatListInput(values: unknown[] | undefined, weighted: boolean): string {
  if (!Array.isArray(values)) return '';
  return values
    .map((v) => {
      if (weighted && Array.isArray(v)) return `${v[0] ?? ''} | ${v[1] ?? 1}`;
      if (v === null || v === undefined) return '';
      return typeof v === 'object' ? JSON.stringify(v) : String(v);
    })
    .join('\n');
}
