import md5 from 'md5';

/**
 * B站 WBI 签名（2023-03 起 web 端查询接口的风控签名）。
 * 算法参考 bilibili-API-collect 文档，纯函数实现，可单测。
 * 注意：不在本模块内发请求，密钥获取在 adapter 中完成。
 */

/** 官方重排映射表（64 位） */
export const MIXIN_KEY_ENC_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
  33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40,
  61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11,
  36, 20, 34, 44, 52,
] as const;

/** 值中需过滤的字符（官方约定） */
const CHR_FILTER = /[!'()*]/g;

/** imgKey + subKey 按映射表重排后截前 32 位 */
export function mixinKey(imgKey: string, subKey: string): string {
  const raw = imgKey + subKey;
  return MIXIN_KEY_ENC_TAB.map((n) => raw.charAt(n)).join('').slice(0, 32);
}

/** 从 wbi_img url 中截取口令（文件名去扩展名） */
export function extractWbiKey(url: string): string | undefined {
  return url.split('/').pop()?.split('.')[0] || undefined;
}

export interface WbiKeys {
  imgKey: string;
  subKey: string;
}

/**
 * 为请求参数做 WBI 签名，返回完整 query 串（含排序后的参数 + wts + w_rid）。
 * wts 由调用方注入（秒级时间戳），便于测试。
 */
export function signWbiParams(
  params: Record<string, string | number>,
  keys: WbiKeys,
  wts: number,
): string {
  const mixin = mixinKey(keys.imgKey, keys.subKey);
  const all: Record<string, string | number> = { ...params, wts };
  const query = Object.keys(all)
    .sort()
    .map((k) => {
      const value = String(all[k]).replace(CHR_FILTER, '');
      return `${encodeURIComponent(k)}=${encodeURIComponent(value)}`;
    })
    .join('&');
  return `${query}&w_rid=${md5(query + mixin)}`;
}
