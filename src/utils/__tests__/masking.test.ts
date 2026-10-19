import { describe, expect, it, vi } from 'vitest';
import {
  activeRules,
  countActiveRules,
  loadMaskRules,
  maskedKeyColumns,
  newMaskKey,
  saveMaskRules,
  suggestMaskRule,
  suggestMaskRules,
  withMasking,
  type MaskRules,
} from '../masking';

describe('suggestMaskRule', () => {
  const s = (name: string, type = 'varchar(100)', extra = {}) => suggestMaskRule({ name, type, ...extra })?.kind ?? null;

  it('proposes a rule for the usual sensitive columns', () => {
    expect(s('email')).toBe('hashEmail');
    expect(s('customer_email')).toBe('hashEmail');
    expect(s('emailAddress')).toBe('hashEmail');
    expect(s('phone')).toBe('digits');
    expect(s('mobile_phone')).toBe('digits');
    expect(s('card_number')).toBe('card');
    expect(s('password_hash')).toBe('redact');
    expect(s('api_key')).toBe('redact');
    expect(s('first_name')).toBe('fake');
    expect(s('last_name')).toBe('fake');
    expect(s('full_name')).toBe('fake');
    expect(s('address')).toBe('fake');
    expect(s('national_id')).toBe('hash');
    expect(s('cccd')).toBe('hash');
    expect(s('birth_date', 'date')).toBe('dateShift');
    expect(s('ip_address')).toBe('fake');
  });

  it('leaves ordinary columns alone — film titles, amounts, timestamps', () => {
    for (const n of ['title', 'name', 'amount', 'last_update', 'rental_date', 'description', 'status', 'telemetry']) {
      expect(s(n), n).toBeNull();
    }
  });

  it('never proposes a rule for a key column', () => {
    expect(s('email', 'varchar(50)', { isPrimaryKey: true })).toBeNull();
    expect(s('customer_email', 'varchar(50)', { isForeignKey: true })).toBeNull();
  });

  it('does not propose a text rule for a non-text column', () => {
    expect(s('first_name', 'int')).toBeNull();
    expect(s('email_count', 'int')).toBeNull();
  });

  it('collects suggestions per table, skipping tables with none', () => {
    expect(
      suggestMaskRules({
        customer: [{ name: 'customer_id', isPrimaryKey: true }, { name: 'email', type: 'text' }],
        film: [{ name: 'title', type: 'text' }],
      }),
    ).toEqual({ customer: { email: { kind: 'hashEmail' } } });
  });
});

describe('rules', () => {
  const rules: MaskRules = {
    customer: { email: { kind: 'hashEmail' }, store_id: { kind: 'keep' } },
    staff: { password: { kind: 'redact' } },
    film: { title: { kind: 'keep' } },
  };

  it('counts only rules that change something, optionally within the selected tables', () => {
    expect(activeRules(rules)).toEqual({ customer: { email: { kind: 'hashEmail' } }, staff: { password: { kind: 'redact' } } });
    expect(countActiveRules(rules)).toBe(2);
    expect(countActiveRules(rules, ['customer', 'film'])).toBe(1);
  });

  it('names the masked columns that are keys', () => {
    expect(
      maskedKeyColumns({ customer: { customer_id: { kind: 'hash' }, email: { kind: 'hashEmail' } } }, {
        customer: [{ name: 'customer_id', isPrimaryKey: true }, { name: 'email' }],
      }),
    ).toEqual(['customer.customer_id']);
  });

  it('round-trips through storage and survives garbage', () => {
    const store = new Map<string, string>();
    const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
    saveMaskRules('mysql:h:3306/sakila', rules, storage);
    expect(loadMaskRules('mysql:h:3306/sakila', storage)).toEqual(rules);
    expect(loadMaskRules('other', storage)).toEqual({});
    store.set('tf_mask_rules:bad', '{oops');
    expect(loadMaskRules('bad', storage)).toEqual({});
  });

  it('draws a 64-hex-char key from the RNG it is given', () => {
    const key = newMaskKey((a) => a.fill(171));
    expect(key).toBe('ab'.repeat(32));
  });
});

describe('withMasking', () => {
  const reader = {
    getTableData: vi.fn(async (table: string, _page?: number, _size?: number) => ({ rows: [{ table, email: 'a@b.c' }], totalCount: 1 })),
    other: () => 'kept',
  };

  it('masks the pages of masked tables only, and keeps the rest of the reader', async () => {
    const mask = vi.fn(async (_key: string, _cols: unknown, rows: any[]) => rows.map((r) => ({ ...r, email: 'MASKED' })));
    const masked = withMasking(reader, { key: 'k', rules: { customer: { email: { kind: 'hashEmail' } }, film: { t: { kind: 'keep' } } } }, mask);
    expect((await masked.getTableData('customer', 1, 10)).rows[0].email).toBe('MASKED');
    expect((await masked.getTableData('film', 1, 10)).rows[0].email).toBe('a@b.c');
    expect(mask).toHaveBeenCalledTimes(1);
    expect(mask.mock.calls[0][0]).toBe('k');
    expect(masked.other()).toBe('kept');
  });

  it('is the reader itself when there is nothing to mask', () => {
    expect(withMasking(reader, null, vi.fn())).toBe(reader);
    expect(withMasking(reader, { key: 'k', rules: { film: { t: { kind: 'keep' } } } }, vi.fn())).toBe(reader);
  });

  it('lets a masking failure stop the export instead of returning the original rows', async () => {
    const masked = withMasking(reader, { key: 'k', rules: { customer: { email: { kind: 'hash' } } } }, async () => {
      throw new Error('binary');
    });
    await expect(masked.getTableData('customer')).rejects.toThrow('binary');
  });
});
