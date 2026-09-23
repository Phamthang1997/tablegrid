import { describe, it, expect } from 'vitest';
import {
  buildTransposedTsv,
  cellText,
  computeColumnStats,
  textMetrics,
  transposeRows,
  tryFormatJson,
} from '../gridTools';

describe('cellText', () => {
  it('keeps NULL apart and stringifies objects as JSON', () => {
    expect(cellText(null)).toBeNull();
    expect(cellText(undefined)).toBeNull();
    expect(cellText(0)).toBe('0');
    expect(cellText({ a: 1 })).toBe('{"a":1}');
  });
});

describe('computeColumnStats', () => {
  it('sums numbers and numeric strings (DECIMAL arrives as a string)', () => {
    const s = computeColumnStats([1, '2.5', null, 3]);
    expect(s.count).toBe(4);
    expect(s.nulls).toBe(1);
    expect(s.numeric).toEqual({ sum: 6.5, avg: 6.5 / 3, min: 1, max: 3, approximate: false });
  });

  it('ignores empty strings for the numeric verdict but counts them', () => {
    const s = computeColumnStats(['1', '', '2']);
    expect(s.empty).toBe(1);
    expect(s.numeric?.sum).toBe(3);
  });

  it('gives no numeric stats as soon as one value is text', () => {
    const s = computeColumnStats(['1', 'abc']);
    expect(s.numeric).toBeNull();
    expect(s.minText).toBe('1');
    expect(s.maxText).toBe('abc');
  });

  it('does not treat hex, Infinity or blanks as numbers', () => {
    expect(computeColumnStats(['0x1F']).numeric).toBeNull();
    expect(computeColumnStats(['Infinity']).numeric).toBeNull();
    expect(computeColumnStats([' ']).numeric).toBeNull();
  });

  it('marks results approximate past double precision', () => {
    expect(computeColumnStats(['9007199254740993']).numeric?.approximate).toBe(true);
    expect(computeColumnStats(['12345.678901234567']).numeric?.approximate).toBe(true);
    expect(computeColumnStats(['0.001']).numeric?.approximate).toBe(false);
  });

  it('counts distinct values as text and tracks lengths', () => {
    const s = computeColumnStats(['a', 'bb', 'a', null]);
    expect(s.distinct).toBe(2);
    expect(s.minLength).toBe(1);
    expect(s.maxLength).toBe(2);
  });

  it('handles an all-NULL column', () => {
    const s = computeColumnStats([null, null]);
    expect(s.numeric).toBeNull();
    expect(s.minText).toBeNull();
    expect(s.distinct).toBe(0);
  });
});

describe('transposeRows', () => {
  it('flags the fields where rows differ', () => {
    const f = transposeRows(['id', 'name'], [{ id: 1, name: 'x' }, { id: 2, name: 'x' }]);
    expect(f).toEqual([
      { column: 'id', values: [1, 2], differs: true },
      { column: 'name', values: ['x', 'x'], differs: false },
    ]);
  });

  it('never flags a single row', () => {
    expect(transposeRows(['a'], [{ a: 1 }])[0].differs).toBe(false);
  });

  it('builds a TSV with the given header and flattened tabs/newlines', () => {
    const f = transposeRows(['a'], [{ a: 'x\ty' }, { a: null }]);
    expect(buildTransposedTsv(['column', 'row 1', 'row 2'], f)).toBe('column\trow 1\trow 2\na\tx y\t');
  });
});

describe('tryFormatJson', () => {
  it('pretty-prints objects and arrays', () => {
    expect(tryFormatJson('{"a":1}')).toBe('{\n  "a": 1\n}');
    expect(tryFormatJson('[1,2]', 0)).toBe('[1,2]');
  });

  it('refuses scalars and broken JSON', () => {
    expect(tryFormatJson('123')).toBeNull();
    expect(tryFormatJson('"x"')).toBeNull();
    expect(tryFormatJson('{a:1}')).toBeNull();
  });
});

describe('textMetrics', () => {
  it('counts UTF-8 bytes, not UTF-16 units', () => {
    expect(textMetrics('é')).toEqual({ chars: 1, lines: 1, bytes: 2 });
    expect(textMetrics('')).toEqual({ chars: 0, lines: 0, bytes: 0 });
    expect(textMetrics('a\nb')).toEqual({ chars: 3, lines: 2, bytes: 3 });
  });
});
