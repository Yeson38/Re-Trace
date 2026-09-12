# Re-Trace

通用代码执行可视化调试器：通过**插桩录制**与**时间线回放**，让每一行代码的运行过程「帧」级可见。支持 Python 与 C++，可在浏览器（GitHub Pages）或桌面（Tauri 安装包）中直接运行。

## 阶段总览（Phases 0–4）

| 阶段 | 内容 | 状态 |
| --- | --- | --- |
| **Phase 0** | 前端播放器基建：HTML + TS、Vite dev server、代码/变量/循环/终端四联视图、左右步进与自动播放 | ✅ |
| **Phase 1** | Python 插桩适配器：AST 重写源码，生成 `trace.json` 时间线 | ✅ |
| **Phase 2** | C++ 插桩适配器：正则插桩 + `retrace.h` 运行时 | ✅ |
| **Phase 3** | 高级调试特性：时间线搜索、循环复杂度估算、双时间点变量 Diff | ✅ |
| **Phase 4** | 多端分发：Monaco 编辑器 + 录制服务 + GitHub Pages + Tauri 桌面 | ✅ |

---

## 快速开始（三种姿势）

### 1 · 直接用在线版（GitHub Pages）

push 到 `main` 分支会自动触发 [`.github/workflows/pages.yml`](.github/workflows/pages.yml) 构建，部署到 `https://<your-handle>.github.io/Re-Trace/`。打开链接即可，无需安装任何东西。

> 首次录制 C++ 时浏览器会下载 ~100 MB 的 clang-17 WASM 包，之后被强缓存永久复用。Python 录制只加载 ~25 MB 的 Pyodide。

### 2 · 跑本地开发服务器

```bash
cd player
npm install
npm run dev          # 默认 http://localhost:5173/
```

浏览器打开后即可使用内置样本；要录制自己的代码，把源码粘进 Monaco 编辑器点 **Record** 即可。

### 3 · 安装桌面版（Tauri）

打 tag `vX.Y.Z` 会触发 [`.github/workflows/tauri-release.yml`](.github/workflows/tauri-release.yml) 构建，自动产出 deb / AppImage / dmg / nsis / msi 并上传到 GitHub Releases：

```bash
git tag -a v0.1.0 -m "Phase 4 release"
git push origin v0.1.0
```

下载对应平台的安装包，装好后双击运行即可，离线可用。

---

## 使用教程（端到端）

Re-Trace 的核心交互模型只有三个动作：**写/粘代码 → 录制 → 回放调试**。下面以 Python 冒泡排序为例完整走一遍。

### Step 1 · 写代码

打开 Web 版或桌面版，左侧 Monaco 编辑器会预加载一个冒泡排序样本（见 [player/src/templates/loaders.ts](player/src/templates/loaders.ts)）。你可以直接改，或全部清空粘自己的代码。

支持的语法子集（详见各适配器 README）：

- **Python**：函数、`for`/`while`、列表/字典、`print`、`input`。完整 AST 重写，覆盖度高 — 见 [adapters/python/README.md](adapters/python/README.md)。
- **C++**：`int`/`char`/`double` 等基础类型、`std::vector`、`for`/`while`、`printf`/`cout`、`main()`。正则插桩，OI 风格代码覆盖良好 — 见 [adapters/cpp/README.md](adapters/cpp/README.md)。

### Step 2 · 录制（Record）

编辑器上方工具栏选语言（Python / C++），点 **Record** 按钮。录制流程：

| 路径 | 插桩 | 执行 | Trace 产出 |
| --- | --- | --- | --- |
| Web · Python | Pyodide 跑 `adapters/python/instrument.py` AST 重写 | Pyodide 执行插桩后代码 | 捕获 stdout 即 trace.json |
| Web · C++ | Pyodide 跑 `adapters/cpp/instrument.py` 正则插桩 | 浏览器内 clang-17 WASM 编译 + Wasmer 执行 | `retrace.h` 的 `__WASM__` 分支写 trace.json 到虚拟 FS |
| 桌面 · Python | 本机 `python3` 跑 instrument.py | 本机 `python3` 执行 | retrace.h atexit flush |
| 桌面 · C++ | 本机 `python3` 跑 instrument.py | 本机 `g++` 编译 + 执行 | retrace.h atexit flush |

> **Hybrid 回退**：桌面端若检测不到 `python3`/`g++`，自动切回 Web 实现（Pyodide + clangWASM），功能永远可用。

录制完成会自动跳到第 0 帧并展开 Variables 面板。

### Step 3 · 回放与调试

四联视图：**代码（高亮当前行）/ Variables / Loops / Terminal**。底部传输栏控制时间线：

- **`←` / `→`** 或 **Space**：单步 / 自动播放
- **`Home` / `End`**：跳到首帧 / 末帧
- **搜索框**：`<var> <op> <value>` 查询，Enter 跳首个命中、F3 下一个、Shift+Enter 上一个
- **◉ Mark A / ◉ Mark B**：标记两个时间点，Variables 自动切到 Diff 视图（🟢新增 / 🔴删除 / 🟡修改 / ⚪未变）
- 顶栏品牌右侧的胶囊徽章（如 `O(n²)`）显示估算的程序复杂度，点击展开依据

完整键盘速查见下文「键盘速查」。

### Step 4 · 导出 / 导入

录制产物是符合 [TraceFile 协议](#时间线协议tracefile) 的 JSON。可以在 UI 里 **Export** 下载，下次直接 **Import** 恢复回放。适配器也可以从命令行独立产出：

```bash
# Python
python3 adapters/python/instrument.py adapters/python/samples/bubble_sort.py -o bubble.json

# C++
python3 adapters/cpp/instrument.py adapters/cpp/samples/bubble_sort.cpp -o bubble_inst.cpp
# 然后用 g++ 编译 bubble_inst.cpp 链接 retrace.h，运行得到 trace.json
```

---

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

## 本地开发

```bash
cd player
npm install            # 或 pnpm install
npm run typecheck      # 静态类型检查
npm run test:analysis  # Phase 3 分析层单元测试（纯函数，71 项）
npm run test:services  # factories + browser pure helpers + native stub
npm run build          # 生产构建
npm run dev            # 本地开发服务器（默认 5173）
```

播放器启动后加载的是 `public/samples/bubble_sort.json`，可在 `src/main.ts` 的 `loadTrace()` 中切换样本或接入你自己的适配器产物。

### 开发者：构建 / 发布命令

```bash
# Typecheck + build + 全部单元测试
cd player && npm run typecheck && npm run test && npm run build

# Tauri dev 热更新（需要本地 Rust 1.77+ + python3 + g++）
cd player && npm run dev:tauri

# Tauri 打包（生成 src-tauri/target/release/bundle/*）
cd player && npm run build:tauri -- --bundles deb,appimage

# GH Pages 部署：push main 自动触发
# 桌面版 Release：打 tag vX.Y.Z 自动触发（见 .github/workflows/）
git tag -a v0.1.0 -m "Phase 4 release"
git push origin v0.1.0
```

---

## 能力矩阵

| 特性 | Web（GH Pages） | Tauri 桌面（默认） | Tauri 桌面（缺工具链，Hybrid 回退） |
| --- | --- | --- | --- |
| Python 录制 | ✅ Pyodide | ✅ 本机 python3 | ✅ Pyodide 自动回退 |
| C++ 录制 | ✅ Pyodide+clangWASM | ✅ 本机 g++ | ✅ clangWASM 自动回退 |
| 离线可用 | 需一次下载 CDN + clang 缓存 | ✅ 完全离线 | ✅（clangWASM 已缓存时离线） |
| 编辑/Import/Export | ✅ | ✅ | ✅ |
| 调试特性（Phase 3） | ✅ | ✅ | ✅ |

---

## Phase 4 · 多端分发架构

**两条分发路径**（两端共用同一套 Player UI + 录制抽象层 `IRecorderService`）：

1. **Web 端（GitHub Pages）** — 纯浏览器可访问，无需安装。
   - Python 录制：首次 `loadPyodide` 从 CDN 加载 CPython WASM（~25 MB），后续录制 < 1s 冷启动。
   - C++ 录制：首次下载 clang-17 WASI 包（~100 MB，强缓存后永久可用）；插桩仍然复用 Pyodide 执行 `adapters/cpp/instrument.py`，编译走浏览器内 clang，执行通过 WebAssembly + `retrace.h` 的 `__WASM__` 分支回调 trace 回 JS。
2. **桌面端（Tauri 安装包 deb/AppImage/dmg/nsis）** — 调用本机 `python3` + `g++`，录制速度与桌面脚本一致。如果 `apt install` 后仍然缺工具链，Hybrid 模式自动**回退**到浏览器实现（Pyodide + clangWASM），保证功能永远可用。

关键文件：

- 录制抽象：[player/src/services/types.ts](player/src/services/types.ts)（`IRecorderService` 接口）
- Web 录制：[player/src/services/browser.ts](player/src/services/browser.ts)（Pyodide + Wasmer + clangWASM）
- 桌面录制：[player/src/services/native.ts](player/src/services/native.ts)（本机 `python3` + `g++`）
- Hybrid 调度：[player/src/services/hybrid.ts](player/src/services/hybrid.ts)（能力探测 + 自动回退）
- C++ 运行时：[adapters/cpp/retrace.h](adapters/cpp/retrace.h)（单头文件，含 `__WASM__` 与 native 双路径）
- COOP/COEP 头：[player/vite.config.ts](player/vite.config.ts)（为 SharedArrayBuffer 注入）

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

匹配结果会以「搜索芯片」形式显示在输入框右侧，格式为 `当前序号/总匹配数 at #帧号 · matches: 前3个命中帧号列表`；输入过程中对语法错误即时提示为红色错误芯片，正确时显示灰色提示条。无匹配或查询失败会在页面顶部弹出短暂的 toast 提示。

实现入口：[player/src/ui/searchBar.ts](player/src/ui/searchBar.ts) + [player/src/analysis.ts](player/src/analysis.ts) 中的 `parseSearch` / `findAllMatches`。

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
- 对象/数组支持递归展开，展开状态在普通视图与 Diff 之间共享。

实现入口：[player/src/ui/varTree.ts](player/src/ui/varTree.ts) 的 `renderDiff()` 与 [player/src/analysis.ts](player/src/analysis.ts) 的 `diffVars()`。

### Phase 3 架构约束

为了保持可测试，Phase 3 严格遵守「纯函数分析层 + 视图组件」分层：

- [player/src/analysis.ts](player/src/analysis.ts) 全是纯函数（无 DOM、无 Player、无定时器），可以在 Node 下用 `npm run test:analysis` 直接运行（71/71 通过）。
- `player/src/ui/*.ts` 的 UI 组件是「哑视图」：接收状态、回调与 `TraceFile`，在内部构建 DOM；不自己管理时间线状态。
- [player/src/main.ts](player/src/main.ts) 作为唯一的装配胶水：把 Player、SearchBar、Controls、VarTree、Terminal 的回调和状态订阅绑在一起。

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

---

## 路线图

### 已完成

- ✅ Phase 0–4（见阶段总览）

### 规划中（OOBE 路线）

> 以下为日后**开箱即用体验（Out-of-Box Experience）**方向的候选工作，**当前尚未实现**，仅作规划占位。

- **首次引导**：第一次打开时弹出引导卡，带用户走一遍「写代码 → 录制 → 步进 → Diff」全流程
- **语言模板库**：内置更多语言样本（递归、DP、图算法），按难度分类，一键加载
- **录制配置面板**：可视化选择 `RT_MAX_STEPS`、采样率、变量深度等运行时参数
- **Trace 分享**：录制产物上传到 Gist / 仓库内嵌，生成短链分享给他人回放
- **多文件项目**：从单文件扩展到项目级（多文件 + 自定义 build 命令）
- **逆向回放**：支持从末帧倒放，便于定位「最后一次正确」的帧

如需启动其中任一项，开 issue 标注 `roadmap` 即可。

---

## 许可证

见 [LICENSE](LICENSE)。
