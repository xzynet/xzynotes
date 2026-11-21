import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const SYNC_SCRIPT = fileURLToPath(new URL('../../scripts/sync-public.mjs', import.meta.url));
const TEMP_PARENT = join(import.meta.dirname, '..', '..', '.cache', 'sync-public-tests');

let fixtureRoot: string;
let sourceRoot: string;
let targetRoot: string;

function writeSource(relativePath: string, content: string | Buffer) {
  const filePath = join(sourceRoot, relativePath);
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, content);
}

function writeTarget(relativePath: string, content: string | Buffer) {
  const filePath = join(targetRoot, relativePath);
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, content);
}

function runSync(...args: string[]) {
  return execFileSync(process.execPath, [join(sourceRoot, 'scripts/sync-public.mjs'), ...args], {
    encoding: 'utf8',
  });
}

beforeEach(() => {
  mkdirSync(TEMP_PARENT, { recursive: true });
  fixtureRoot = mkdtempSync(join(TEMP_PARENT, 'case-'));
  sourceRoot = join(fixtureRoot, 'private');
  targetRoot = join(fixtureRoot, 'wmkedaibiao-public');
  mkdirSync(join(sourceRoot, 'scripts'), { recursive: true });
  mkdirSync(targetRoot, { recursive: true });
  copyFileSync(SYNC_SCRIPT, join(sourceRoot, 'scripts/sync-public.mjs'));
  writeSource('.publicignore', '.publicignore\nscripts/\n');
});

afterEach(() => {
  rmSync(fixtureRoot, { recursive: true, force: true });
});

describe('公开仓库同步', () => {
  it('跳过内容相同及仅换行符不同的文本文件', () => {
    writeSource('same.txt', 'same\n');
    writeTarget('same.txt', 'same\n');
    writeSource('crlf.txt', 'first\nsecond\n');
    writeTarget('crlf.txt', 'first\r\nsecond\r\n');
    writeSource('cr.txt', 'first\nsecond\n');
    writeTarget('cr.txt', 'first\rsecond\r');
    writeSource('changed.txt', 'new\n');
    writeTarget('changed.txt', 'old\n');

    const oldTime = new Date('2000-01-01T00:00:00.000Z');
    const sameTarget = join(targetRoot, 'same.txt');
    utimesSync(sameTarget, oldTime, oldTime);
    const oldMtime = statSync(sameTarget).mtimeMs;

    const output = runSync();

    expect(statSync(sameTarget).mtimeMs).toBe(oldMtime);
    expect(readFileSync(join(targetRoot, 'crlf.txt'), 'utf8')).toBe('first\r\nsecond\r\n');
    expect(readFileSync(join(targetRoot, 'cr.txt'), 'utf8')).toBe('first\rsecond\r');
    expect(readFileSync(join(targetRoot, 'changed.txt'), 'utf8')).toBe('new\n');
    expect(output).toContain('复制 1 个');
    expect(output).toContain('跳过相同文件 3 个');
  });

  it('不对二进制或无效 UTF-8 数据做换行符归一化比较', () => {
    const binarySource = Buffer.from([0x00, 0x0d, 0x0a]);
    const invalidUtf8Source = Buffer.from([0xff, 0x0d, 0x0a]);
    writeSource('binary.dat', binarySource);
    writeTarget('binary.dat', Buffer.from([0x00, 0x0a]));
    writeSource('invalid.dat', invalidUtf8Source);
    writeTarget('invalid.dat', Buffer.from([0xff, 0x0a]));

    const output = runSync();

    expect(readFileSync(join(targetRoot, 'binary.dat')).equals(binarySource)).toBe(true);
    expect(readFileSync(join(targetRoot, 'invalid.dat')).equals(invalidUtf8Source)).toBe(true);
    expect(output).toContain('复制 2 个');
    expect(output).toContain('跳过相同文件 0 个');
  });

  it('预览模式报告待复制文件但不修改目标', () => {
    writeSource('new.txt', 'new\n');

    const output = runSync('--dry-run');

    expect(existsSync(join(targetRoot, 'new.txt'))).toBe(false);
    expect(output).toContain('待复制 1 个');
    expect(output).toContain('跳过相同文件 0 个');
  });
});
