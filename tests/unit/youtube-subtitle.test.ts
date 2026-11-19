import { describe, expect, it } from 'vitest';
import {
  extractCaptionTracks,
  extractVideoIdFromPlayerResponse,
  parseTimedtextJson3,
  parseTimedtextXml,
  pickCaptionTrack,
  YoutubeAdapter,
  type CaptionTrack,
} from '../../adapters/platforms/youtube';

/** JSON3 实测形态：含无 segs 的时间对齐事件、segs 内的换行符 */
const JSON3_SAMPLE = JSON.stringify({
  wireMagic: 'pb3',
  events: [
    {
      tStartMs: 0,
      dDurationMs: 2560,
      segs: [{ utf8: 'hello everyone' }, { utf8: '\n' }, { utf8: 'welcome back' }],
    },
    { tStartMs: 2560, dDurationMs: 2000, segs: [{ utf8: "today we're going to talk about" }] },
    { tStartMs: 4560, dDurationMs: 1440, id: 123 },
    { tStartMs: 6000, dDurationMs: 2500, segs: [{ utf8: 'subtitles' }] },
  ],
});

const XML_SAMPLE = `<?xml version="1.0" encoding="utf-8" ?><timedtext format="3">
<body>
<text start="0.5" dur="2.5">Hello &amp; welcome</text>
<text start="3" dur="1.5">to <i>this</i> video</text>
<text start="4.5" dur="2">it&#39;s number &#35;1</text>
</body>
</timedtext>`;

describe('YouTube timedtext JSON3 解析', () => {
  it('按实测结构解析：segs 拼接、换行合并、毫秒转秒、跳过无 segs 事件', () => {
    expect(parseTimedtextJson3(JSON3_SAMPLE)).toEqual([
      { start: 0, end: 2.56, text: 'hello everyone welcome back' },
      { start: 2.56, end: 4.56, text: "today we're going to talk about" },
      { start: 6, end: 8.5, text: 'subtitles' },
    ]);
  });

  it('dDurationMs 缺失时用下一事件起点兜底（末事件 +5s）', () => {
    const sample = JSON.stringify({
      events: [
        { tStartMs: 1000, segs: [{ utf8: 'a' }] },
        { tStartMs: 3000, segs: [{ utf8: 'b' }] },
      ],
    });
    expect(parseTimedtextJson3(sample)).toEqual([
      { start: 1, end: 3, text: 'a' },
      { start: 3, end: 8, text: 'b' },
    ]);
  });

  it('空/非法输入 → 空数组', () => {
    expect(parseTimedtextJson3('not json')).toEqual([]);
    expect(parseTimedtextJson3('{"events":[]}')).toEqual([]);
    expect(parseTimedtextJson3('{}')).toEqual([]);
    expect(parseTimedtextJson3('[1,2]')).toEqual([]);
    expect(
      parseTimedtextJson3(JSON.stringify({ events: [{ tStartMs: 0, dDurationMs: 100, segs: [{ utf8: '  ' }] }] })),
    ).toEqual([]);
  });
});

describe('YouTube timedtext XML 解析', () => {
  it('实体解码、内嵌标签剥离、秒制时间', () => {
    expect(parseTimedtextXml(XML_SAMPLE)).toEqual([
      { start: 0.5, end: 3, text: 'Hello & welcome' },
      { start: 3, end: 4.5, text: 'to this video' },
      { start: 4.5, end: 6.5, text: "it's number #1" },
    ]);
  });

  it('dur 缺失时按下一行起点兜底', () => {
    const xml = '<timedtext><body><text start="1">a</text><text start="4">b</text></body></timedtext>';
    expect(parseTimedtextXml(xml)).toEqual([
      { start: 1, end: 4, text: 'a' },
      { start: 4, end: 9, text: 'b' },
    ]);
  });

  it('空/非字幕 XML → 空数组', () => {
    expect(parseTimedtextXml('')).toEqual([]);
    expect(parseTimedtextXml('<html><body>hello</body></html>')).toEqual([]);
    expect(parseTimedtextXml('<timedtext><body></body></timedtext>')).toEqual([]);
  });
});

/** 含嵌套 name.runs 数组的 captionTracks 片段（正则 [^\]]* 会在此处截断，必须括号配平） */
const PLAYER_RESPONSE_SNIPPET = `
var ytInitialPlayerResponse = {"videoDetails":{"videoId":"dQw4w9WgXcQ","title":"Demo"},
"captions":{"playerCaptionsTracklistRenderer":{"captionTracks":[
{"baseUrl":"https://www.youtube.com/api/timedtext?v=dQw4w9WgXcQ&lang=en","name":{"runs":[{"text":"English"}]},"vssId":".en","languageCode":"en","isTranslatable":true},
{"baseUrl":"https://www.youtube.com/api/timedtext?v=dQw4w9WgXcQ&lang=zh-Hans&kind=asr","name":{"simpleText":"中文（自动生成）"},"vssId":"a.zh-Hans","languageCode":"zh-Hans","kind":"asr","isTranslatable":true}
],"audioTracks":[]}},"playabilityStatus":{"status":"OK"}};
`;

describe('ytInitialPlayerResponse 提取', () => {
  it('extractCaptionTracks：括号配平穿透 name.runs 嵌套数组', () => {
    const tracks = extractCaptionTracks(PLAYER_RESPONSE_SNIPPET);
    expect(tracks).toHaveLength(2);
    expect(tracks[0]).toMatchObject({
      languageCode: 'en',
      name: 'English',
    });
    expect(tracks[0]!.baseUrl).toContain('/api/timedtext');
    expect(tracks[0]!.kind).toBeUndefined();
    expect(tracks[1]).toMatchObject({ languageCode: 'zh-Hans', kind: 'asr', name: '中文（自动生成）' });
  });

  it('extractCaptionTracks：无字幕轨 / 非法 JSON → 空数组', () => {
    expect(extractCaptionTracks('<html>no captions here</html>')).toEqual([]);
    expect(extractCaptionTracks('{"captionTracks": [broken')).toEqual([]);
    expect(extractCaptionTracks('"captionTracks": []')).toEqual([]);
  });

  it('extractVideoIdFromPlayerResponse', () => {
    expect(extractVideoIdFromPlayerResponse(PLAYER_RESPONSE_SNIPPET)).toBe('dQw4w9WgXcQ');
    expect(extractVideoIdFromPlayerResponse('<html></html>')).toBeNull();
  });
});

describe('pickCaptionTrack 轨道选择', () => {
  const manualEn: CaptionTrack = { baseUrl: 'u1', languageCode: 'en', name: 'English' };
  const manualZh: CaptionTrack = { baseUrl: 'u2', languageCode: 'zh-Hans', name: '中文' };
  const asrEn: CaptionTrack = { baseUrl: 'u3', languageCode: 'en', kind: 'asr' };

  it('界面语言族前缀匹配人工轨', () => {
    expect(pickCaptionTrack([manualEn, manualZh], 'zh-CN')).toBe(manualZh);
  });

  it('精确匹配优先于族前缀', () => {
    const zhTw: CaptionTrack = { baseUrl: 'u4', languageCode: 'zh-TW' };
    expect(pickCaptionTrack([manualZh, zhTw], 'zh-TW')).toBe(zhTw);
  });

  it('人工轨优先于自动生成轨', () => {
    expect(pickCaptionTrack([asrEn, manualEn], 'en-US')).toBe(manualEn);
  });

  it('只有自动生成轨时也能用', () => {
    expect(pickCaptionTrack([asrEn], 'zh-CN')).toBe(asrEn);
  });

  it('语言不匹配时退第一条人工轨；空列表 → null', () => {
    expect(pickCaptionTrack([manualEn, manualZh], 'fr-FR')).toBe(manualEn);
    expect(pickCaptionTrack([], 'en')).toBeNull();
  });
});

describe('YoutubeAdapter.match', () => {
  const adapter = new YoutubeAdapter();

  it('接管 watch 页', () => {
    expect(adapter.match('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBe(true);
    expect(adapter.match('https://youtube.com/watch?v=abc')).toBe(true);
    expect(adapter.match('https://m.youtube.com/watch?v=abc')).toBe(true);
  });

  it('不接管 shorts/首页/其它站点', () => {
    expect(adapter.match('https://www.youtube.com/shorts/abc')).toBe(false);
    expect(adapter.match('https://www.youtube.com/')).toBe(false);
    expect(adapter.match('https://www.youtube.com/@channel')).toBe(false);
    expect(adapter.match('https://notyoutube.com/watch?v=abc')).toBe(false);
    expect(adapter.match('https://youtube.com.evil.com/watch?v=abc')).toBe(false);
    expect(adapter.match('not a url')).toBe(false);
  });
});
