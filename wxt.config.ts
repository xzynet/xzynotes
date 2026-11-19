import { defineConfig } from 'wxt';
import tailwindcss from '@tailwindcss/vite';

// See https://wxt.dev/api/config.html
export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  // Chrome/Firefox 统一 MV3（Firefox 侧为 event page 模型，架构铁律已对齐）
  manifestVersion: 3,
  vite: () => ({
    plugins: [tailwindcss()],
  }),
  // AMO 审查源码包只认构建输入。WXT 默认把仓库根整个打进去，但 coverage 报告（构建产物）
  // 和 kimi-* 会话导出（本地记录）都不是源码，白占 4 MB 还会淹没审查员的视线
  zip: {
    excludeSources: ['coverage/**', 'kimi-export-session_*.md'],
  },
  manifest: ({ browser }) => ({
    // 名称/描述/命令描述走 _locales（default_locale: en，系统中文时浏览器自动取 zh_CN）
    default_locale: 'en',
    name: '__MSG_extensionName__',
    description: '__MSG_extensionDescription__',
    // Firefox MV3 强制要求写死 add-on ID，缺失会被 AMO 直接拒收（"The add-on ID is required
    // in Manifest Version 3 and above"）；且提交后不可更改，换 ID 等于新建插件、丢用户与评价。
    // Chrome 侧无此字段，故只在 firefox 构建注入。
    //
    // strict_min_version 取 140：AI 章节切分会把课程字幕正文发往用户配置的 LLM 端点，
    // 属 websiteContent 外传，必须声明 data_collection_permissions（2025-11-03 起 AMO 对
    // 新插件强制要求）。而内置的数据同意弹窗 Firefox 140 才有，低于 140 得自建同意界面。
    // 声明为 optional 而非 required：核心功能（笔记/截图/OCR/本地转写/导出）全程不出设备，
    // AI 是用户配置端点后才可用的增量能力，实际由 components/dataConsent.ts 在点击时申请授权。
    // gecko_android 按官方文档配套取 142（Android 侧内置同意晚于桌面版），不写会被 web-ext
    // lint 报 KEY_FIREFOX_ANDROID_UNSUPPORTED_BY_MIN_VERSION
    ...(browser === 'firefox'
      ? {
          browser_specific_settings: {
            gecko: {
              id: 'xxj@xzynet.com',
              strict_min_version: '140.0',
              data_collection_permissions: {
                required: ['none'],
                optional: ['websiteContent'],
              },
            },
            gecko_android: {
              strict_min_version: '142.0',
            },
          },
        }
      : {}),
    // 空 action 声明不改变图标默认行为，但 Chrome 没有它时 chrome.action 在所有上下文
    // （含 SW）都是 undefined，无法做激活弹窗切换；Firefox 没有它则工具栏不生成按钮、
    // 扩展面板里点击也不派发任何事件（点击开侧栏见 background.ts 末尾）
    action: {},
    // Firefox MV3 不支持 sidePanel 权限（V1.1 走 sidebarAction 适配）；
    // tabCapture 为 Chrome 独占（本地语音转写捕获标签页音频），Firefox 无对应 API；
    // offscreen 同理独占（语音转写在独立文档里跑，关侧栏不中断，见 core/asr/host.ts）；
    // scripting：按需向已激活（activeTab）的标签页注入内容脚本，支撑任意 HTML5 视频页
    permissions:
      browser === 'firefox'
        ? ['storage', 'activeTab', 'tabs', 'contextMenus', 'scripting', 'declarativeNetRequestWithHostAccess']
        : [
            'storage',
            'sidePanel',
            'tabCapture',
            'offscreen',
            'activeTab',
            'tabs',
            'contextMenus',
            'scripting',
            'declarativeNetRequestWithHostAccess',
          ],
    // 语音转写 WASM 运行时（sherpa-onnx）需要 wasm-unsafe-eval 编译 WebAssembly
    content_security_policy: {
      extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'",
    },
    // SenseVoice 离线运行时是 sherpa-onnx 的 pthread 构建，依赖 SharedArrayBuffer，
    // 需要扩展页面跨源隔离；credentialless 保证跨域课程封面图仍可加载（Chrome 110+，Firefox 不支持则省略）
    ...(browser === 'firefox'
      ? {}
      : {
          cross_origin_embedder_policy: { value: 'credentialless' },
          cross_origin_opener_policy: { value: 'same-origin' },
        }),
    // 智慧树字幕接口（newbase.zhihuishu.com）跨域无 CORS 头且校验 Referer：
    // 后台 SW 代抓需要 host 权限 + declarativeNetRequest 补 Referer（网络层修改，页面无感知）
    host_permissions: ['*://*.zhihuishu.com/*'],
    // AI 大模型调用走后台 fetch：用户配置 baseUrl 后在设置页按需授权对应域名
    optional_host_permissions: ['<all_urls>'],
    commands: {
      capture: {
        suggested_key: { default: 'Alt+S' },
        description: '__MSG_commandCapture__',
      },
      captureAnnotate: {
        suggested_key: { default: 'Alt+A' },
        description: '__MSG_commandCaptureAnnotate__',
      },
      newNote: {
        suggested_key: { default: 'Alt+N' },
        description: '__MSG_commandNewNote__',
      },
      togglePanel: {
        // Chrome 限制建议快捷键最多 4 条，超限会导致扩展加载失败；
        // 开面板可走工具栏图标/悬浮按钮，不设默认键（用户可手动绑定）
        description: '__MSG_commandTogglePanel__',
      },
      activateAsr: {
        // 命令执行本身就是 tabCapture 认可的激活手势（activeTab 规范示例）；
        // 建议键已满额，不设默认键，用户可手动绑定
        description: '__MSG_commandActivateAsr__',
      },
      bookmark: {
        suggested_key: { default: 'Alt+B' },
        description: '__MSG_commandBookmark__',
      },
    },
  }),
});
