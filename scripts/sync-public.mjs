#!/usr/bin/env node
/**
 * 按根目录 .publicignore 将公开文件同步到 ../wmkedaibiao-public。
 * 用法：node scripts/sync-public.mjs [--dry-run]
 */
import { isUtf8 } from 'node:buffer';
import { copyFile, lstat, mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const SOURCE_ROOT = resolve(import.meta.dirname, '..');
const TARGET_ROOT = resolve(SOURCE_ROOT, '..', 'wmkedaibiao-public');
const IGNORE_FILE = join(SOURCE_ROOT, '.publicignore');
const DRY_RUN = process.argv.includes('--dry-run');
const PROTECTED_TARGET_ROOT = new Set([
  '.git',
  'node_modules',
  '.output',
  '.wxt',
  '.cache',
  'web-ext-artifacts',
  'coverage',
  'test-results',
  'playwright-report',
]);

if (process.argv.slice(2).some((arg) => arg !== '--dry-run')) {
  throw new Error('仅支持可选参数 --dry-run');
}

function isComparableText(content) {
  return !content.subarray(0, 8000).includes(0) && isUtf8(content);
}

function normalizeLineEndings(content) {
  return content.toString('utf8').replace(/\r\n?/g, '\n');
}

async function hasSameContent(sourcePath, targetPath) {
  let targetStats;
  try {
    targetStats = await lstat(targetPath);
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
  if (!targetStats.isFile()) return false;

  const [sourceContent, targetContent] = await Promise.all([
    readFile(sourcePath),
    readFile(targetPath),
  ]);
  if (sourceContent.equals(targetContent)) return true;
  if (!isComparableText(sourceContent) || !isComparableText(targetContent)) return false;
  return normalizeLineEndings(sourceContent) === normalizeLineEndings(targetContent);
}

function globToRegExp(pattern) {
  const source = pattern
    .split('*')
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('[^/]*');
  return new RegExp(`^${source}$`, 'i');
}

async function loadRules() {
  const content = await readFile(IGNORE_FILE, 'utf8');
  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => {
      const directory = line.endsWith('/');
      const pattern = line.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
      if (!pattern) throw new Error(`无效的排除规则：${line}`);
      return { directory, pattern, regex: globToRegExp(pattern) };
    });
}

function isExcluded(rules, relativePath, isDirectory) {
  const name = relativePath.split('/').pop();
  return rules.some((rule) => {
    if (rule.directory && !isDirectory) return false;
    return rule.regex.test(rule.pattern.includes('/') ? relativePath : name);
  });
}

async function collectSource(rules, relativePath, files, directories, skipped) {
  const entries = await readdir(join(SOURCE_ROOT, relativePath), { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name));

  for (const entry of entries) {
    const childPath = relativePath ? `${relativePath}/${entry.name}` : entry.name;
    if (isExcluded(rules, childPath, entry.isDirectory())) continue;
    if (entry.isSymbolicLink()) {
      skipped.push(childPath);
    } else if (entry.isDirectory()) {
      directories.add(childPath);
      await collectSource(rules, childPath, files, directories, skipped);
    } else if (entry.isFile()) {
      files.push(childPath);
    } else {
      skipped.push(childPath);
    }
  }
}

async function ensureSafeTarget() {
  let stats;
  try {
    stats = await lstat(TARGET_ROOT);
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error(`公开目录必须是普通目录，不能是符号链接或文件：${TARGET_ROOT}`);
  }
}

async function removeStale(relativePath, files, directories, counters) {
  let entries;
  try {
    entries = await readdir(join(TARGET_ROOT, relativePath), { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }

  for (const entry of entries) {
    if (!relativePath && PROTECTED_TARGET_ROOT.has(entry.name)) continue;
    const childPath = relativePath ? `${relativePath}/${entry.name}` : entry.name;
    const targetPath = join(TARGET_ROOT, childPath);

    if (entry.isSymbolicLink()) {
      if (!DRY_RUN) await rm(targetPath, { force: true });
      counters.removed += 1;
    } else if (entry.isDirectory()) {
      if (directories.has(childPath)) {
        await removeStale(childPath, files, directories, counters);
      } else {
        if (!DRY_RUN) await rm(targetPath, { recursive: true, force: true });
        counters.removed += 1;
      }
    } else if (!files.has(childPath)) {
      if (!DRY_RUN) await rm(targetPath, { force: true });
      counters.removed += 1;
    }
  }
}

async function main() {
  if (SOURCE_ROOT === TARGET_ROOT) {
    throw new Error('请在私有工程中运行同步脚本，不要在公开输出目录中运行。');
  }
  const rules = await loadRules();
  const sourceFiles = [];
  const sourceDirectories = new Set(['']);
  const skipped = [];
  await collectSource(rules, '', sourceFiles, sourceDirectories, skipped);
  await ensureSafeTarget();

  console.log(`私有工程：${SOURCE_ROOT}`);
  console.log(`公开工程：${TARGET_ROOT}`);
  console.log(`排除规则：${rules.length} 条；公开文件：${sourceFiles.length} 个`);
  if (DRY_RUN) console.log('预览模式，不修改任何文件。');

  if (!DRY_RUN) await mkdir(TARGET_ROOT, { recursive: true });
  const fileSet = new Set(sourceFiles);
  const counters = { removed: 0, copied: 0, unchanged: 0 };
  await removeStale('', fileSet, sourceDirectories, counters);

  if (!DRY_RUN) {
    const directoriesByDepth = [...sourceDirectories].sort(
      (a, b) => a.split('/').length - b.split('/').length,
    );
    for (const directory of directoriesByDepth) {
      await mkdir(join(TARGET_ROOT, directory), { recursive: true });
    }
  }
  for (const file of sourceFiles) {
    const sourcePath = join(SOURCE_ROOT, file);
    const targetPath = join(TARGET_ROOT, file);
    if (await hasSameContent(sourcePath, targetPath)) {
      counters.unchanged += 1;
      continue;
    }
    if (!DRY_RUN) await copyFile(sourcePath, targetPath);
    counters.copied += 1;
  }

  if (skipped.length > 0) {
    console.log(`跳过 ${skipped.length} 个符号链接或特殊文件：${skipped.join(', ')}`);
  }
  console.log(
    `${DRY_RUN ? '预览' : '同步'}完成；${DRY_RUN ? '待复制' : '复制'} ${counters.copied} 个，`
      + `跳过相同文件 ${counters.unchanged} 个，清理过期路径 ${counters.removed} 个。`,
  );
}

await main();
