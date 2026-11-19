/**
 * 课程页 URL 身份判断。存库的 course.url 是 canonical 形态（去 t 参数与 hash），
 * 而课程 id 的规则随平台/版本变化（B站含分 P、MOOC 课节 id 在 hash 里且入库时已去掉、
 * 页面降级时退为 generic），所以「标签页是不是这门课」不能只靠 id 相等判断，需要
 * URL 维度兜底：origin + pathname 必须相同，再按平台校验身份参数。
 */

/** 从 MOOC 课节页 hash（#/learn/content?type=detail&id=123）中取课节 id */
function moocContentIdFromHash(hash: string): string | null {
  const q = hash.includes('?') ? hash.slice(hash.indexOf('?') + 1) : '';
  return q ? new URLSearchParams(q).get('id') : null;
}

/**
 * 判断标签页 URL 是否就是某课程的页面。
 * - origin + pathname 必须相同；
 * - B站分 P 参数 p（缺省视为 1）必须一致，避免多 P 课程串视频；
 * - 通用课程身份含 search + hash（SPA 哈希路由的视频身份在 hash 里），
 *   两者必须与课程 canonical URL 一致（t 回跳参数除外）；
 * - MOOC 课程 id 含课节 contentId 时，标签页 hash 中的 id 必须一致
 *   （页面加载中 hash 尚未生成时从宽放行——此时靠实时 id 也匹配不上）。
 */
export function tabMatchesCourse(tabUrl: string, course: { id: string; url: string }): boolean {
  try {
    const t = new URL(tabUrl);
    const c = new URL(course.url);
    if (t.origin !== c.origin || t.pathname !== c.pathname) return false;
    if ((t.searchParams.get('p') ?? '1') !== (c.searchParams.get('p') ?? '1')) return false;
    if (course.id.startsWith('generic:')) {
      const tn = new URL(t.toString());
      tn.searchParams.delete('t');
      const cn = new URL(c.toString());
      cn.searchParams.delete('t');
      return tn.search === cn.search && tn.hash === cn.hash;
    }
    const contentId = course.id.startsWith('icourse163:') ? course.id.split(':')[2] : undefined;
    if (contentId) {
      const tabContentId = moocContentIdFromHash(t.hash);
      if (tabContentId !== null && tabContentId !== contentId) return false;
    }
    // YouTube 视频身份在 v 参数里：/watch 路径全站相同，必须按 v 区分
    const youtubeId = course.id.startsWith('youtube:') ? course.id.split(':')[1] : undefined;
    if (youtubeId && t.searchParams.get('v') !== youtubeId) return false;
    return true;
  } catch {
    return false;
  }
}
