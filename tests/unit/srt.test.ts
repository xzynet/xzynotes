import { describe, expect, it } from 'vitest';
import {
  decodeSubtitleBuffer,
  parseAnySubtitle,
  parseColumnarSubtitleJson,
  parseRowSubtitleJson,
  parseSubtitleText,
  unwrapJsonp,
} from '../../core/utils/srt';

/** 手工构造 UTF-16LE/BE 字节流（测试字符串均为 BMP 内字符） */
function toUtf16(s: string, endian: 'le' | 'be', bom = true): ArrayBuffer {
  const bytes: number[] = bom ? (endian === 'le' ? [0xff, 0xfe] : [0xfe, 0xff]) : [];
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (endian === 'le') bytes.push(code & 0xff, code >> 8);
    else bytes.push(code >> 8, code & 0xff);
  }
  return new Uint8Array(bytes).buffer as ArrayBuffer;
}

describe('decodeSubtitleBuffer', () => {
  const srt = '1\n00:00:01,000 --> 00:00:04,000\n你好世界\n';
  const expected = [{ start: 1, end: 4, text: '你好世界' }];

  it('UTF-8 正常解码', () => {
    const buf = new TextEncoder().encode(srt).buffer as ArrayBuffer;
    expect(parseSubtitleText(decodeSubtitleBuffer(buf))).toEqual(expected);
  });

  it('UTF-16LE 带 BOM（MOOC 实测编码）', () => {
    expect(parseSubtitleText(decodeSubtitleBuffer(toUtf16(srt, 'le')))).toEqual(expected);
  });

  it('UTF-16LE 无 BOM（内容嗅探兜底）', () => {
    expect(parseSubtitleText(decodeSubtitleBuffer(toUtf16(srt, 'le', false)))).toEqual(expected);
  });

  it('UTF-16BE 带 BOM', () => {
    expect(parseSubtitleText(decodeSubtitleBuffer(toUtf16(srt, 'be')))).toEqual(expected);
  });
});

describe('parseColumnarSubtitleJson（学堂在线 subtitle_parse 实测格式）', () => {
  // 2026-09-03 实测：start/end/text 平行数组，时间毫秒
  const columnar = JSON.stringify({
    start: [0.0, 16120.0, 17440.0],
    end: [16120.0, 17440.0, 21640.0],
    text: ['第一句', '第二句', '第三句'],
  });

  it('毫秒列式 JSON → 秒（用视频时长判定）', () => {
    expect(parseColumnarSubtitleJson(columnar, 477.65)).toEqual([
      { start: 0, end: 16.12, text: '第一句' },
      { start: 16.12, end: 17.44, text: '第二句' },
      { start: 17.44, end: 21.64, text: '第三句' },
    ]);
  });

  it('秒级数据不误判为毫秒', () => {
    const secData = JSON.stringify({ start: [0, 100], end: [100, 200], text: ['a', 'b'] });
    expect(parseColumnarSubtitleJson(secData, 600)).toEqual([
      { start: 0, end: 100, text: 'a' },
      { start: 100, end: 200, text: 'b' },
    ]);
  });

  it('无视频时长时按 >7200 兜底判毫秒', () => {
    const msData = JSON.stringify({ start: [0, 47080], end: [10000, 50000], text: ['a', 'b'] });
    const cues = parseColumnarSubtitleJson(msData);
    expect(cues[1]?.start).toBe(47.08);
  });

  it('字段名备选（startTime/endTime/content）', () => {
    // 300s 视频里 start 到 5000：只能是毫秒
    const alt = JSON.stringify({ startTime: [0, 5000], endTime: [2000, 9000], content: ['内容', '二'] });
    expect(parseColumnarSubtitleJson(alt, 300)).toEqual([
      { start: 0, end: 2, text: '内容' },
      { start: 5, end: 9, text: '二' },
    ]);
  });

  it('非法 JSON / 缺数组 → 空', () => {
    expect(parseColumnarSubtitleJson('不是json')).toEqual([]);
    expect(parseColumnarSubtitleJson('{"foo":1}')).toEqual([]);
    expect(parseColumnarSubtitleJson('{"start":[],"end":[],"text":[]}')).toEqual([]);
  });
});

describe('parseAnySubtitle', () => {
  it('SRT 优先', () => {
    const srt = '1\n00:00:01,000 --> 00:00:04,000\n你好\n';
    expect(parseAnySubtitle(srt)).toEqual([{ start: 1, end: 4, text: '你好' }]);
  });

  it('SRT 失败回落列式 JSON', () => {
    // 300s 视频里 start 到 8000：只能是毫秒
    const columnar = JSON.stringify({ start: [0, 8000], end: [1500, 9000], text: ['你好', '二'] });
    expect(parseAnySubtitle(columnar, 300)).toEqual([
      { start: 0, end: 1.5, text: '你好' },
      { start: 8, end: 9, text: '二' },
    ]);
  });
});

describe('parseSubtitleText · SRT', () => {
  it('解析标准 SRT（逗号毫秒 + 序号行）', () => {
    const srt = [
      '1',
      '00:00:01,000 --> 00:00:04,500',
      '大家好',
      '',
      '2',
      '00:00:05,000 --> 00:00:08,000',
      '今天我们学习导数',
      '',
    ].join('\n');
    expect(parseSubtitleText(srt)).toEqual([
      { start: 1, end: 4.5, text: '大家好' },
      { start: 5, end: 8, text: '今天我们学习导数' },
    ]);
  });

  it('支持多行文本与 CRLF', () => {
    const srt = '1\r\n00:01:00,000 --> 00:01:03,000\r\n第一行\r\n第二行\r\n';
    expect(parseSubtitleText(srt)).toEqual([
      { start: 60, end: 63, text: '第一行 第二行' },
    ]);
  });

  it('支持带 BOM 的内容', () => {
    const srt = '﻿1\n00:00:02,000 --> 00:00:03,000\n你好\n';
    expect(parseSubtitleText(srt)).toEqual([{ start: 2, end: 3, text: '你好' }]);
  });
});

describe('parseSubtitleText · VTT', () => {
  it('跳过 WEBVTT 头，解析点号毫秒', () => {
    const vtt = ['WEBVTT', '', '00:00:01.250 --> 00:00:04.000', '你好世界', ''].join('\n');
    expect(parseSubtitleText(vtt)).toEqual([{ start: 1.25, end: 4, text: '你好世界' }]);
  });

  it('时间行带位置参数也能解析', () => {
    const vtt = 'WEBVTT\n\n00:01:00.000 --> 00:01:02.500 position:10% line:10%\n文本\n';
    expect(parseSubtitleText(vtt)).toEqual([{ start: 60, end: 62.5, text: '文本' }]);
  });

  it('支持省略小时的 MM:SS 格式', () => {
    const vtt = 'WEBVTT\n\n02:30.000 --> 02:31.000\n短格式\n';
    expect(parseSubtitleText(vtt)).toEqual([{ start: 150, end: 151, text: '短格式' }]);
  });
});

describe('parseRowSubtitleJson（行式 JSON：[{start,end,text}]）', () => {
  it('顶层数组：毫秒判定 + 排序', () => {
    // 300s 视频里 start 到 3562：只能是毫秒
    const rows = JSON.stringify([
      { start: 9780, end: 11400, text: '第二句' },
      { start: 3562, end: 9780, text: '第一句' },
    ]);
    expect(parseRowSubtitleJson(rows, 300)).toEqual([
      { start: 3.562, end: 9.78, text: '第一句' },
      { start: 9.78, end: 11.4, text: '第二句' },
    ]);
  });

  it('信封嵌套（result.list）也能找到', () => {
    // beginTime 到 47080：超 7200 兜底判毫秒
    const wrapped = JSON.stringify({
      code: 200,
      result: { list: [{ beginTime: 47080, endTime: 50000, content: '开头' }] },
    });
    expect(parseRowSubtitleJson(wrapped)).toEqual([{ start: 47.08, end: 50, text: '开头' }]);
  });

  it('缺 end 时用下一句 start 兜底，末句 +5s', () => {
    const rows = JSON.stringify([
      { start: 0, text: '一' },
      { start: 2, text: '二' },
    ]);
    expect(parseRowSubtitleJson(rows, 300)).toEqual([
      { start: 0, end: 2, text: '一' },
      { start: 2, end: 7, text: '二' },
    ]);
  });

  it('字段名备选（beginTime/content），空与非 JSON → []', () => {
    expect(parseRowSubtitleJson('不是json')).toEqual([]);
    expect(parseRowSubtitleJson('{"foo":1}')).toEqual([]);
    expect(parseRowSubtitleJson('[]')).toEqual([]);
  });
});

describe('unwrapJsonp（智慧树 subtitleV1 为 JSONP 接口）', () => {
  it('剥离 jQuery 回调外壳，正文可直接 JSON.parse', () => {
    const wrapped =
      'jQuery3510119_1788747({"code":200,"result":{"start":[3562],"end":[9780],"text":["你好"]}});';
    const inner = unwrapJsonp(wrapped);
    expect(inner).not.toBeNull();
    // 300s 视频里 start=3562：只能是毫秒（信封结构 result 下钻一层）
    expect(parseAnySubtitle(inner ?? '', 300)).toEqual([{ start: 3.562, end: 9.78, text: '你好' }]);
  });

  it('容忍首尾空白与省略分号', () => {
    expect(unwrapJsonp('  cb({"a":1})\n')).toBe('{"a":1}');
  });

  it('回调名带点号路径（jQuery.$.ajax 风格）', () => {
    expect(unwrapJsonp('jQuery.cb([])')).toBe('[]');
  });

  it('非 JSONP / 空壳 → null', () => {
    expect(unwrapJsonp('{"code":200}')).toBeNull();
    expect(unwrapJsonp('这不是字幕')).toBeNull();
    expect(unwrapJsonp('cb()')).toBeNull();
  });
});

describe('parseSubtitleText · 容错', () => {
  it('非法块被跳过', () => {
    const text = '垃圾行\n\n1\nnot-a-time --> also-not\n无时间戳\n\n2\n00:00:01,000 --> 00:00:02,000\n有效\n';
    expect(parseSubtitleText(text)).toEqual([{ start: 1, end: 2, text: '有效' }]);
  });

  it('空文本 / 非字幕文本 → 空数组', () => {
    expect(parseSubtitleText('')).toEqual([]);
    expect(parseSubtitleText('这不是字幕文件')).toEqual([]);
  });

  it('结果按 start 升序', () => {
    const srt = [
      '1',
      '00:00:10,000 --> 00:00:11,000',
      '后',
      '',
      '2',
      '00:00:01,000 --> 00:00:02,000',
      '先',
      '',
    ].join('\n');
    expect(parseSubtitleText(srt).map((c) => c.text)).toEqual(['先', '后']);
  });
});
