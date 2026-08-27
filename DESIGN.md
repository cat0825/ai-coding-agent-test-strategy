# DESIGN.md — Agent Verification Observatory

> 交付物视觉契约：报告 HTML、诊断可视化、回放页面。
> 数字口径与证据纪律在 `AGENTS.md` 与 `STATUS.md`，本文件只管视觉。
> **数字权威永远是 `STATUS.md`，本文件不复述任何评测数字。**

## 北极星

**白底工程蓝图。** 克制即可信。这是一份研究报告的视觉，不是产品落地页 ——
状态机、验证分层、决策点归因，天生就该长成蓝图的样子：
白纸、细线、灰阶骨架，单一强调色只在真正需要引导视线时出现。

参考系：[Visitors](https://styles.refero.design/style/e7876363-181a-44a9-9e5c-2255cf98aea5)
（refero 原文 "white engineering blueprint"）。token 取自该页实测。

## 为什么是 Visitors（一个非显然的理由）

Visitors 有条规则：**「一个组件里不许混多个强调色」** ——
Sky 专管 realtime，Amber 专管 performance，Magenta 专管 profiles，各司其职不串台。

这条规则和本仓库的硬纪律是同一件事：

> 评测报告必须区分 `evidence_insufficient` / `rejected` / 可支持声明三态，**不许合并**。
> —— `AGENTS.md`

一个语义一个色、永不混用，正是「三态不许合并」在视觉层的实现。
所以 Visitors 不是"挑了个好看的皮"，它的配色纪律本身就是本项目的证据纪律。

## 适用范围

- 覆盖：`report/*.html`、`docs/*.html`（进度页、observatory run 页）、
  `output/replay/*.html`、`output/pdf/*.html`。
- 不覆盖：CLI 终端输出、JSONL 账本、fixture。
- **无构建系统。** 这些是手写单文件 HTML，不走 Tailwind / PostCSS。
  token 以可复制的 `:root` CSS 变量块形式落地，见下。

## 与现状的差别（说清楚，这是一次方向改变）

现有交付物不统一，且整体偏暗、偏等宽：

| 文件 | 现状 |
|---|---|
| `report/ai-coding-agent-test-strategy.html` | `"Courier New"` + `"Droid Sans Fallback"`，无 CSS 变量，print/PDF 导向 |
| `docs/observatory-run-2026-08-24.html` | `system-ui` + mono，暗色系（含 `#0d0d0d`、`#1a1a19`、`#2c2c2a`） |
| `docs/progress-2026-08-25.html` | 纯 mono（`ui-monospace`） |

改成白底蓝图是**有意的方向切换**，理由两条：

1. **PDF 是真实交付路径**（`output/pdf/` 已存在）。暗底报告打印要么烧墨要么被浏览器反色，
   白底是唯一稳的。
2. 研究报告的可信度来自排版克制，不来自暗色科技感。三态判定要在纸上也读得出来。

全等宽的做法要收：mono 留给数据与标识符，正文换回无衬线。**理由见「排版」一节。**

## 语义色映射（本文件最重要的一节）

三态**各占一个色，永不混用，且必须带非颜色通道**：

| 状态 | 文字色 | 底色 | 强制文字标记 |
|---|---|---|---|
| 可支持声明 | Mint `#33c758` | Mint Wash `#def6e4` | `SUPPORTED` |
| `evidence_insufficient` | Amber `#ffa600`（文字降深至 `#8a5a00`） | `#fff6e0` | `EVIDENCE INSUFFICIENT` |
| `rejected` | Ember `#ff3e00`（文字降深至 `#b32b00`） | `#ffe9e3` | `REJECTED` |

三条硬规则：

1. **颜色不得是唯一通道。** 每个状态必须同时出现文字标记（或形状/图标）。
   理由有两个都成立的：报告要打印成灰度 PDF；色觉障碍读者拿不到色相。
   Visitors 自己也有对应规则 —— 「绿字不要直接放白底，配 Mint Wash 底色」。
2. **一个组件里只出现一个状态色。** 汇总表格里三态同列出现是允许的（那是三行），
   同一个 badge / 卡片里混两个色不允许。
3. **不许用中间色调和三态。** 没有"接近达标"的黄绿色。三态是离散的，视觉也必须离散。

### 四条硬门槛的呈现

门槛数字（`STATUS.md` 权威，本文件不复述）必须满足：

- 未达标门槛用 `rejected` 或 `evidence_insufficient` 的完整处理，**不许只标灰**。
  灰色读起来像"待填"，而这些是明确的未通过。
- 分数形如 `X/Y` 一律 mono + `tabular-nums`，分母同字宽对齐。
- **不许用进度条。** 进度条暗示"在推进中"，而门槛是判定不是进度。用数字 + 状态 badge。
- 每个数字旁边标口径时刻（如 `截至 2026-08-26`）。改口径 = 旧数字作废，
  不许留着看起来还成立。

## 色彩

复制进 `:root` 用：

```css
:root {
  /* 中性骨架 */
  --carbon:   #181925;  /* 主文字、标题（冷调近黑，不用纯黑） */
  --graphite: #666666;  /* 次要文字、图注 */
  --ash:      #999999;  /* 弱文字、占位、非活跃 */
  --fog:      #e8e8e8;  /* 1px 细线、表格边、分隔 */
  --mist:     #f5f5f5;  /* 次级画布、ghost 填充 */
  --linen:    #fafafa;  /* 表格斑马行、浅色带 */
  --paper:    #ffffff;  /* 主画布、卡片 */

  /* 三态语义（唯一允许表判定的色） */
  --supported:      #33c758;
  --supported-wash: #def6e4;
  --insufficient:      #8a5a00;
  --insufficient-wash: #fff6e0;
  --rejected:      #b32b00;
  --rejected-wash: #ffe9e3;

  /* 主操作（交互页面专用，静态报告基本不用） */
  --lavender: #918df6;

  /* 分类强调：一色一语义，不得串台 */
  --sky:     #2c78fc;  /* 时序 / trace / 时间轴 */
  --magenta: #d6409f;  /* 任务集 / cohort 归属 */
}
```

**标题不用纯 `#000000`** —— Carbon 的冷调让白底不刺眼，这是 Visitors 明确的 Do。

### Lavender 的实际角色

Visitors 把 Lavender 定为「只给主操作按钮，不给文字、边框、装饰」。
本项目的报告基本是静态的，没有主操作按钮 —— 所以 **Lavender 大部分页面根本不出现**，
这是正确状态，不是缺失。只在真有交互的页面（回放控件、筛选）用它，一屏一个。

**不要因为"页面看起来太素"就把 Lavender 撒到标题或边框上。** 素是蓝图的目标。

## 与 Visitors 的偏离（四条）

| # | Visitors 规定 | 本项目 | 理由 |
|---|---|---|---|
| 1 | Ember `#ff3e00` 只做装饰，**禁止**进 UI chrome | Ember 降深后作 `rejected` 语义色 | 本项目必须有一个明确的"否"。Visitors 的调色板里没给功能红，只能征用 Ember。原值 `#ff3e00` 在白底对比度不足，降到 `#b32b00` 作文字色。 |
| 2 | 三层阴影栈（卡片 `0 1px 3px` + `0 8px 16px` + `0 0 0 1px`） | 屏幕保留，**打印全部去掉** | 阴影不印刷。见「打印」一节。 |
| 3 | OpenRunde 字族 | 系统栈 + CJK 兜底 | OpenRunde 无中文字形，报告是中文。且报告 HTML 要留在 git 里可 diff，不塞 base64 字体。 |
| 4 | 药丸圆角（按钮 / tag 全 9999px） | tag / badge 药丸；表格与卡片保持方形化 | 状态 badge 用药丸（强化"标签"语义）；数据表用 Visitors 的 24px 表格圆角 + 1px Fog 边，不再软化。 |

## 排版

```css
--font-sans: Inter, "OpenRunde", -apple-system, BlinkMacSystemFont, "Segoe UI",
  "PingFang SC", "Droid Sans Fallback", "Microsoft YaHei", sans-serif;
--font-mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
```

**正文回到无衬线，mono 只给三类东西**：

1. 数字与分数（`6/30`、`duration_ms`、百分比）—— 配 `tabular-nums`
2. 标识符（命令、路径、`evidence_insufficient` 这类枚举值、fixture 名、commit）
3. 代码块与 JSONL 片段

理由：现有 `progress-2026-08-25.html` 全等宽，读长段中文很吃力，
而且**全等宽会让真正的数据失去区分度** —— 什么都是 mono 时，mono 就不再是信号。

### 字号阶梯（Minor Third，14px 基准）

| 角色 | 字号 / 行高 / 字距 |
|---|---|
| display | 60 / 1.13 / -3px（weight 600，居中） |
| heading-lg | 48 / 1.0 / -0.34px |
| heading | 36 / 1.22 / -0.61px |
| heading-sm | 24 / 1.17 / -0.31px |
| subheading | 18 / 1.33 / -0.32px |
| body | 16 / 1.5 / -0.32px |
| caption | 12 / 1.33 / -0.32px |

字重：标题与 badge 用 500，正文与图注 400，仅 display 用 600。

## 尺度与形状

基础单位 4px。阶梯：4 / 8 / 12 / 16 / 20 / 24 / 32 / 48 / 64。

布局：最大宽度 1200px，区块间距 64px，卡片内边距 32px，元素间距 16px。

| 元素 | 圆角 |
|---|---|
| 图片 / 输入框 | 8px |
| 卡片 | 16px |
| 数据表 | 24px |
| badge / tag | 9999px |

**表格用 1px `--fog` 细线，不用重阴影** —— 这是 Visitors 的核心 Do，也是蓝图感的来源。

## 深度

屏幕上三层封顶（Visitors 原值）：

```css
--shadow-btn:  rgba(0,0,0,.08) 0 1px 1px 1px, rgba(0,0,0,.06) 0 0 0 .5px;
--shadow-card: rgba(0,0,0,.06) 0 1px 3px 0, rgba(0,0,0,.06) 0 8px 16px 0,
               rgba(0,0,0,.02) 0 0 0 1px;
```

不加第四层，不加 dramatic drop shadow。**特征卡片容器不加底色** —— 靠细线区分。

## 打印（本项目专属，Visitors 没有）

`output/pdf/` 是真实交付路径，每个报告 HTML 都要带打印样式：

```css
@media print {
  :root { --shadow-btn: none; --shadow-card: none; }
  * { box-shadow: none !important; }
  body { background: #fff; }
  /* 状态色底在灰度打印下会糊成同一片灰 —— 靠文字标记区分，这是三态规则 #1 的兜底 */
  table, figure, .card { break-inside: avoid; }
  a[href^="http"]::after { content: " (" attr(href) ")"; font-size: 10px; color: #666; }
}
```

三条打印要求：

- **灰度打印下三态必须仍可区分。** 验证方法：浏览器打印预览选灰度，或导出 PDF 后转灰度看。
  区分靠文字标记，不靠底色深浅。
- 表格、图、卡片不许跨页断裂。
- 外链在纸上要能看到 URL。

## 交付物绑定

| 文件 | 角色 |
|---|---|
| `report/ai-coding-agent-test-strategy.html` | 主研究报告。白底蓝图 + 打印样式。现为 Courier New，待迁移。 |
| `docs/observatory-run-*.html` | 单次运行诊断。现为暗色，待迁移。时序用 `--sky`。 |
| `docs/progress-*.html` | 进度页。三态 badge 是主角。现为全 mono，待迁移。 |
| `output/replay/*.html` | 回放页（`recommendation-audit`、`unattributed-retry`）。唯一可能用 Lavender 的地方。 |
| `output/pdf/*.html` | PDF 源。打印样式必须齐。 |

迁移不必一次做完。**新建页面一律按本文件；老页面改到哪迁哪。**

## Do

- 三态永远各占一色 + 一个文字标记。
- 数字、标识符、代码用 mono + `tabular-nums`；正文用无衬线。
- 表格靠 1px `--fog` 细线立骨架。
- 每个数字标口径时刻。
- badge / tag 用药丸圆角。
- 每个报告 HTML 都带 `@media print`。
- 页面素是对的 —— 克制本身是可信度的一部分。

## Don't

- 不要把三态合并、不要用中间色调和、不要只靠颜色区分。
- 不要用进度条表达门槛达标情况。
- 不要在一个组件里混两个强调色（`--sky` 管时序、`--magenta` 管 cohort，不串台）。
- 不要把 Lavender 撒到标题 / 边框 / 装饰上。
- 不要用纯 `#000000` 做标题。
- 不要给特征卡片加底色。
- 不要在报告里复述 `STATUS.md` 的数字当权威 —— 引用要标来源与时刻。
- **不要写没有签入证据支撑的结论**（`AGENTS.md` 硬纪律，视觉稿同样受约束）。

## 验收

```bash
cd '/Users/qianyuhe/Documents/ChatGPT/llm test'
npm run check    # bash scripts/syntax-gate.sh && node --test test/*.test.mjs
```

视觉侧四条（前两条必做）：

1. **浏览器打开改过的 HTML，肉眼确认三态可区分。**
2. **打印预览切灰度，确认三态仍可区分。** 这一条是本文件的核心门禁，
   过不了就说明退回了「只靠颜色」。
3. 对比度实测：`--graphite #666666` 在 `--paper` 上约 5.7:1（正文可用），
   在 `--mist #f5f5f5` 上会略降 —— 小字号放浅底时重测，不要凭这行数字放过。
   `--ash #999999` **不要用于正文**，只用于占位与非活跃态。
4. 若报告 HTML 引用了 fixture 或评测数字，确认引用的证据已签入
   （仓库测试会校验 fixture 引用，`npm run check` 会抓到）。

> 注：本仓库活跃工作树是 `~/Documents/ChatGPT/llm test`。
> `~/Documents/GitHub/ai-coding-agent-test-strategy` 是僵尸副本（根目录有
> `ZOMBIE-DO-NOT-USE.md`），**不要往那边写 DESIGN.md**。

