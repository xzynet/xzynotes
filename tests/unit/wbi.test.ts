import { describe, expect, it } from 'vitest';
import { extractWbiKey, mixinKey, signWbiParams } from '../../adapters/platforms/wbi';

// 权威测试向量：bilibili-API-collect docs/misc/sign/wbi.md
const IMG_KEY = '7cd084941338484aae1ad9425b84077c';
const SUB_KEY = '4932caff0ff746eab6f01bf08b70ac45';

describe('wbi 签名', () => {
  it('mixinKey 重排（文档向量）', () => {
    expect(mixinKey(IMG_KEY, SUB_KEY)).toBe('ea1db124af3c7062474693fa704f4ff8');
  });

  it('extractWbiKey 从 url 截取口令', () => {
    expect(
      extractWbiKey('https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png'),
    ).toBe('7cd084941338484aae1ad9425b84077c');
    expect(extractWbiKey('')).toBeUndefined();
  });

  it('完整签名（文档向量：排序 + wts + w_rid）', () => {
    const query = signWbiParams(
      { foo: '114', bar: '514', zab: 1919810 },
      { imgKey: IMG_KEY, subKey: SUB_KEY },
      1702204169,
    );
    expect(query).toBe(
      'bar=514&foo=114&wts=1702204169&zab=1919810&w_rid=8f6f2b5b3d485fe1886cec6a0be8c5d4',
    );
  });

  it('参数值过滤 !\'()* 字符', () => {
    const query = signWbiParams(
      { foo: "a!b'c(d)e*f" },
      { imgKey: IMG_KEY, subKey: SUB_KEY },
      1702204169,
    );
    expect(query).toContain('foo=abcdef');
  });

  it('中文值百分号编码且字母大写', () => {
    const query = signWbiParams({ bar: '五一四' }, { imgKey: IMG_KEY, subKey: SUB_KEY }, 1702204169);
    expect(query).toContain('bar=%E4%BA%94%E4%B8%80%E5%9B%9B');
  });

  it('空格编码为 %20 而非 +', () => {
    const query = signWbiParams(
      { foo: 'one one four' },
      { imgKey: IMG_KEY, subKey: SUB_KEY },
      1702204169,
    );
    expect(query).toContain('foo=one%20one%20four');
  });
});
