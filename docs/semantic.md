# 语义文档：dsh-comfyui（ComfyUI 操控面）

| 项 | 值 |
|----|----|
| 能力名 | dsh-comfyui（插件内 `name = 'agent-comfyui'`；组合行 id `agent-comfyui`） |
| 主副本路径 | `self-plugins/dsh-comfyui/docs/semantic.md` |
| 实现落点 | `self-plugins/dsh-comfyui/src/index.ts` |
| 版本 | v0.1.1（package.json） |
| 状态 | **draft**（补课文档，验收条目多数待线上复核） |
| 依赖服务 | `inject = ['tools']`（+ `@deepseek-ai/schemastery` 配置 schema） |
| 外部依赖 | `comfyui-skill` CLI、ComfyUI 本体（`comfyuiDir` + `comfyuiPython`）、workspace 目录（`config.json` + `data/`） |

---

## 1 · 定位与反定位

**定位**：把主人既有的 `comfyui-skill` CLI（`<bin> --json --dir <workspaceDir> …`）封装成 14 个 DSH 工具，
让模型在同一会话里完成「查服务器状态 → 启停服务器 → 找工作流 → 提交/执行 → 查任务 → 查队列/模型 → 释放显存」的完整生图操控回路，**零重复实现**（不重写 ComfyUI API 客户端）。

**反定位（本文不管什么）**：
- 不管 ComfyUI 本体、节点、模型权重（那属于 `D:\桌面\ComfyUI` 与 `comfyui-manager/workspace`，本插件只调用）
- 不管提示词/画师/标签方法论（那属于技能 `comfyui-guidance` 与 `dsh-anima-tags`）
- 不管 web 服务器生命周期（那属于 `dsh-agent-sentinel` / `dsh-agent-guardian`）
- **不是** ComfyUI 的替代前端，也**不是** Anima 生图流水线本身——它只是「手」

## 2 · 术语表

| 术语 | 含义 |
|------|------|
| `comfyui-skill` | 主人已验证的外部 CLI（`https://github.com/HuangYuChuh/ComfyUI_Skill_CLI`），本插件唯一的外部执行体 |
| workspaceDir | CLI 的工作目录，内含 `config.json`（servers 声明）与 `data/`（工作流定义） |
| 工作流 ID | `<server>/<workflow>` 形式，如 `local/anima-v2-timeai-core` |
| prompt_id | ComfyUI 提交后返回的任务标识，`comfy_task status/cancel` 的句柄 |
| 离线降级 | 服务器不在线时工具**返回结构化错误**（`ok:false` + `error`），不抛异常、不静默 |
| venv 断裂 | `pyvenv.cfg` 的 `home` 指向已不存在的 base 解释器——`comfy_start` 会尝试自愈 |

## 3 · 概念模型

```
模型（爱丽丝）
  │  14 个 comfy_* 工具
  ▼
dsh-comfyui/src/index.ts
  ├─ runCli(config, args)          spawn(comfyuiBin, ['--json','--dir',workspaceDir, ...args])
  │     └─ 解析 stdout 首 JSON 块 → { ok, data, raw, stderr }（超时 kill，默认 timeoutMs=120000）
  ├─ checkPythonEnv(pythonPath)    existsSync → venvBrokenInfo(读 pyvenv.cfg) → python --version
  │     └─ 断裂时 repairVenv()：备份 pyvenv.cfg → 候选 base 逐个改写+探活 → 失败还原
  └─ comfy_start 专属：spawn(python,['-u','main.py','--listen','127.0.0.1','--port',port,
                        '--enable-manager','--preview-method','auto'], detached)
        └─ stdout/stderr → <comfyuiDir>/.dsh-comfyui-startup.log（落盘产物）
        └─ 每 3s 轮询 `server status`，最多 100 次（≈300s）

外部世界：comfyui-skill CLI → 127.0.0.1:<comfyuiPort>(8300) 的 ComfyUI 服务器
```

不变量（invariants）：
1. **I1 一律走 CLI**：本插件不得直接对 ComfyUI HTTP API 发请求——所有能力经 `runCli` 转达（可用源码 grep `http` / `fetch` 判真假：`src/index.ts` 内无网络调用）。
2. **I2 离线不抛异常**：服务器离线/CLI 缺失时，工具返回 `{ok:false, error}`；`comfy_status` 在离线时返回 `ok:false` 且 `status` 保留 CLI 原始 JSON。
3. **I3 工具数固定为 14**：`comfy_status/start/stop/workflows/submit/run/task/queue/models/free/upload/templates/nodes/logs`——数量可被 `toolface`/工具列表测量。
4. **I4 启动必有落盘日志**：`comfy_start` 每次运行都会向 `<comfyuiDir>/.dsh-comfyui-startup.log` 追加（除非目录不可写），可 `tail` 判「是不是它拉起来的」。

## 4 · 契约

### 4.1 配置（`Config` schema，全部有默认值）
| 字段 | 默认 | 说明 |
|------|------|------|
| `comfyuiBin` | `comfyui-skill` | CLI 命令名或绝对路径（ENOENT 时给出明确提示） |
| `workspaceDir` | `E:/alice/anima/02-技能包/comfyui-good-anima/comfyui-manager/workspace` | CLI `--dir` 目标 |
| `timeoutMs` | `120000` | 子进程超时（ms） |
| `comfyuiDir` | `D:/桌面/ComfyUI` | `comfy_start` 的 cwd + 启动日志落点 |
| `comfyuiPython` | `D:/桌面/ComfyUI/.venv/Scripts/python.exe` | `comfy_start` 使用的解释器 |
| `comfyuiPort` | `8300` | 监听/停止判据端口 |

### 4.2 状态→裁决表（关键分流）
| 输入状态 | 裁决 | 依据 |
|---------|------|------|
| `server status` 返回 `status==='online'` | `comfy_status.ok=true` | 在线即可用 |
| `withStats=true` 且在线 | 追加 `server stats`，其成败决定最终 `ok` | 统计失败即整体失败 |
| `comfy_start` 前已在线 | 直接返回 `{ok:true,url}`，**不重复拉起** | 幂等，防双实例 |
| `comfy_start` 前离线且 python 不存在 | `ok:false` + 提示 `plugin_configure dsh-comfyui` 改 `comfyuiPython` | 预检前置，避免 300s 干等 |
| `comfy_start` 前离线且 venv 断裂、自愈成功 | 继续启动，返回附 `note:'venv 已自动修复'` | 自愈留痕 |
| 300s 未就绪 | `ok:false` + **不杀进程** + 附日志尾部 800 字符 | 冷启动可 >300s |
| `comfy_stop` 端口无监听 | `ok:false, error:'端口 N 无监听进程'` | 前置判据 |
| `comfy_task` 缺 `promptId`（status/cancel）或 `workflowId`（history） | `ok:false` + 明确缺参错误 | 参数校验 |
| `comfy_workflows` CLI 返回空数组 | 回退扫 `data/`：`<server>/<name>/workflow.json`（dir）、`<server>/*.json`（file）、`data/*.json`（file-top） | 2026-08-19 兼容两种落盘格式 |

### 4.3 调用点清单 `[MUST]`
| 调用方 | 调用点（文件:符号） | 时机 |
|-------|------------------|------|
| web profile 组合 | `.dsh/profiles/web/cordis.patch.yml` 行 `id: agent-comfyui` / `name: dsh-comfyui`（含 6 项 config） | web 启动挂载 |
| 插件本体 | `src/index.ts:apply(ctx, config)` → `ctx.tools.register(defineTool({name:'comfy_status'…}))` | 挂载时注册 |
| 插件本体 | `src/index.ts:apply` 注册其余 13 个工具：`comfy_start` / `comfy_stop` / `comfy_workflows` / `comfy_submit` / `comfy_run` / `comfy_task` / `comfy_queue` / `comfy_models` / `comfy_free` / `comfy_upload` / `comfy_templates` / `comfy_nodes` / `comfy_logs` | 挂载时注册 |
| 全部工具 | `src/index.ts:runCli(config, args, timeoutMs?)` → `spawn(comfyuiBin, ['--json','--dir',workspaceDir,…])` | 每次工具调用 |
| `comfy_start` | `src/index.ts:checkPythonEnv` → `venvBrokenInfo` → `repairVenv`（改写 `pyvenv.cfg`，备份 `pyvenv.cfg.bak`） | 仅离线启动时 |
| `comfy_start` | `src/index.ts`：`openSync(<comfyuiDir>/.dsh-comfyui-startup.log,'a')` + detached spawn | 仅离线启动时 |
| `comfy_stop` | `src/index.ts`：`spawn('netstat',['-ano'])` 解析 `:<port>` LISTENING → `spawn('taskkill',['/F','/PID',pid])` | 停止时 |
| 模型（爱丽丝） | 只读探针：`comfy_status` / `comfy_workflows` / `comfy_models` / `comfy_queue` / `comfy_logs` | 生图前后 |
| 模型（爱丽丝） | 写路径：`comfy_submit` → `comfy_task status` → 取输出；或 `comfy_run` 阻塞等待 | 生图主链 |
| 承载插件（间接） | skill `comfyui-guidance` 描述的操作流程全部落在这 14 个工具上 | 方法论层 |

## 5 · 边界与信任

- 能力边界 ≠ 沙箱：本插件能启停**本机** ComfyUI 进程、能杀指定端口监听进程（`taskkill /F`）、能改写 `pyvenv.cfg`。**它不校验调用者意图**——边界靠上层（主人指令 + 授权纪律）。
- 不越界清单：不训练/不下载模型；不改 ComfyUI 源码；不暴露公网（`--listen 127.0.0.1`）；不删除工作流定义。
- 失败面：
  - 写失败：`repairVenv` 逐候选尝试，失败**还原原文**（`orig` 回写）；日志 fd 打不开 → **不阻塞启动**（注释明示）。
  - 读失败：`config.json` 解析失败 → 回退默认 `serverIds={'local'}`；`data/` 扫描异常 → 返回 CLI 原始结果。
  - 超时：CLI 超时 → `kill` + `stderr` 写明 `comfyui-skill 超时（Nms）`；`comfy_start` 就绪轮询超时 → 进程保留 + 日志尾部回传（**放行 + 报错**，不静默）。

## 6 · 与既有机制的关系

- 与 **AGENTS.md §5.22（机制自证）**：`comfy_start` 的启动日志落在 `comfyuiDir`，属「侧车产物」；但 `ctx.logger` 不落盘，故 ready 行**不作为证据**，证据只取日志文件与工具应答。
- 与 **§5.11（组合变更必验证）**：改 `src/index.ts` 后必须 `pnpm build` 并让预检看到 `lib/index.js` mtime 更新（`hasUnverifiedBuilds()`），否则 web 仍在跑旧构建。
- 与 **daemon_restart**：改配置走 `plugin_configure dsh-comfyui`（patch 整体替换 + 预检 + 哨兵重启）。
- 与 `dsh-anima-tags` / 技能 `comfyui-guidance`：标签检索 → 提示词 → 本插件提交，是**前后工序**而非替代关系。

**生效判据（改代码后怎么证明真的生效）**：
1. 构建产物新：`self-plugins/dsh-comfyui/lib/index.js` 的 mtime **晚于**当前 web 进程启动时间（进程级判据，见 §5.11；`preflight_check` 的 `hasUnverifiedBuilds()` 用同一口径）。
2. 工具面在场：本会话工具列表里能列出 14 个 `comfy_*`（或 `plugin_inspect dsh-comfyui` 显示 mounted）。
3. 行为可答：`comfy_status` 返回结构化结果（离线也应返回 `ok:false`+`error`，而不是「工具不存在」）。
4. 落盘产物：执行一次 `comfy_start` 后 `<comfyuiDir>/.dsh-comfyui-startup.log` mtime 前进（这是唯一不依赖内存的物证）。

**回退**：本插件无独立版本锚点，回退即 `git revert` 本仓库最近一次提交 → `pnpm build` → 预检 → 哨兵重启 web；
配置回退用 `plugin_configure dsh-comfyui` 还原 `comfyuiBin/workspaceDir/comfyuiPython/comfyuiPort` 上一组值（patch 整体替换会留 `.bak-<时间戳>`）。

## 7 · 可证伪验收清单

| # | 可证伪命题 | 证据（单测名/命令/日志行/HTTP） | 状态 |
|---|-----------|------------------------------|------|
| A1 | 工具面恰好 14 个 `comfy_*`，名字与源码一致 | `grep -c "name: 'comfy_" src/index.ts` = 14 | 待验收 |
| A2 | 不直接触网（只经 CLI） | `grep -nE "httpRequest\|fetch\(\|axios" src/index.ts` 无命中 | 待验收 |
| A3 | 服务器离线时工具不抛异常 | 停掉 8300 后调 `comfy_status` → 返回 `ok:false` + `error` 字符串 | 待验收 |
| A4 | `comfy_start` 冷启动留痕 | 启动后 `<comfyuiDir>/.dsh-comfyui-startup.log` mtime 前进且尾部含 `main.py` 启动输出 | 待验收 |
| A5 | `comfy_stop` 只杀端口监听进程 | 执行前后 `netstat -ano \| findstr :8300` 有无变化 | 待验收 |
| A6 | 幂等：已在线时 `comfy_start` 不新起进程 | 调用前后 PID 不变（`comfy_status` 的 `status.server_id`/`netstat` 对比） | 待验收 |
| A7 | `comfy_workflows` 空列表回退扫描生效 | 造 `data/local/<name>/workflow.json` → `comfy_workflows` 返回 `format:'dir'` 条目 | 待验收 |
| A8 | venv 自愈不改坏环境 | 人为把 `pyvenv.cfg` 的 `home` 改错 → `comfy_start` 后备份 `pyvenv.cfg.bak` 存在且 `python --version` 可用 | 待验收（需真机 venv） |
| A9 | CLI 参数拼装恒为 `--json --dir <ws>` 前缀（含空参数数组/空串入参的退化） | `node --test "tests/*.test.mjs"` → `tests/cli.test.mjs` `buildCliArgs` 用例 | **已验收**（2026-09-14 · 60/60 全绿） |
| A10 | 入参校验拒收非法动作/缺参（queue/task），**不落到 CLI** | 同上 `planQueueCliArgs` / `planTaskCliArgs` 失败路径用例 | **已验收** |
| A11 | 错误分类优先序 data → stderr → raw → 兜底，截断 500；退化 data（空对象/数组/标量）不误判为错误载荷 | 同上 `cliError` 用例 | **已验收** |
| A12 | `comfy_workflows` 空列表回退的分类判定：三格式顺序、未声明 server 整棵跳过、目录探针缺失不计入、`.json` 大小写敏感 | `tests/workflows.test.mjs`（`parseWorkspaceConfig` + `discoverWorkflows`） | **已验收** |
| A13 | pyvenv.cfg 解析的语义分界：无 home 行 ⇒ `null`（未断裂）vs 值为空白 ⇒ `''`（走探活）；CRLF / 尾部分隔符 | `tests/venv.test.mjs` | **已验收** |
| A14 | 不变量守卫：I1 不触网 / I3 恰好 14 工具 / I4 启动日志落点（检测器先过尸体样本） | `tests/invariants.test.mjs` | **已验收** |

## 8 · 与实现的关系

- 主实现：`self-plugins/dsh-comfyui/src/index.ts`（721 行，单文件）。
- 同语义副本：无。CLI 侧语义（`comfyui-skill` 的子命令语义）**不在本文管辖**，以该 CLI 自身文档为准。
- 未实现/未显式化的部分：
  - `comfy_templates` / `comfy_nodes` / `comfy_logs` 声明了 `action` 参数但**仅忽略值固定发 `list`/`show`**——文档如实记录，不粉饰。
  - 纯逻辑层已抽成模块（2026-09-14 补课，**行为不变**）：`src/cli.ts`（CLI 参数拼装 / 入参校验 / 结果组装 / 错误分类）、
    `src/workflows.ts`（`config.json` 解析 + `data/` 树分类）、`src/venv.ts`（`pyvenv.cfg` 路径与解析）；
    `src/index.ts` 只保留接线与 IO（`spawn` / `readdirSync` / 文件改写）。
  - **离线单测**：`tests/{cli,workflows,venv,invariants}.test.mjs`，60 条，跑 `lib/` 产物（与运行时同源），零网络零 IO。
  - A1–A8 中依赖真机/在线的条目（A3–A8）仍为**待验收**，须在线上用命令取证，不得用「已实现」笼统掩盖；
    与纯逻辑相关的 A9–A14 已由离线单测锁定。

## 9 · 实践修订记录

- **2026-09-14 补课：本插件此前无语义文档（可维护性工程）**
  - 语义**被确认**：14 工具面 / 一律走 CLI / 离线返回结构化错误 / `comfy_start` 自带 python 预检与 venv 自愈。
  - 语义**被补充**：`comfy_start` 的启动日志落点 `<comfyuiDir>/.dsh-comfyui-startup.log`（此前只写在源码注释里，属 5.22 要求的「机制自证」缺口）。
  - 语义**被修正**：无（首次成文）。
  - 教训：机制的关键落盘产物若只存在于源码注释，压缩后的我无法从外部回答「它到底怎么启动的」——文档必须写落点。

- **2026-09-14 补课：抽出纯逻辑层 + 60 条离线单测（可维护性补课 S3/S6）**
  - 语义**被补充**：`comfy_workflows` 空列表回退的判定顺序与过滤条件（未声明 server 目录整棵跳过、`.json` 大小写敏感、
    目录探针 `hasWorkflowJson !== true` 不计入）此前只存在于代码行里，现由 `tests/workflows.test.mjs` 显式化。
  - 语义**被记录（不改行为）**：`parsePyvenvHome` 的「未匹配（`null`）」与「匹配但值为空（`''`）」是**不同分支**——
    后者会真的去探 `join('', 'python.exe')` 并可能判「断裂」。旧代码用内联 regex + `if (m === null)` 表达同一语义，
    但没有任何地方写明；现以返回 `null` 区分并加测试钉死。
  - 语义**被记录**：`composeStatusResult(status, null, true)` 属**调用前置条件违规**（抛 TypeError）——调用方必须先用
    `needsStats()` 门控。刻意**不**改成静默兜底：静默会掩盖接线错误（测试以边界用例钉住该契约）。
  - 语义**被修正**：无——本插件本轮**未发现行为级缺陷**；所有观察到的边界语义一律按「如实记录、不改行为」处置。
  - 教训：单文件插件把「判定逻辑」与「IO」焊在一起时，任何边界语义都无法离线复现；**搬家不改语义**是解锁测试的最小代价手段。

## 10 · 未决问题

- ~~**U1 验收无单测**：本仓库无 `tests/`，A1–A8 只能靠线上命令取证。是否为纯 CLI 封装补一层可离线测试的参数构造纯函数？~~
  **已闭环（2026-09-14）**：抽出 `cli.ts` / `workflows.ts` / `venv.ts` 纯逻辑层 + `tests/*.test.mjs` 60 条（含失败/退化路径），
  A9–A14 已验收；依赖真机的 A3–A8 保持待验收。
- **U4 接线层无自动化验证**：`comfy_start` 的进程启动、`comfy_stop` 的 `taskkill`、`runCli` 的真子进程路径**没有离线单测**
  （需真机/真 CLI；起服务会占用主人环境，本轮明确禁止）。当前覆盖为「纯逻辑层全测 + 线上探针 A3–A8」两层；
  倾向**不做假 CLI 桩**替代真实集成验收（桩只证明桩自己的假设）。
- **U2 `comfy_templates`/`comfy_nodes` 的 `action` 形参**：目前只支持 list/show 且值被忽略——是收敛签名（去掉参数）还是补齐 action 分流？需主人裁决。
- **U3 端口/进程所有权**：`comfy_stop` 用 `taskkill /F` 杀端口监听者；若未来有第二个 owner 也管 8300，需按 AGENTS.md §5.19 引入租约——当前无此冲突，先记为风险。
