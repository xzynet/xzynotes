import { describe, expect, it } from 'vitest';
import { tabMatchesCourse } from '../../core/utils/url';

describe('core/utils/url tabMatchesCourse', () => {
  it('B站：同 BV 同分 P 匹配，忽略 t/追踪参数', () => {
    const course = {
      id: 'bilibili:BV1xx411c7mD:p2',
      url: 'https://www.bilibili.com/video/BV1xx411c7mD/?p=2',
    };
    expect(
      tabMatchesCourse(
        'https://www.bilibili.com/video/BV1xx411c7mD/?p=2&vd_source=abc&t=35',
        course,
      ),
    ).toBe(true);
  });

  it('B站：分 P 不一致不匹配（缺省 p 视为 1）', () => {
    const p2 = { id: 'bilibili:BV1:p2', url: 'https://www.bilibili.com/video/BV1/?p=2' };
    const p1 = { id: 'bilibili:BV1:p1', url: 'https://www.bilibili.com/video/BV1/' };
    expect(tabMatchesCourse('https://www.bilibili.com/video/BV1/', p2)).toBe(false);
    expect(tabMatchesCourse('https://www.bilibili.com/video/BV1/?p=3', p2)).toBe(false);
    expect(tabMatchesCourse('https://www.bilibili.com/video/BV1/?p=1', p1)).toBe(true);
    expect(tabMatchesCourse('https://www.bilibili.com/video/BV2/?p=1', p1)).toBe(false);
  });

  it('MOOC：课程 id 含课节 contentId 时按 hash 里的 id 精确匹配', () => {
    const course = {
      id: 'icourse163:CS100-1:4001',
      url: 'https://www.icourse163.org/learn/CS100-1?tid=14689001',
    };
    expect(
      tabMatchesCourse(
        'https://www.icourse163.org/learn/CS100-1?tid=14689001#/learn/content?type=detail&id=4001',
        course,
      ),
    ).toBe(true);
    expect(
      tabMatchesCourse(
        'https://www.icourse163.org/learn/CS100-1?tid=14689001#/learn/content?type=detail&id=4002',
        course,
      ),
    ).toBe(false);
  });

  it('MOOC：标签页 hash 未生成（加载中）时从宽放行', () => {
    const course = {
      id: 'icourse163:CS100-1:4001',
      url: 'https://www.icourse163.org/learn/CS100-1?tid=14689001',
    };
    expect(tabMatchesCourse('https://www.icourse163.org/learn/CS100-1?tid=14689001', course)).toBe(
      true,
    );
  });

  it('MOOC：课程 id 不含 contentId（hash 缺失时入库）只校验路径', () => {
    const course = {
      id: 'icourse163:CS100-1',
      url: 'https://www.icourse163.org/learn/CS100-1?tid=14689001',
    };
    expect(
      tabMatchesCourse(
        'https://www.icourse163.org/learn/CS100-1?tid=14689001#/learn/content?type=detail&id=9999',
        course,
      ),
    ).toBe(true);
    expect(tabMatchesCourse('https://www.icourse163.org/learn/OTHER-2', course)).toBe(false);
  });

  it('学堂在线 / 通用：按 origin + pathname 匹配', () => {
    const course = {
      id: 'xuetangx:/courses/course-v1:TsinghuaX+1+2026/courseware/1/',
      url: 'https://www.xuetangx.com/courses/course-v1:TsinghuaX+1+2026/courseware/1/',
    };
    expect(
      tabMatchesCourse('https://www.xuetangx.com/courses/course-v1:TsinghuaX+1+2026/courseware/1/', course),
    ).toBe(true);
    expect(
      tabMatchesCourse('https://www.xuetangx.com/courses/course-v1:TsinghuaX+1+2026/courseware/2/', course),
    ).toBe(false);
    expect(tabMatchesCourse('https://example.com/courses/course-v1:TsinghuaX+1+2026/courseware/1/', course)).toBe(false);
  });

  it('YouTube：/watch 路径全站相同，按 v 参数区分视频', () => {
    const course = { id: 'youtube:dQw4w9WgXcQ', url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' };
    expect(
      tabMatchesCourse('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=30', course),
    ).toBe(true);
    expect(tabMatchesCourse('https://www.youtube.com/watch?v=otherVideo1', course)).toBe(false);
    expect(tabMatchesCourse('https://www.youtube.com/shorts/dQw4w9WgXcQ', course)).toBe(false);
  });

  it('通用：SPA 哈希路由按 search+hash 精确匹配', () => {
    const course = {
      id: 'generic:https://wm.wonmega.com:4433/vue/#/zyzx/gonggong/nodevideo?nid=3346',
      url: 'https://wm.wonmega.com:4433/vue/#/zyzx/gonggong/nodevideo?nid=3346',
    };
    expect(
      tabMatchesCourse('https://wm.wonmega.com:4433/vue/#/zyzx/gonggong/nodevideo?nid=3346', course),
    ).toBe(true);
    // 同站不同视频（hash 查询串不同）不匹配
    expect(
      tabMatchesCourse('https://wm.wonmega.com:4433/vue/#/zyzx/gonggong/nodevideo?nid=3347', course),
    ).toBe(false);
    // 同站其它路由（首页）不匹配
    expect(tabMatchesCourse('https://wm.wonmega.com:4433/vue/#/xzy3/home1', course)).toBe(false);
  });

  it('通用：无 hash 的普通页面按 search 匹配，忽略 t 回跳参数', () => {
    const course = {
      id: 'generic:https://example.com/watch?v=1',
      url: 'https://example.com/watch?v=1',
    };
    expect(tabMatchesCourse('https://example.com/watch?v=1&t=30', course)).toBe(true);
    expect(tabMatchesCourse('https://example.com/watch?v=2', course)).toBe(false);
    expect(tabMatchesCourse('https://example.com/other?v=1', course)).toBe(false);
  });

  it('非法 URL 返回 false', () => {
    const course = { id: 'bilibili:BV1:p1', url: 'https://www.bilibili.com/video/BV1/' };
    expect(tabMatchesCourse('not a url', course)).toBe(false);
    expect(tabMatchesCourse('', course)).toBe(false);
  });
});
