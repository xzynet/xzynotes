# -*- coding: utf-8 -*-
from docx import Document
from docx.shared import Inches, Pt, RGBColor
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.enum.table import WD_TABLE_ALIGNMENT
from docx.oxml.ns import qn
from docx.oxml import OxmlElement
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SHOTS = ROOT / "screenshot"
OUT = ROOT / "docs" / "宣传文档-学知云课记.docx"


def set_font(run, size=None, bold=None, color=None, name="Microsoft YaHei"):
    if size is not None:
        run.font.size = Pt(size)
    if bold is not None:
        run.bold = bold
    if color is not None:
        run.font.color.rgb = RGBColor(*color)
    run.font.name = name
    r = run._element.rPr
    rFonts = r.rFonts
    rFonts.set(qn("w:eastAsia"), name)


def add_para(doc, text="", size=11, bold=False, color=None, align=None, space_after=6):
    p = doc.add_paragraph()
    if align:
        p.alignment = align
    p.paragraph_format.space_after = Pt(space_after)
    run = p.add_run(text)
    set_font(run, size=size, bold=bold, color=color)
    return p


def add_heading(doc, text, level=1):
    p = doc.add_paragraph()
    p.paragraph_format.space_before = Pt(12 if level == 1 else 8)
    p.paragraph_format.space_after = Pt(6)
    run = p.add_run(text)
    set_font(run, size=16 if level == 1 else 13, bold=True,
             color=(0x1F, 0x4E, 0x79) if level == 1 else (0x2E, 0x74, 0xB5))
    return p


def add_bullet(doc, text, bold_prefix=None):
    p = doc.add_paragraph(style="List Bullet")
    if bold_prefix:
        r1 = p.add_run(bold_prefix)
        set_font(r1, bold=True)
        r2 = p.add_run(text)
        set_font(r2)
    else:
        r = p.add_run(text)
        set_font(r)
    return p


def add_shot(doc, rel_path, caption, width=6.2):
    img = SHOTS / rel_path
    p = doc.add_paragraph()
    p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    run = p.add_run()
    run.add_picture(str(img), width=Inches(width))
    cap = doc.add_paragraph()
    cap.alignment = WD_ALIGN_PARAGRAPH.CENTER
    cap.paragraph_format.space_after = Pt(10)
    r = cap.add_run(caption)
    set_font(r, size=9, color=(0x80, 0x80, 0x80))


doc = Document()
sec = doc.sections[0]
sec.top_margin = Inches(0.8)
sec.bottom_margin = Inches(0.8)
sec.left_margin = Inches(0.8)
sec.right_margin = Inches(0.8)

# 封面标题
add_para(doc, "学知云课记 · XZY Notes", size=28, bold=True,
         color=(0x1F, 0x4E, 0x79), align=WD_ALIGN_PARAGRAPH.CENTER, space_after=2)
add_para(doc, "跨浏览器网课学习笔记扩展", size=15,
         color=(0x59, 0x59, 0x59), align=WD_ALIGN_PARAGRAPH.CENTER, space_after=2)
add_para(doc, "一键截图 · 时间戳回跳 · 字幕全文检索 · 离线语音转写 · Markdown 导出", size=11,
         color=(0x80, 0x80, 0x80), align=WD_ALIGN_PARAGRAPH.CENTER, space_after=12)

# 亮点
add_heading(doc, "一句话介绍")
add_para(doc, "看网课做笔记，通常得再开一个软件：暂停视频、切窗口、截图、记下刚讲到哪。"
              "学知云课记把这件事收进视频旁的浏览器侧栏——就地截图、就地写字、点一下回跳，"
              "学完整门课一键导出 Markdown 进你自己的知识库。", space_after=12)

add_heading(doc, "核心功能")
add_bullet(doc, "Alt+S 抓取当前视频帧（1280px JPEG）并自动记录时间戳，视频不中断；"
                "Alt+A 截图后进入圈画标注器（矩形 / 箭头 / 画笔 / 文字 / 马赛克）。", "一键截图笔记：")
add_bullet(doc, "点笔记时间戳直接跳回那一刻；重点段落支持 A-B 区间循环复读。", "时间戳回跳 / A-B 循环：")
add_bullet(doc, "整门课字幕铺成可检索文本，中文分词优化，播放跟随高亮，点击即跳转。", "字幕时间轴：")
add_bullet(doc, "课程无字幕时，用浏览器本地运行的 sherpa-onnx WASM 模型把讲课声音转成带时间戳的文字；"
                "能解析到视频源文件即整段快进转写（远快于实时），拿不到直链时捕获标签页音频跟随播放实时转写。"
                "模型首次下载后离线可用，任务在后台运行，关掉侧栏也不中断。", "本地语音转写：")
add_bullet(doc, "课程没有章节列表时，可规则生成，也可接入你自己的大模型（OpenAI 兼容接口，Token 只存本机），"
                "按话题切分章节并写出内容摘要。", "章节大纲与 AI 总结：")
add_bullet(doc, "章节大纲目录 + 按时间排列的笔记 + 截图（base64 内嵌或文件引用）+ 可点击的回跳链接，"
                "Obsidian / Notion 直接可用。", "Markdown 导出：")
add_bullet(doc, "所有数据保存在本地 IndexedDB，设置页可查看占用、全量打包 zip 备份或恢复。", "全量本地备份：")
add_para(doc, "", space_after=4)

add_heading(doc, "界面一览")
add_shot(doc, "中文/首页.jpg", "图 1 · 课程首页：侧栏显示全部课程的笔记与 AI 总结概览")
add_shot(doc, "中文/章节总结.jpg", "图 2 · 章节大纲与 AI 课程导览：按话题切分并生成摘要")
add_shot(doc, "中文/获取字幕截图.jpg", "图 3 · 字幕时间轴：全文检索、跟随播放高亮、点击回跳")
add_shot(doc, "中文/流式转写提示.jpg", "图 4 · 无字幕课程：一键启动本地语音转写（流式 / 整段快进）")
add_shot(doc, "中文/截图记录.jpg", "图 5 · 截图笔记：Alt+S 抓帧带时间戳，Alt+A 圈画标注")

add_heading(doc, "支持平台")
table = doc.add_table(rows=1, cols=2)
table.style = "Light Grid Accent 1"
table.alignment = WD_TABLE_ALIGNMENT.CENTER
hdr = table.rows[0].cells
for i, t in enumerate(["平台", "状态"]):
    p = hdr[i].paragraphs[0]
    p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    r = p.add_run(t)
    set_font(r, bold=True, size=10)
platforms = [
    ("B站（bilibili.com）", "完整支持：CC 字幕经 WBI 签名接口、弹幕密度、?t= 回跳"),
    ("中国大学MOOC（icourse163.org）", "支持：AI 字幕响应拦截 + SRT 全量"),
    ("学堂在线（xuetangx.com）", "支持"),
    ("智慧树（zhihuishu.com）", "支持：无注入模式，规避反作弊检测"),
    ("任意 HTML5 <video> 页面", "通用模式：点击工具栏图标激活，转写 / 截图 / 笔记 / 回跳可用"),
]
for name, status in platforms:
    row = table.add_row().cells
    for i, t in enumerate([name, status]):
        r = row[i].paragraphs[0].add_run(t)
        set_font(r, size=10)
doc.add_paragraph()

add_heading(doc, "安装方式")

add_heading(doc, "方式一：从 Chrome 应用商店安装（推荐）", level=2)
add_para(doc, "1. 打开 Chrome 浏览器，访问 Chrome 网上应用店（Chrome Web Store）。", space_after=2)
add_para(doc, "2. 在搜索框输入「学知云课记」或「XZY Notes」。", space_after=2)
add_para(doc, "3. 找到本扩展，点击「添加至 Chrome」。", space_after=2)
add_para(doc, "4. 在弹出的确认框中点击「添加扩展程序」，即完成安装。", space_after=10)

add_heading(doc, "方式二：从 Edge 加载项商店安装", level=2)
add_para(doc, "1. 打开 Microsoft Edge 浏览器，访问 Edge Add-ons 商店。", space_after=2)
add_para(doc, "2. 搜索「学知云课记」或「XZY Notes」。", space_after=2)
add_para(doc, "3. 点击「获取」→「添加扩展」，即完成安装。", space_after=10)

add_heading(doc, "方式三：手动安装（zip 压缩包侧载）", level=2)
add_para(doc, "适用于未上架前的内测分发，或希望在本地构建的用户。", space_after=4)
add_para(doc, "步骤 1：获取 zip 包", size=11, bold=True, space_after=2)
add_para(doc, "· 下载已发布的 zip 包（如 kedaibiao-1.0.0-chrome.zip），或", space_after=2)
add_para(doc, "· 在源码目录执行 pnpm zip 自行打包（需先安装 pnpm 并 pnpm install）。", space_after=4)
add_para(doc, "步骤 2：解压 zip 包", size=11, bold=True, space_after=2)
add_para(doc, "将 zip 解压到一个固定目录（例如 D:\\extensions\\kedaibiao），不要放在临时目录或桌面。", space_after=4)
add_para(doc, "步骤 3：加载扩展", size=11, bold=True, space_after=2)
add_para(doc, "· Chrome：地址栏输入 chrome://extensions，开启右上角「开发者模式」，"
              "点击「加载已解压的扩展程序」，选择解压后的文件夹。", space_after=2)
add_para(doc, "· Edge：地址栏输入 edge://extensions，同样开启「开发人员模式」后「加载解压缩的扩展」。", space_after=2)
add_para(doc, "· 360 极速 / QQ / 搜狗等 Chromium 内核浏览器：打开扩展管理页，"
              "开启开发者模式后，直接把文件夹拖入页面即可。", space_after=10)

add_heading(doc, "快速上手")
add_para(doc, "1. 在支持的平台打开视频页，点击工具栏图标或页面右下角「学知云课记」悬浮按钮打开侧栏。", space_after=2)
add_para(doc, "2. Alt+S 截图、在字幕区查看与检索全文；没有字幕就点「开始转写」。", space_after=2)
add_para(doc, "3. 学完整门课后，一键导出 Markdown 进 Obsidian / Notion。", space_after=2)
add_para(doc, "快捷键可在 chrome://extensions/shortcuts 自定义。", space_after=10)

add_heading(doc, "为什么值得安装")
reasons = [
    "不用再切窗口：笔记和视频在同一界面，截图即笔记，笔记自带时间戳。",
    "没有字幕的课程也能用：本地模型把无字幕网课变成可检索、可回跳的文字。",
    "转写不用陪着看：解析到视频源文件即整段快进转写，关掉侧栏也会继续跑。",
    "数据不出设备：没有账号、没有登录、没有云同步、没有任何服务端与遥测。",
    "一次安装，长期零成本：转写模型在本地免费运行，不消耗 API 额度、无需订阅。",
    "不被锁定：导出为标准 Markdown + 图片文件，随时带走。",
    "中英双语界面，跟随系统语言自动切换，也可手动指定。",
]
for i, r in enumerate(reasons, 1):
    p = doc.add_paragraph()
    p.paragraph_format.space_after = Pt(2)
    run = p.add_run(f"{i}. ")
    set_font(run, bold=True)
    run2 = p.add_run(r)
    set_font(run2)

add_para(doc, "", space_after=4)
add_heading(doc, "隐私承诺")
add_para(doc, "没有账号、没有登录、没有云同步、没有任何服务端与数据上报——"
              "课程、笔记、截图只在这台电脑上。仅当你自己配置了 AI 端点并主动点击生成时，"
              "字幕文本才会发往你指定的地址。", space_after=6)
add_para(doc, "开源协议：MIT © xzy", size=9, color=(0x80, 0x80, 0x80))

OUT.parent.mkdir(parents=True, exist_ok=True)
doc.save(OUT)
print(f"saved: {OUT}")
