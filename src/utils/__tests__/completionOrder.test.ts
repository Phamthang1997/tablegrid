import { describe, it, expect } from 'vitest';
import { SQL_EDITOR_OPTIONS } from '../../sql/editorOptions';
import { rankSort } from '../../sql/usageStats';

/**
 * The SQL editor's suggestion order lives entirely in `sortText` (see sqlLanguage.ts).
 * The two tests below pin that order, and pin the one Monaco option that can silently defeat it.
 */

/** Exactly the tiers sqlLanguage.ts emits, from the highest priority down. */
const TIERS: [string, string][] = [
  ['* sau SELECT', '00_star'],
  ['liệt kê cột của bảng', '00_starlist_f'],
  ['điều kiện JOIN theo FK', '0_0'],
  ['cột', rankSort('1', 'film_id')],
  ['bảng nối được theo FK', rankSort('1z', 'address')],
  ['bảng', rankSort('2', 'film')],
  ['tên bảng trong scope', rankSort('3', 'f')],
  ['từ khoá hay dùng', rankSort('4', 'SELECT')],
  ['từ khoá khác', rankSort('5', 'SAVEPOINT')],
  ['mẫu câu theo dialect', 'z_sel'],
];

describe('thứ tự gợi ý SQL', () => {
  it('sortText giữ đúng thứ tự ưu tiên giữa các tier', () => {
    const sorted = [...TIERS].sort((a, b) => (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
    expect(sorted.map(t => t[0])).toEqual(TIERS.map(t => t[0]));
  });

  it('điều kiện JOIN xếp trên mọi cột, bất kể tần suất dùng của cột', () => {
    // '0_...' always sorts below '1_...', so no column can push its way above.
    expect('0_0' < rankSort('1', 'a')).toBe(true);
    expect('0_9' < rankSort('1', 'zzz')).toBe(true);
  });

  it("tier '1z' nằm đúng giữa cột và bảng thường", () => {
    // '15' would NOT work here: '5' sorts BEFORE '_', so a '15_' item would jump above the columns.
    expect(rankSort('1', 'zzz') < rankSort('1z', 'aaa')).toBe(true);
    expect(rankSort('1z', 'zzz') < rankSort('2', 'aaa')).toBe(true);
  });

  it("snippetSuggestions phải là 'inline'", () => {
    // 'bottom'/'top' makes Monaco group every kind=Snippet item at one end of the list and IGNORE
    // their sortText. The JOIN condition and the "list N columns" entry are both Snippets, so
    // 'bottom' buried them dozens of columns down — exactly the bug that was hit.
    expect(SQL_EDITOR_OPTIONS.snippetSuggestions).toBe('inline');
  });

  it('không lấy gợi ý từ nội dung văn bản', () => {
    // Suggestions come only from the DB catalog and the parser; switching this on would mix in words from the statement being typed.
    expect(SQL_EDITOR_OPTIONS.wordBasedSuggestions).toBe('off');
  });
});
