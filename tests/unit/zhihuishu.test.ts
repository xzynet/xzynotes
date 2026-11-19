import { describe, expect, it } from 'vitest';
import {
  ZhihuishuAdapter,
  cleanCourseTitle,
  courseIdFromLocation,
  isGenericTitle,
} from '../../adapters/platforms/zhihuishu';

describe('ZhihuishuAdapter.match', () => {
  // match 不读 location/document，Node 环境可直接测
  const adapter = new ZhihuishuAdapter();

  it('匹配主域与子域', () => {
    expect(adapter.match('https://zhihuishu.com/')).toBe(true);
    expect(adapter.match('https://coursehome.zhihuishu.com/courseHome/1000007048/471743/26')).toBe(
      true,
    );
    expect(adapter.match('https://studyvideoh5.zhihuishu.com/studyVideo/play?courseId=1')).toBe(
      true,
    );
  });

  it('不匹配仿冒后缀与其他站点', () => {
    expect(adapter.match('https://zhihuishu.com.evil.com/')).toBe(false);
    expect(adapter.match('https://www.icourse163.org/')).toBe(false);
    expect(adapter.match('not a url')).toBe(false);
  });
});

describe('zhihuishu 标题清洗', () => {
  it('去掉尾部平台名', () => {
    expect(cleanCourseTitle('课程学习_智慧树')).toBe('课程学习');
    expect(cleanCourseTitle('大学生安全教育-智慧树')).toBe('大学生安全教育');
    expect(cleanCourseTitle('大学生职业生涯规划与就业指导_知到')).toBe('大学生职业生涯规划与就业指导');
  });

  it('无平台名后缀时原样保留', () => {
    expect(cleanCourseTitle('大学生安全教育')).toBe('大学生安全教育');
  });

  it('平台名/栏目名判定为无信息标题', () => {
    expect(isGenericTitle('智慧树')).toBe(true);
    expect(isGenericTitle('知到')).toBe(true);
    expect(isGenericTitle('课程学习')).toBe(true);
    expect(isGenericTitle(' 智慧树 ')).toBe(true);
    expect(isGenericTitle('大学生安全教育')).toBe(false);
  });
});

describe('zhihuishu courseIdFromLocation', () => {
  it('课程主页：路径即课程身份，无查询串', () => {
    expect(courseIdFromLocation('/courseHome/1000007048/471743/26', '')).toBe(
      'zhihuishu:/courseHome/1000007048/471743/26',
    );
  });

  it('学习页：保留课节身份参数，剔除令牌/时间戳类易变参数', () => {
    expect(
      courseIdFromLocation(
        '/studyVideo/play',
        '?courseId=100&token=abc123&t=1720000000&lessonId=55',
      ),
    ).toBe('zhihuishu:/studyVideo/play?courseId=100&lessonId=55');
  });

  it('参数排序稳定，同课生成同一 id', () => {
    const a = courseIdFromLocation('/p', '?b=2&a=1');
    const b = courseIdFromLocation('/p', '?a=1&b=2');
    expect(a).toBe(b);
    expect(a).toBe('zhihuishu:/p?a=1&b=2');
  });
});
