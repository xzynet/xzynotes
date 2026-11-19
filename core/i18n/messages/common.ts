/**
 * 跨模块共享文案：品牌名、通用按钮、平台名。
 * 各业务模块的文案放在同名命名空间文件（如 sidepanel.ts、options.ts），
 * 由 zh-CN.ts / en.ts 汇总；新增语言时同步补该语言的字典汇总文件。
 */
export const zh = {
  'brand.name': '学知云课记',
  'common.save': '保存',
  'common.cancel': '取消',
  'common.delete': '删除',
  'common.confirm': '确认',
  'common.close': '关闭',
  'common.retry': '重试',
  'common.back': '返回',
  'common.loading': '加载中…',
  'common.unknown': '未知',
  'common.untitled': '未命名',
  'common.requestFailed': '请求失败',
  'platform.bilibili': 'B站',
  'platform.icourse163': '中国大学MOOC',
  'platform.xuetangx': '学堂在线',
  'platform.zhihuishu': '智慧树',
  'platform.youtube': 'YouTube',
  'platform.generic': '通用页面',
} as const;

export const en: Record<keyof typeof zh, string> = {
  'brand.name': 'XZY Notes',
  'common.save': 'Save',
  'common.cancel': 'Cancel',
  'common.delete': 'Delete',
  'common.confirm': 'Confirm',
  'common.close': 'Close',
  'common.retry': 'Retry',
  'common.back': 'Back',
  'common.loading': 'Loading…',
  'common.unknown': 'Unknown',
  'common.untitled': 'Untitled',
  'common.requestFailed': 'Request failed',
  'platform.bilibili': 'bilibili',
  'platform.icourse163': 'Chinese University MOOC',
  'platform.xuetangx': 'XuetangX',
  'platform.zhihuishu': 'Zhihuishu',
  'platform.youtube': 'YouTube',
  'platform.generic': 'Generic Page',
};
