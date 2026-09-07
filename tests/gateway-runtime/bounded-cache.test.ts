import { describe, expect, it } from 'vitest';
import { BoundedCache } from '@/lib/resource-control/bounded-cache';
describe('bounded cache',()=>{
  it('evicts least recently used entries at either capacity boundary',()=>{
    const cache=new BoundedCache<string,string>(2,10,1000);
    cache.set('a','one',4);cache.set('b','two',4);expect(cache.get('a')).toBe('one');cache.set('c','three',5);
    expect(cache.get('b')).toBeUndefined();expect(cache.stats()).toMatchObject({entries:2,estimatedBytes:9,evictions:1});
    expect(cache.set('a','oversized',11)).toBe(false);expect(cache.get('a')).toBeUndefined();expect(cache.stats().estimatedBytes).toBe(5);
  });
  it('expires by insertion time without extending validity on access',()=>{
    let now=0;const cache=new BoundedCache<string,string>(2,10,100,()=>now);
    cache.set('a','one',4);now=90;expect(cache.get('a')).toBe('one');now=100;expect(cache.get('a')).toBeUndefined();expect(cache.stats()).toMatchObject({entries:0,estimatedBytes:0,expired:1});
  });
});
