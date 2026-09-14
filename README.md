<!--
  DSH 插件生态公约声明（plugin-ecosystem-convention · 组合优先/声明清晰/兼容优先）
  purpose: ComfyUI 操控插件：把 comfyui-skill CLI 封装为 14 个 DSH 工具（状态/启停/工作流/提交/执行/任务/队列/模型/显存/上传/模板/节点/日志），支撑 Anima 生图回路
  inject: 'tools'
  tools: comfy_status, comfy_start, comfy_stop, comfy_workflows, comfy_submit, comfy_run, comfy_task, comfy_queue, comfy_models, comfy_free, comfy_upload, comfy_templates, comfy_nodes, comfy_logs（14 个）
  runtime: host-only
  envDeps: comfyui-skill CLI + 本机 ComfyUI 安装（comfyuiDir / comfyuiPython）+ workspace 目录（config.json + data/）
  boundary: 能启停本机 ComfyUI 进程、taskkill 占用端口的进程、改写 .venv/pyvenv.cfg 自愈 venv；不校验调用者意图，边界靠上层授权纪律；只监听 127.0.0.1
  compat: cordis ^4.0.1 / schemastery ^3.18.1-rc.1 / dsh-tools ^0.1.0-rc.6
-->
# dsh-comfyui

<p align="center">
  <a href="https://github.com/jonah791/dsh-comfyui"><img src="https://img.shields.io/badge/version-0.1.1-blue" alt="version"></a>
  <img src="https://img.shields.io/badge/License-MIT-green" alt="license">
  <img src="https://img.shields.io/badge/TypeScript-3178C6" alt="TypeScript">
  <img src="https://img.shields.io/badge/tests-60%20passed-brightgreen" alt="tests">
</p>

**一句话**：把本机既有的 `comfyui-skill` CLI 包成 14 个 `comfy_*` 工具——查状态、起停服务器、找工作流、提交/执行、查任务与队列、看模型与显存、上传素材、翻日志，全在同一个 agent 会话里完成。

**为什么值得用**：模型不用再手拼 `comfyui-skill --json --dir …` 命令、不用记 workspace 里工作流 ID 的命名规则、不用自己处理「服务器没起 / venv 断了 / 端口被占」这些破事——**离线时工具返回结构化 `{ok:false,error}` 而不是抛异常**，冷启动超 300s 也不杀进程而是把日志尾部带回来。**零重复实现**：本插件不重写 ComfyUI API 客户端，只做 CLI 的转达与裁决。

## 能力

| 工具 | 用途 |
|------|------|
| `comfy_status` | 服务器状态：在线/离线、URL、VRAM/RAM/GPU 资源（`withStats`）。生图前先查 |
| `comfy_start` | 启动服务器（detached，不随 web 退出）：先探 python → venv 断裂则自愈 → spawn `main.py --listen 127.0.0.1 --port <port> --enable-manager`，每 3s 轮询最多 ≈300s；**已在线则直接返回，不重复拉起** |
| `comfy_stop` | 停止服务器：`netstat -ano` 找 `<port>` LISTENING 进程 → `taskkill /F` |
| `comfy_workflows` | 列出可用工作流（含参数 schema）或看单个详情；ID 形如 `<server>/<workflow>` |
| `comfy_submit` | 提交工作流到队列（非阻塞，立即返回 `prompt_id`） |
| `comfy_run` | 提交并阻塞等待完成（最长 `timeoutMs`），返回最终状态与输出 |
| `comfy_task` | 任务管理：`status`（查执行状态与输出）/ `cancel` / `history` |
| `comfy_queue` | 队列：`list` 运行中与排队 / `clear` 清空排队 |
| `comfy_models` | 模型列表：不传 `folder` = 全部文件夹；传 `checkpoints`/`loras`/`vae`… = 该目录 |
| `comfy_free` | 释放 GPU 显存并卸载模型（长任务/换模型前，防 OOM） |
| `comfy_upload` | 上传本地文件到服务器（图片/音频/视频等），或用 `--from-output` 直接引用上一次工作流输出 |
| `comfy_templates` | 发现工作流模板与子图（`list`） |
| `comfy_nodes` | 发现可用节点类型及其输入参数（`list`） |
| `comfy_logs` | 查看服务器最近日志（`show`） |

> `comfy_templates` / `comfy_nodes` / `comfy_logs` 声明了 `action` 形参但当前**只发 `list`/`show`、忽略传入值**（语义文档 §8 如实记录，未粉饰）。

## 快速开始

**1) 装依赖**（自研插件家园 `self-plugins/`，在目标 profile 的 `package.json` 加 link 依赖）：

```jsonc
"dsh-comfyui": "link:<工作区>/self-plugins/dsh-comfyui"
```

**2) 挂组合**（web profile patch 行）：

```yaml
- insert:
    - id: agent-comfyui
      name: dsh-comfyui
      config:
        comfyuiBin: comfyui-skill
        workspaceDir: <工作区>/anima/02-技能包/comfyui-good-anima/comfyui-manager/workspace
        timeoutMs: 120000
        comfyuiDir: <ComfyUI 安装目录>
        comfyuiPython: <ComfyUI 安装目录>/.venv/Scripts/python.exe
        comfyuiPort: 8300
```

**3) 30 秒验证**：调 `comfy_status`——
- 服务器在跑 → 返回 `ok: true` + URL（再带 `withStats: true` 可看 VRAM）；
- 服务器没跑 → 返回 `ok: false` + `error` 字符串（**这也是正确行为**：离线不抛异常。若报「工具不存在」才是没挂上）。

## 配置

| 项 | 默认 | 说明 |
|----|------|------|
| `comfyuiBin` | `comfyui-skill` | CLI 命令名或绝对路径（找不到时给明确提示，不静默） |
| `workspaceDir` | 本机 Anima workspace 目录 | CLI `--dir` 目标：内含 `config.json`（servers 声明）与 `data/`（工作流定义） |
| `timeoutMs` | `120000` | 子进程超时（ms）；超时 kill 并在 stderr 写明 `comfyui-skill 超时（Nms）` |
| `comfyuiDir` | 本机 ComfyUI 安装目录 | `comfy_start` 的 cwd + 启动日志落点 |
| `comfyuiPython` | `<comfyuiDir>/.venv/Scripts/python.exe` | `comfy_start` 使用的解释器；不存在时**前置拒绝**（不干等 300s） |
| `comfyuiPort` | `8300` | 监听端口 / 停止判据端口 |

改动配置走 `plugin_configure dsh-comfyui`（patch 整体替换 + 预检 + 哨兵重启）。

## 落盘与自证（出问题时先看这里）

**侧车轨迹：无。** 本插件未接入 `*-trace.jsonl` 证据层（`ctx.logger` 的 ready 行宿主**不落盘**，不能当证据）。它确实写盘的只有两处：

| 产物 | 落点 | 写入时机 |
|------|------|---------|
| 启动日志（**追加**） | `<comfyuiDir>/.dsh-comfyui-startup.log` | 每次 `comfy_start` 拉进程时（ComfyUI 本体 stdout/stderr 直落） |
| venv 配置（**改写+备份**） | `<comfyuiDir>/.venv/pyvenv.cfg`（改前存 `.bak`） | 仅 `home` 指向失效 base 解释器、触发自愈时 |

**一条命令答五问**（该日志是 ComfyUI 本体输出，**无阶段枚举**——能答的答，答不了的如实说）：

```bash
tail -5 "<ComfyUI 安装目录>/.dsh-comfyui-startup.log"
# ① 跑的是哪个构建   → 答不了（无 build 自报）。改用 lib/index.js mtime vs web 进程启动时间，见下节
# ② 谁发起           → 答不了（无 caller 字段）。改看工具应答与调用会话
# ③ 断在哪一段       → 答不了阶段枚举；只能看尾部有无 Python traceback / 端口占用报错
# ④ 结果质量         → 尾部的启动横幅与 `To see the GUI go to: http://127.0.0.1:<port>` 即「起没起来」
# ⑤ 耗时与预算       → 答不了（无时间戳）。改用调用方观察到的 comfy_start 等待时长 vs 300s 预算
```

**行为级验证（无轨迹时的主要判据）**：`comfy_status` 返回结构化结果、`comfy_start` 幂等（第二次调用 PID 不变）、`comfy_stop` 前后 `netstat -ano | findstr :8300` 由有变无。

## 生效判据与回退

**生效判据**（三选一，按可靠性排序）：
1. **进程级**：`self-plugins/dsh-comfyui/lib/index.js` 的 mtime **早于** web 进程启动时间 ⇒ 进程在跑当前构建（与 `preflight_check` 的 `hasUnverifiedBuilds()` 同口径）；
2. **生态级**：本会话工具列表能列出 14 个 `comfy_*`，或 `plugin_inspect dsh-comfyui` 显示 mounted；
3. **行为级**：`comfy_status` 能返回结构化结果（离线也应返回 `ok:false` + `error`，而不是「工具不存在」）。

> 注意：**重新构建 ≠ 生效**——`lib/index.js` mtime 新只证明「构建过」，**进程启动时间晚于产物 mtime** 才算「在跑它」。改完源码必须 `npm run build` 并让预检看到新产物，否则线上还跑旧构建。

**回退**：
- 源码级：`git -C self-plugins/dsh-comfyui revert <commit>` → `npm run build` → `preflight_check` → 哨兵重启；
- 组合级：patch 里给 `agent-comfyui` 行加 `disabled: true`（或移除该行）→ 哨兵重启；配置回退用 `plugin_configure` 还原上一组值（patch 整体替换会留 `.bak-<时间戳>`）；
- 运行期：无需回退（本插件无持久业务状态；`.dsh-comfyui-startup.log` 与 `pyvenv.cfg.bak` 可随时删除）。

## 测试

```bash
npm run build && npm test        # build = tsc；test = node --test "tests/*.test.mjs"
```

**60 例离线测试全绿**（2026-09-14 实测 `# pass 60 / # fail 0`），跑 `lib/` 产物（与运行时同源）：

- `tests/cli.test.mjs` — CLI 参数拼装恒为 `--json --dir <ws>` 前缀（含空参/空串退化）、入参校验（queue/task 非法动作**不落到 CLI**）、错误分类优先序 `data → stderr → raw → 兜底` 且截断 500、退化 data（空对象/数组/标量）不误判
- `tests/workflows.test.mjs` — `config.json` 解析 + `data/` 树三格式分类（目录探针缺失不计入、未声明 server 整棵跳过、`.json` 大小写敏感）
- `tests/venv.test.mjs` — `pyvenv.cfg` 语义分界（无 `home` 行 ⇒ `null` vs 值为空白 ⇒ `''`）、CRLF / 尾部分隔符
- `tests/invariants.test.mjs` — 不变量守卫（I1 不直接触网 / I3 恰好 14 工具 / I4 启动日志落点），**检测器先过尸体样本**再上岗

**不需要网络，也不需要 ComfyUI 在线**——纯逻辑层零 IO 零网络。真机路径（启停进程、taskkill、真 CLI 子进程、venv 自愈）**没有离线单测**，属于线上探针范围（语义文档 §7 A3–A8，标注「待验收」）。

## 设计要点

- **I1 一律走 CLI**：本插件不得直接对 ComfyUI HTTP API 发请求，所有能力经 `runCli` 转达——`grep -nE "httpRequest|fetch\(|axios" src/index.ts` 应无命中。这是跨层不变量，改动时不得绕过。
- **I2 离线不抛异常**：服务器离线 / CLI 缺失 / 参数非法一律返回 `{ok:false, error}`；超时 kill 后把 stderr 带回来。调用方永远拿到可判断的结构，而不是异常。
- **`comfy_start` 三处「放行 + 报错」**：python 不存在 → 前置拒绝并提示改 `comfyuiPython`；venv 断裂 → 备份 + 逐候选 base 改写探活，全失败**还原原文**；300s 未就绪 → **不杀进程**（冷启动可能更久）+ 回传日志尾部 800 字符。
- **`comfy_stop` 只杀端口监听者**：`netstat -ano` 解析 `:<port> LISTENING` → `taskkill /F /PID`。端口无监听即前置报错，不做兜底清扫。
- **workspace 回退扫描**：CLI 返回空数组时回退扫 `data/`，兼容 `<server>/<name>/workflow.json`（dir）、`<server>/*.json`（file）、`data/*.json`（file-top）三种落盘格式。

### 安全边界（重要）

本插件能**启停本机进程**、`taskkill /F` 杀占用 `comfyuiPort` 的任意监听进程、改写 `.venv/pyvenv.cfg`——**它不校验调用者意图**，边界靠上层（主人指令 + 授权纪律），能力边界 ≠ 沙箱。不越界清单：不训练/不下载模型、不改 ComfyUI 源码、不暴露公网（`--listen 127.0.0.1`）、不删除工作流定义。若未来出现第二个 owner 也管同一端口，需按单点所有权纪律引入租约（当前无此冲突，记为风险）。

## 相关文档

| 文档 | 内容 |
|------|------|
| [`docs/semantic.md`](docs/semantic.md) | **权威契约**：定位与反定位、术语、概念模型与不变量（I1–I4）、契约（配置/状态裁决表/调用点清单）、边界与信任、可证伪验收清单（A1–A14）、实践修订记录、未决问题（U1–U4） |
| [alice-digital-life](https://github.com/jonah791/alice-digital-life) | 本插件所属生态的中心索引（全部自研插件） |
| 技能 `comfyui-guidance` | Anima 生图体系方法论（提示词/画师/参数/逆推）——与本插件是方法论层 ↔ 执行层的关系 |
| 姊妹插件 `dsh-anima-tags` | Danbooru 标签检索与校验（提示词硬锚点），与本插件构成前后工序 |

## License

MIT © jonah791

---

本插件属于我的数字生命爱丽丝（[alice-digital-life](https://github.com/jonah791/alice-digital-life)）的 DSH 自研插件生态——**50 个插件**按生命/认知/感知/行动/通信/治理/呈现七层组织。
