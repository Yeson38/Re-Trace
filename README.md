# Re-Trace
通用代码执行可视化调试器，通过插桩录制与时间线回放，让每一行代码的运行过程「帧」级可见。

## 阶段总览（Phases 0–3）

| 阶段 | 内容 | 状态 |
| --- | --- | --- |
| **Phase 0** | 前端播放器基建：HTML + TS、Vite dev server、代码/变量/循环/终端四联视图、左右步进与自动播放 | ✅ |
| **Phase 1** | Python 插桩适配器：AST 重写源码，生成 `trace.json` 时间线 | ✅ |
| **Phase 2** | C++ 插桩适配器：正则插桩 + `retrace.h` 运行时 | ✅ |
| **Phase 3** | 高级调试特性：时间线搜索、循环复杂度估算、双时间点变量 Diff | ✅ |
| **Phase 4** | 编辑器内编辑（TODO） | ⏳ |

## 本地运行（播放器）

```bash
cd player
npm install            # 或 pnpm install
npm run typecheck      # 静态类型检查
npm run test:analysis  # Phase 3 分析层单元测试（纯函数，71 项）
npm run build          # 生产构建
npm run dev            # 本地开发服务器（默认 5173）
```

播放器启动后加载的是 `public/samples/bubble_sort.json`，可在 `src/main.ts` 的 `loadTrace()` 中切换样本或接入你自己的适配器产物。

## 时间线协议（TraceFile）

适配器只需要输出符合以下协议的 JSON，播放器就能逐帧回放：

```ts
interface TraceFile {
  source: { name: string; language: string; lines: string[] }; // 源码
  steps: TraceStep[];                                           // 执行帧
}
interface TraceStep {
  line: number;          // 正在执行的行号（1-based）
  depth: number;         // 调用栈深度
  vars:  TraceVar[];     // 该帧作用域内的变量
  loops: TraceLoop[];    // 激活的循环计数器
  output: string;        // 该帧追加到终端的 stdout
  globalStep: number;    // 单调递增的全局步号
}
```

详情见 [player/src/types.ts](player/src/types.ts)。

---

## Phase 3 功能详解

### 1 · 时间线二分搜索（Timeline Search）

顶栏右侧的搜索框接受形如 `<变量路径> <操作符> <值>` 的查询，按下 **Enter** 直接跳至当前光标之后首个命中的帧；**F3** 跳到下一命中；**Shift+Enter** 回退到上一命中。

查询语法示例：
| 查询 | 含义 |
| --- | --- |
| `n == 4` | 整型变量 `n` 等于 `4` 的帧 |
| `data[3] == 8` | 数组索引位置等于 `8` |
| `score >= 60.5` | 数值比较（`>` `>=` `<` `<=` `==` `!=`） |
| `name ~= "Alice"` | 字符串包含（`~=`） |
| `arr ~= 5` | 数组包含值 `5` |

匹配结果会以「搜索芯片」形式显示在输入框右侧，格式为 `当前序号/总匹配数 at #帧号 · matches: 前3个命中帧号列表`；输入过程中对语法错误即时提示为红色错误芯片，正确时显示灰色提示条（「Enter = search, F3 = next, Shift+Enter = previous」）。无匹配或查询失败会在页面顶部弹出短暂的 toast 提示。

实现入口：`player/src/ui/searchBar.ts` + `player/src/analysis.ts` 中的 `parseSearch` / `findAllMatches`。

### 2 · 循环复杂度自动估算（Complexity Estimate）

- **程序级徽章**：顶栏品牌右侧的胶囊型徽章（例如 `O(n²)`），按估算结果着色：
  - `O(1)` 绿色、`O(n)` 蓝色、含 `²` 黄色、含 `n³`/`2ⁿ`/`!` 红色
  - 单击徽章切换气泡，显示「估算依据」（由分析层汇总：循环嵌套层数、循环变量变化方式、总规模与迭代次数的线性/平方拟合度等）
- **循环级徽章**：Inspector 侧栏 Loops 区每一行右侧的小标签，显示该循环的估算阶数。低置信度的估算以斜体 + 稍透明的形式呈现；同样支持点击切换依据气泡。

估算规则（`estimateLoopComplexity` / `estimateProgram`）基于以下启发式：
1. 激活层数（嵌套）作为起始阶 `O(n^k)`；
2. 循环控制变量的增长量若为倍增/减半，降阶到 `O(log n)`；
3. 总迭代次数与输入规模的残差比较决定最终阶；
4. 多层循环取最高阶并合并，程序级为所有循环的最大阶。

### 3 · 双时间点变量 Diff（A/B Anchor Diff）

底部传输栏新增三颗按钮：

| 按钮 | 作用 |
| --- | --- |
| **◉ Mark A** | 在当前播放位置设置「基准时间点 A」 |
| **◉ Mark B** | 在当前播放位置设置「对比时间点 B」 |
| **✕ Clear** | 清除 A / B 锚点，Variables 回到实时视图 |

顶栏中部会同步显示两颗锚点芯片（如 `A: #7`、`B: #19`），点击任一颗直接跳至对应帧，便于在两个点之间来回切换。

当 **A、B 都已设置** 时，右侧 Variables 自动切换为 Diff 模式：
- 顶部横幅显示 `Variable Diff — #A → #B` 与四色图例
- 变量行按差异着色：
  - 🟢 **新增**（added）：只在 B 中存在的变量/字段，绿色高亮
  - 🔴 **删除**（removed）：只在 A 中存在的变量/字段，红色 + 删除线
  - 🟡 **修改**（modified）：A→B 值或长度变化，显示 `old → new`
  - ⚪ **未变**（unchanged）：正常渲染，不额外上色
- 对象/数组支持递归展开，展开状态在普通视图与 Diff 之间共享（所以你展开过的节点切到 Diff 依然保持打开）。

实现入口：`player/src/ui/varTree.ts` 的 `renderDiff()` 与 `player/src/analysis.ts` 的 `diffVars()`。

### Phase 3 架构约束

为了保持可测试，Phase 3 严格遵守「纯函数分析层 + 视图组件」分层：
- `player/src/analysis.ts` 全是纯函数（无 DOM、无 Player、无定时器），可以在 Node 下用 `npm run test:analysis` 直接运行（71/71 通过）。
- `player/src/ui/*.ts` 的 UI 组件是「哑视图」：接收状态、回调与 `TraceFile`，在内部构建 DOM；不自己管理时间线状态。
- `player/src/main.ts` 作为唯一的装配胶水：把 Player、SearchBar、Controls、VarTree、Terminal 的回调和状态订阅绑在一起。

---

## 键盘速查

| 键位 | 作用 | 作用域 |
| --- | --- | --- |
| `←` / `→` | 单步后退 / 前进 | 全局（非输入框内） |
| `Space` | 播放 / 暂停 | 全局 |
| `Home` / `End` | 跳至首帧 / 末帧 | 全局 |
| `Enter` | 执行搜索，跳到首个 ≥ 当前帧的命中 | 搜索框聚焦 |
| `Shift+Enter` | 跳至上一个命中 | 搜索框聚焦 |
| `F3` | 下一个命中（循环） | 搜索框聚焦 |
| `Esc` | 清空查询并失焦 | 搜索框聚焦 |

## 后续（Phase 4 · 计划）

只读视图 → 可编辑代码框 → 保存改动后重新跑适配器生成新 trace，形成「改 → 录 → 回放」闭环。
