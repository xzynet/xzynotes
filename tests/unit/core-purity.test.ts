import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const CORE_DIR = join(import.meta.dirname, '..', '..', 'core');

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listTsFiles(p));
    else if (entry.name.endsWith('.ts')) out.push(p);
  }
  return out;
}

/** 架构铁律：core/ 禁止出现的浏览器/扩展 API */
const BANNED: Array<[RegExp, string]> = [
  [/\bchrome\s*\./, 'chrome.*'],
  [/\bbrowser\s*\./, 'browser.*'],
  [/\bwindow\s*\./, 'window.*'],
  [/\bdocument\s*\./, 'document.*'],
  [/\blocalStorage\b/, 'localStorage'],
  [/\bsessionStorage\b/, 'sessionStorage'],
  [/\bnavigator\s*\./, 'navigator.*'],
  [/\bfetch\s*\(/, 'fetch()'],
  [/\bXMLHttpRequest\b/, 'XMLHttpRequest'],
];

/** 粗暴去除注释，避免注释里的词汇误伤 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

const files = listTsFiles(CORE_DIR);

describe('架构铁律：core/ 零浏览器 API', () => {
  it('core/ 下存在源码文件', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const file of files) {
    it(`${relative(CORE_DIR, file)} 不含禁用 API`, () => {
      const src = stripComments(readFileSync(file, 'utf-8'));
      for (const [pattern, label] of BANNED) {
        expect(pattern.test(src), `命中禁用 API：${label}`).toBe(false);
      }
    });
  }
});
