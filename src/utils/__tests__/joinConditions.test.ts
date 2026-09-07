import { describe, it, expect } from 'vitest';
import { buildJoinConditions, type JoinSchema } from '../../sql/joinConditions';

/** Sakila's real schema for the two tables in the case under test. */
const SAKILA: Record<string, JoinSchema> = {
  city: {
    columns: [{ name: 'city_id' }, { name: 'city' }, { name: 'country_id' }, { name: 'last_update' }],
    foreignKeys: [{ column: 'country_id', refTable: 'country', refColumn: 'country_id' }],
  },
  address: {
    columns: [
      { name: 'address_id' }, { name: 'address' }, { name: 'address2' }, { name: 'district' },
      { name: 'city_id' }, { name: 'postal_code' }, { name: 'phone' }, { name: 'location' },
      { name: 'last_update' },
    ],
    foreignKeys: [{ column: 'city_id', refTable: 'city', refColumn: 'city_id' }],
  },
  country: {
    columns: [{ name: 'country_id' }, { name: 'country' }, { name: 'last_update' }],
    foreignKeys: [],
  },
};

const get = (map: Record<string, JoinSchema>) => async (t: string) => map[t] ?? null;
const aliases = (pairs: [string, string][]) => new Map(pairs);

describe('buildJoinConditions', () => {
  it('dùng FK và alias cho câu SELECT * FROM city c JOIN address a', async () => {
    const out = await buildJoinConditions(
      ['city', 'address'],
      aliases([['city', 'c'], ['address', 'a']]),
      get(SAKILA)
    );
    expect(out).toContain('a.city_id = c.city_id');
  });

  it('không có alias thì dùng tên bảng', async () => {
    const out = await buildJoinConditions(['city', 'address'], new Map(), get(SAKILA));
    expect(out).toContain('address.city_id = city.city_id');
  });

  it('bắt được FK theo cả hai chiều', async () => {
    // Here the last table joined is `city`, while the FK sits on `address`.
    const out = await buildJoinConditions(
      ['address', 'city'],
      aliases([['address', 'a'], ['city', 'c']]),
      get(SAKILA)
    );
    expect(out).toContain('a.city_id = c.city_id');
  });

  it('không có FK thì fallback theo cột trùng tên trông giống khoá', async () => {
    const noFk: Record<string, JoinSchema> = {
      city: { columns: SAKILA.city.columns },
      address: { columns: SAKILA.address.columns },
    };
    const out = await buildJoinConditions(
      ['city', 'address'],
      aliases([['city', 'c'], ['address', 'a']]),
      get(noFk)
    );
    expect(out).toContain('c.city_id = a.city_id');
  });

  it('không ghép cột trùng tên nhưng không giống khoá (last_update)', async () => {
    const noFk: Record<string, JoinSchema> = {
      city: { columns: SAKILA.city.columns },
      address: { columns: SAKILA.address.columns },
    };
    const out = await buildJoinConditions(['city', 'address'], new Map(), get(noFk));
    expect(out.some(c => c.includes('last_update'))).toBe(false);
  });

  it('fkOnly bỏ hẳn fallback trùng tên (dùng để xếp hạng bảng sau JOIN)', async () => {
    const noFk: Record<string, JoinSchema> = {
      city: { columns: SAKILA.city.columns },
      address: { columns: SAKILA.address.columns },
    };
    const opts = { fkOnly: true };
    expect(await buildJoinConditions(['city', 'address'], new Map(), get(noFk), opts)).toEqual([]);
    // A real FK still comes through.
    const out = await buildJoinConditions(['city', 'address'], new Map(), get(SAKILA), opts);
    expect(out).toContain('address.city_id = city.city_id');
  });

  it('chưa đủ hai bảng thì không gợi ý gì', async () => {
    expect(await buildJoinConditions(['city'], new Map(), get(SAKILA))).toEqual([]);
    expect(await buildJoinConditions([], new Map(), get(SAKILA))).toEqual([]);
  });

  it('bỏ bảng trùng (khác hoa/thường) trước khi tính', async () => {
    expect(await buildJoinConditions(['city', 'CITY'], new Map(), get(SAKILA))).toEqual([]);
  });

  it('một cặp có FK không được làm mất fallback của cặp khác', async () => {
    // country<->city has an FK; city<->address has its FK removed here, so the fallback has to be used.
    const mixed: Record<string, JoinSchema> = {
      ...SAKILA,
      address: { columns: SAKILA.address.columns }, // not FK
    };
    const out = await buildJoinConditions(
      ['country', 'city', 'address'],
      aliases([['country', 'co'], ['city', 'c'], ['address', 'a']]),
      get(mixed)
    );
    // The city -> country FK (the last table is address, so this pair does not count), and the city/address fallback:
    expect(out).toContain('c.city_id = a.city_id');
  });

  it('schema thiếu thì không nổ', async () => {
    const out = await buildJoinConditions(['city', 'ghost'], new Map(), get(SAKILA));
    expect(Array.isArray(out)).toBe(true);
  });
});
