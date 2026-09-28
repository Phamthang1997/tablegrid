import { describe, it, expect } from 'vitest';
import en from '../../i18n/locales/en';
import {
  GENERATOR_GROUPS,
  GENERATOR_LABEL_KEYS,
  OPTION_FIELDS,
  columnSpecFromTarget,
  estimateRemainingMs,
  estimateValueSpace,
  formatDuration,
  formatListInput,
  generatorGroupKey,
  generatorLabelKey,
  hasBlockingIssue,
  isKnownGenerator,
  isTextGenerator,
  optionChoiceLabelKey,
  optionFields,
  parseListInput,
  tableSpecFromTarget,
  templateSpace,
  totalRowsOf,
  validateSpec,
  type GenColumnSpec,
  type GenColumnTarget,
  type GenSpec,
} from '../dataGenHelper';

/** Resolves a `dataGen.x` key against the en dictionary so a typo fails the test. */
const resolve = (key: string): unknown => {
  const [ns, leaf] = key.split('.');
  return (en as Record<string, Record<string, unknown>>)[ns]?.[leaf];
};

const col = (over: Partial<GenColumnSpec> = {}): GenColumnSpec => ({
  column: 'c',
  generator: 'integer',
  ...over,
});

const spec = (over: Partial<GenSpec> = {}): GenSpec => ({
  seed: 1,
  tables: [{ table: 't', rows: 10, columns: [col()] }],
  ...over,
});

const target = (over: Partial<GenColumnTarget> = {}): GenColumnTarget => ({
  name: 'id',
  type: 'int',
  nullable: false,
  isPrimaryKey: false,
  autoIncrement: false,
  hasDefault: false,
  maxLength: null,
  scale: null,
  enumValues: [],
  fk: null,
  suggestedGenerator: 'integer',
  suggestedOptions: { min: 1, max: 100 },
  ...over,
});

describe('generator catalogue', () => {
  it('has a label key for every generator offered in the dropdown', () => {
    for (const group of GENERATOR_GROUPS) {
      for (const id of group.ids) {
        expect(GENERATOR_LABEL_KEYS[id], `missing label for ${id}`).toBeTruthy();
        expect(resolve(generatorLabelKey(id)), `untranslated ${id}`).toBeTruthy();
      }
    }
  });

  it('offers every labelled generator somewhere in the dropdown', () => {
    const offered = new Set(GENERATOR_GROUPS.flatMap((g) => g.ids));
    for (const id of Object.keys(GENERATOR_LABEL_KEYS)) {
      expect(offered.has(id), `${id} has a label but no group`).toBe(true);
    }
  });

  it('translates every group name', () => {
    for (const group of GENERATOR_GROUPS) {
      expect(resolve(group.groupKey), `untranslated ${group.groupKey}`).toBeTruthy();
    }
  });

  it('falls back instead of throwing on an unknown generator', () => {
    expect(generatorLabelKey('nope')).toBe('dataGen.genUnknown');
    expect(resolve('dataGen.genUnknown')).toBeTruthy();
    expect(isKnownGenerator('nope')).toBe(false);
    expect(isKnownGenerator('email')).toBe(true);
    expect(generatorGroupKey('email')).toBe('dataGen.groupPerson');
    expect(generatorGroupKey('nope')).toBe('dataGen.groupBasic');
  });

  it('translates every option field label, placeholder and choice', () => {
    for (const [generator, fields] of Object.entries(OPTION_FIELDS)) {
      expect(isKnownGenerator(generator), `${generator} has options but no label`).toBe(true);
      for (const field of fields) {
        expect(resolve(field.labelKey), `untranslated ${field.labelKey}`).toBeTruthy();
        if (field.placeholderKey) {
          expect(resolve(field.placeholderKey), `untranslated ${field.placeholderKey}`).toBeTruthy();
        }
        for (const choice of field.choices ?? []) {
          expect(resolve(optionChoiceLabelKey(choice)), `untranslated choice ${choice}`).toBeTruthy();
        }
      }
    }
  });

  it('knows which generators produce text (prefix/suffix/case apply)', () => {
    expect(isTextGenerator('email')).toBe(true);
    expect(isTextGenerator('template')).toBe(true);
    expect(isTextGenerator('integer')).toBe(false);
    expect(isTextGenerator('bool')).toBe(false);
    expect(isTextGenerator('expression')).toBe(false);
  });

  it('has no option fields for generators that take none', () => {
    expect(optionFields('uuid')).toEqual([]);
    expect(optionFields('country')).toEqual([]);
  });
});

describe('templateSpace', () => {
  // Same cases as the Rust `template_space` assertions.
  it('counts the placeholders', () => {
    expect(templateSpace('@?-####')).toBe(26 * 26 * 10_000);
    expect(templateSpace('*')).toBe(36);
    expect(templateSpace('abc')).toBe(1);
    expect(templateSpace('')).toBe(1);
  });

  it('treats an escaped placeholder as a literal', () => {
    expect(templateSpace('\\#\\#')).toBe(1);
    expect(templateSpace('\\#?')).toBe(26);
  });
});

describe('estimateValueSpace', () => {
  it('counts integer ranges inclusively', () => {
    expect(estimateValueSpace(col({ generator: 'integer', options: { min: 1, max: 10 } }))).toBe(10);
    expect(estimateValueSpace(col({ generator: 'integer', options: { min: 5, max: 5 } }))).toBe(1);
  });

  it('accepts numeric strings from the inputs', () => {
    expect(estimateValueSpace(col({ generator: 'integer', options: { min: '1', max: '4' } }))).toBe(4);
  });

  it('counts list entries', () => {
    expect(estimateValueSpace(col({ generator: 'list', options: { values: ['a', 'b'] } }))).toBe(2);
    expect(estimateValueSpace(col({ generator: 'list', options: {} }))).toBe(0);
  });

  it('treats sequence and uuid as unbounded', () => {
    expect(estimateValueSpace(col({ generator: 'sequence' }))).toBe(Number.POSITIVE_INFINITY);
    expect(estimateValueSpace(col({ generator: 'uuid' }))).toBe(Number.POSITIVE_INFINITY);
  });

  it('gives up where only the backend knows', () => {
    expect(estimateValueSpace(col({ generator: 'foreignKey' }))).toBeNull();
    expect(estimateValueSpace(col({ generator: 'firstName' }))).toBeNull();
    expect(estimateValueSpace(col({ generator: 'regex', options: { pattern: '\\d{4}' } }))).toBeNull();
  });

  it('accounts for the scale of a decimal', () => {
    expect(estimateValueSpace(col({ generator: 'decimal', options: { min: 0, max: 1, scale: 2 } }))).toBe(101);
  });
});

describe('validateSpec', () => {
  const keysOf = (issues: ReturnType<typeof validateSpec>) => issues.map((i) => i.key);

  it('accepts a plain spec', () => {
    expect(validateSpec(spec())).toEqual([]);
  });

  it('translates every message it can emit', () => {
    const cases: GenSpec[] = [
      { tables: [] },
      spec({ tables: [{ table: 't', rows: 0, columns: [col()] }] }),
      spec({ tables: [{ table: 't', rows: 5, columns: [col({ generator: 'skip' })] }] }),
      spec({ tables: [{ table: 't', rows: 5, columns: [col({ generator: 'nope' })] }] }),
      spec({ tables: [{ table: 't', rows: 5, columns: [col({ nullPercent: 120 })] }] }),
      spec({ tables: [{ table: 't', rows: 5, columns: [col({ unique: true, nullPercent: 100 })] }] }),
      spec({ tables: [{ table: 't', rows: 5, columns: [col({ options: { min: 9, max: 1 } })] }] }),
      spec({ tables: [{ table: 't', rows: 5, columns: [col({ options: { min: 1, max: 9, scale: 99 } })] }] }),
      spec({ tables: [{ table: 't', rows: 5, columns: [col({ generator: 'list', options: {} })] }] }),
      spec({ tables: [{ table: 't', rows: 5, columns: [col({ generator: 'template', options: { pattern: ' ' } })] }] }),
      spec({ tables: [{ table: 't', rows: 5, columns: [col({ generator: 'expression', options: {} })] }] }),
      spec({ tables: [{ table: 't', rows: 5, columns: [col({ generator: 'foreignKey', options: { refTable: 'p' } })] }] }),
      spec({ tables: [{ table: 't', rows: 500, columns: [col({ generator: 'template', unique: true, options: { pattern: '##' } })] }] }),
    ];
    const emitted = new Set(cases.flatMap((c) => keysOf(validateSpec(c))));
    expect(emitted.size).toBeGreaterThan(0);
    for (const key of emitted) {
      expect(resolve(key), `untranslated ${key}`).toBeTruthy();
    }
  });

  it('rejects an empty table list', () => {
    expect(keysOf(validateSpec({ tables: [] }))).toEqual(['dataGen.errNoTable']);
  });

  it('rejects a non-positive row count', () => {
    expect(keysOf(validateSpec(spec({ tables: [{ table: 't', rows: 0, columns: [col()] }] })))).toContain(
      'dataGen.errRows',
    );
  });

  it('rejects a table whose every column is skipped', () => {
    const issues = validateSpec(spec({ tables: [{ table: 't', rows: 3, columns: [col({ generator: 'skip' })] }] }));
    expect(keysOf(issues)).toContain('dataGen.errAllSkipped');
  });

  it('rejects min > max for numbers and for dates', () => {
    expect(keysOf(validateSpec(spec({ tables: [{ table: 't', rows: 3, columns: [col({ options: { min: 9, max: 1 } })] }] })))).toContain(
      'dataGen.errMinMax',
    );
    expect(
      keysOf(
        validateSpec(
          spec({
            tables: [{ table: 't', rows: 3, columns: [col({ generator: 'date', options: { min: '2026-01-01', max: '2025-01-01' } })] }],
          }),
        ),
      ),
    ).toContain('dataGen.errMinMax');
  });

  it('accepts equal min and max', () => {
    expect(validateSpec(spec({ tables: [{ table: 't', rows: 3, columns: [col({ options: { min: 4, max: 4 } })] }] }))).toEqual([]);
  });

  it('rejects unique with 100% NULL', () => {
    expect(
      keysOf(validateSpec(spec({ tables: [{ table: 't', rows: 3, columns: [col({ unique: true, nullPercent: 100 })] }] }))),
    ).toContain('dataGen.errUniqueAllNull');
  });

  it('warns — not blocks — when a unique column may run out of values', () => {
    const issues = validateSpec(
      spec({ tables: [{ table: 't', rows: 500, columns: [col({ generator: 'template', unique: true, options: { pattern: '##' } })] }] }),
    );
    expect(issues).toHaveLength(1);
    expect(issues[0].level).toBe('warning');
    expect(issues[0].key).toBe('dataGen.warnUniqueSpace');
    expect(issues[0].params).toMatchObject({ n: 100, rows: 500 });
    expect(hasBlockingIssue(issues)).toBe(false);
  });

  it('blocks when the value space is empty', () => {
    const issues = validateSpec(
      spec({ tables: [{ table: 't', rows: 5, columns: [col({ generator: 'list', unique: true, options: { values: [] } })] }] }),
    );
    expect(hasBlockingIssue(issues)).toBe(true);
  });

  it('does not warn about unique on a foreign key (only the backend knows the parent)', () => {
    const issues = validateSpec(
      spec({
        tables: [
          {
            table: 't',
            rows: 10_000,
            columns: [col({ generator: 'foreignKey', unique: true, options: { refTable: 'p', refColumn: 'id' } })],
          },
        ],
      }),
    );
    expect(issues).toEqual([]);
  });

  it('reports the table and column of each issue', () => {
    const issues = validateSpec(
      spec({ tables: [{ table: 'orders', rows: 3, columns: [col({ column: 'total', options: { min: 9, max: 1 } })] }] }),
    );
    expect(issues[0]).toMatchObject({ table: 'orders', column: 'total', level: 'error' });
  });
});

describe('spec construction from targets', () => {
  it('carries the suggestion over', () => {
    const s = columnSpecFromTarget(target({ suggestedGenerator: 'email', suggestedOptions: { locale: 'vi' } }));
    expect(s).toMatchObject({ column: 'id', generator: 'email', options: { locale: 'vi' } });
  });

  it('adds NULLs only where the column allows them', () => {
    expect(columnSpecFromTarget(target({ nullable: true })).nullPercent).toBe(5);
    expect(columnSpecFromTarget(target({ nullable: false })).nullPercent).toBeUndefined();
    expect(columnSpecFromTarget(target({ nullable: true, suggestedGenerator: 'skip' })).nullPercent).toBeUndefined();
  });

  it('keeps a primary key unique, but not when it is already a sequence', () => {
    expect(columnSpecFromTarget(target({ isPrimaryKey: true, suggestedGenerator: 'uuid' })).unique).toBe(true);
    expect(columnSpecFromTarget(target({ isPrimaryKey: true, suggestedGenerator: 'sequence' })).unique).toBeUndefined();
    expect(columnSpecFromTarget(target({ isPrimaryKey: true, suggestedGenerator: 'skip' })).unique).toBeUndefined();
  });

  it('does not share the options object with the target', () => {
    const t = target({ suggestedOptions: { min: 1 } });
    const s = columnSpecFromTarget(t);
    (s.options as Record<string, unknown>).min = 999;
    expect(t.suggestedOptions.min).toBe(1);
  });

  it('builds a whole table spec that validates', () => {
    const s = tableSpecFromTarget({ table: 'users', columns: [target(), target({ name: 'email', suggestedGenerator: 'email' })] }, 100);
    expect(s.table).toBe('users');
    expect(s.rows).toBe(100);
    expect(s.mode).toBe('append');
    expect(validateSpec({ tables: [s] })).toEqual([]);
  });
});

describe('list input', () => {
  it('round-trips a plain list', () => {
    expect(parseListInput('a\n b \n\nc\n', false)).toEqual(['a', 'b', 'c']);
    expect(formatListInput(['a', 'b'], false)).toBe('a\nb');
  });

  it('parses weights and defaults them to 1', () => {
    expect(parseListInput('active | 80\nbanned|5\nidle', true)).toEqual([
      ['active', 80],
      ['banned', 5],
      ['idle', 1],
    ]);
  });

  it('ignores a non-numeric or non-positive weight', () => {
    expect(parseListInput('a | abc\nb | -3', true)).toEqual([
      ['a', 1],
      ['b', 1],
    ]);
  });

  it('keeps a value that itself contains a pipe', () => {
    expect(parseListInput('a|b | 2', true)).toEqual([['a|b', 2]]);
  });

  it('round-trips a weighted list', () => {
    expect(formatListInput([['active', 80]], true)).toBe('active | 80');
    expect(parseListInput(formatListInput([['active', 80]], true), true)).toEqual([['active', 80]]);
  });

  it('survives a missing value list', () => {
    expect(formatListInput(undefined, false)).toBe('');
  });
});

describe('formatting', () => {
  const t = (key: string, params?: Record<string, unknown>) => `${key}:${JSON.stringify(params ?? {})}`;

  it('picks the unit by magnitude', () => {
    expect(formatDuration(320, t)).toContain('dataGen.durationMs');
    expect(formatDuration(4200, t)).toContain('dataGen.durationSec');
    expect(formatDuration(65_000, t)).toContain('dataGen.durationMin');
    expect(formatDuration(65_000, t)).toContain('"s":"05"');
  });

  it('returns nothing for a nonsense duration', () => {
    expect(formatDuration(-1, t)).toBe('');
    expect(formatDuration(Number.NaN, t)).toBe('');
  });

  it('extrapolates the remaining time only once it can', () => {
    expect(estimateRemainingMs(0, 100, 1000)).toBeNull();
    expect(estimateRemainingMs(100, 100, 1000)).toBeNull();
    expect(estimateRemainingMs(50, 100, 1000)).toBe(1000);
    expect(estimateRemainingMs(25, 100, 1000)).toBe(3000);
  });

  it('sums the rows of a spec', () => {
    expect(
      totalRowsOf({
        tables: [
          { table: 'a', rows: 10, columns: [] },
          { table: 'b', rows: 5, columns: [] },
        ],
      }),
    ).toBe(15);
  });
});

describe('vector generator', () => {
  const vec = (options: Record<string, unknown>) =>
    validateSpec(spec({ tables: [{ table: 't', rows: 10, columns: [col({ generator: 'vector', options })] }] }));

  it('is a known, labelled, non-text generator with its option fields', () => {
    expect(isKnownGenerator('vector')).toBe(true);
    expect(resolve(generatorLabelKey('vector'))).toBeTypeOf('string');
    expect(isTextGenerator('vector')).toBe(false);
    expect(optionFields('vector').map((f) => f.key)).toEqual(['dimensions', 'normalize', 'sparse', 'nonZero']);
    for (const f of optionFields('vector')) expect(resolve(f.labelKey)).toBeTypeOf('string');
  });

  it('accepts sane dimensions and refuses the ones Rust would silently clamp', () => {
    expect(vec({ dimensions: 1536 })).toEqual([]);
    expect(vec({ dimensions: 30, sparse: true, nonZero: 10 })).toEqual([]);
    for (const bad of [{ dimensions: 0 }, { dimensions: 1.5 }, { dimensions: 20000 }, { dimensions: 5, sparse: true, nonZero: 6 }]) {
      expect(vec(bad).map((i) => i.key)).toEqual(['dataGen.errVectorDims']);
    }
    // nonZero only matters for a sparse vector.
    expect(vec({ dimensions: 5, nonZero: 99 })).toEqual([]);
  });
});
