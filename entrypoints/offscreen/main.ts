import { createAsrJobHost } from '../sidepanel/asr/host';

/**
 * 语音转写任务宿主（Chrome offscreen document，无界面）。
 *
 * 存在的唯一理由：文件/流式转写要跑几分钟到几十分钟，任务若留在侧栏文档里，
 * 用户一关面板就被销毁。offscreen 文档不受侧栏/SW 生命周期影响，任务搬到这里，
 * 面板只做「下发命令 + 轮询快照」的视图（协议见 core/asr/host.ts）。
 * Firefox 没有 offscreen API，转写仍在面板内跑（见 AsrCard 的能力判断）。
 */
createAsrJobHost();
