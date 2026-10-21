import { describe, expect, it } from 'vitest';
import { PagingError, pageAll } from '../../src/core/hostRpc';

const msgs = (from: number, n: number) => Array.from({ length: n }, (_, i) => ({ uuid: `m${from + i}` }));

describe('pageAll (store.messages paging)', () => {
  it('pages by offset until a short page', async () => {
    const calls: number[] = [];
    const all = await pageAll(async (offset, limit) => {
      calls.push(offset);
      return msgs(offset, offset < 4 ? limit : 1);
    }, 2, 100);
    expect(calls).toEqual([0, 2, 4]);
    expect(all.map((m) => (m as { uuid: string }).uuid)).toEqual(['m0', 'm1', 'm2', 'm3', 'm4']);
  });

  it('an exactly-full last page ends on the following empty page', async () => {
    const all = await pageAll(async (offset) => (offset < 4 ? msgs(offset, 2) : []), 2, 100);
    expect(all).toHaveLength(4);
  });

  it('a helper that ignores offset (same page again) is rejected, not looped', async () => {
    let n = 0;
    await expect(
      pageAll(async () => {
        n++;
        return msgs(0, 2);
      }, 2, 100),
    ).rejects.toMatchObject({ code: 'bad-paging' });
    expect(n).toBe(2);
  });

  it('stops at the page cap with a typed error', async () => {
    const p = pageAll(async (offset, limit) => msgs(offset, limit), 2, 3);
    await expect(p).rejects.toBeInstanceOf(PagingError);
    await expect(p).rejects.toMatchObject({ code: 'too-many-pages' });
  });

  it('rejects a non-array or oversized page', async () => {
    await expect(pageAll(async () => null as unknown as unknown[], 2, 10)).rejects.toMatchObject({ code: 'bad-page' });
    await expect(pageAll(async () => msgs(0, 3), 2, 10)).rejects.toMatchObject({ code: 'bad-page' });
  });
});
