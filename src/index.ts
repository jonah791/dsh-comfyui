/**
 * dsh-comfyui — ComfyUI 操控插件（2026-08-19 主人需求）
 *
 * 封装 comfyui-skill CLI（https://github.com/HuangYuChuh/ComfyUI_Skill_CLI）为 DSH 工具面，
 * 支撑主人 Anima 生图体系（E:\anima，服务器 127.0.0.1:8300）：
 *   server status/stats · list/info · submit/run/status/cancel · queue · models · free
 *
 * 设计：
 * - 子进程调用 comfyui-skill（--json 结构化输出），零重复实现（复用主人已验证的 CLI）
 * - workspaceDir 指向 comfyui-manager/workspace（config.json + data/ 所在）
 * - 服务器离线时返回结构化错误（status=offline），不抛异常
 * - 工具面 = 8 个：状态/工作流/提交/执行/任务/队列/模型/显存
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync, copyFileSync, openSync, closeSync } from 'node:fs'
import { join, dirname } from 'node:path'

export const name = 'agent-comfyui'
export const inject = ['tools'] as const

export interface Config {
  /** comfyui-skill 可执行文件（PATH 内命令名或绝对路径） */
  comfyuiBin: string
  /** comfyui-manager workspace 目录（config.json + data/ 所在） */
  workspaceDir: string
  /** 子进程超时（ms） */
  timeoutMs: number
  /** ComfyUI 安装目录（comfy_start 用） */
  comfyuiDir: string
  /** ComfyUI python（comfy_start 用） */
  comfyuiPython: string
  /** ComfyUI 端口 */
  comfyuiPort: number
}
export const Config = z.object({
  comfyuiBin: z.string().default('comfyui-skill'),
  workspaceDir: z.string().default('E:/alice/anima/02-技能包/comfyui-good-anima/comfyui-manager/workspace'),
  timeoutMs: z.number().default(120000),
  comfyuiDir: z.string().default('D:/桌面/ComfyUI'),
  comfyuiPython: z.string().default('D:/桌面/ComfyUI/.venv/Scripts/python.exe'),
  comfyuiPort: z.number().default(8300),
})

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** python --version 探活（短超时）。 */
function pythonVersion(pythonPath: string, timeoutMs = 10000): Promise<{ ok: boolean; version: string; reason?: string }> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(pythonPath, ['--version'], { windowsHide: true })
    } catch (err) {
      resolve({ ok: false, version: '', reason: String(err) })
      return
    }
    let out = ''
    let errOut = ''
    const timer = setTimeout(() => {
      try { child.kill() } catch { /* 已退出 */ }
      resolve({ ok: false, version: out.trim(), reason: 'python --version 超时（' + timeoutMs + 'ms）' })
    }, timeoutMs)
    child.stdout?.on('data', (d: Buffer) => { out += d.toString('utf8') })
    child.stderr?.on('data', (d: Buffer) => { errOut += d.toString('utf8') })
    child.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, version: '', reason: e.message }) })
    child.on('close', (code) => {
      clearTimeout(timer)
      const v = (out + errOut).trim()
      resolve({ ok: code === 0, version: v, ...(code !== 0 ? { reason: 'python --version 退出 code=' + String(code) + '：' + v } : {}) })
    })
  })
}

/** venv 断裂检测：pyvenv.cfg 的 home 指向不存在的 base 解释器。 */
function venvBrokenInfo(pythonPath: string): { cfgPath: string; broken: boolean; home: string } {
  const venvDir = dirname(pythonPath)
  const cfgPath = join(venvDir, '..', 'pyvenv.cfg')
  if (!existsSync(cfgPath)) return { cfgPath, broken: false, home: '' }
  try {
    const cfg = readFileSync(cfgPath, 'utf8')
    const m = cfg.match(/^home\s*=\s*(.+)$/m)
    if (m === null) return { cfgPath, broken: false, home: '' }
    const home = (m[1] ?? '').trim().replace(/[\\/]+$/, '')
    const basePy = join(home, 'python.exe')
    return { cfgPath, broken: !existsSync(basePy), home }
  } catch {
    return { cfgPath, broken: false, home: '' }
  }
}

/** 修复 venv：把 pyvenv.cfg 的 home 指向候选 base（备份原文件），逐个候选验证。 */
async function repairVenv(pythonPath: string, cfgPath: string, brokenHome: string): Promise<{ ok: boolean; reason?: string }> {
  const candidates = [
    'C:/Users/tr/scoop/apps/python312/current',
    'C:/Users/tr/scoop/apps/python/current',
  ]
  let orig = ''
  try { orig = readFileSync(cfgPath, 'utf8') } catch (e) { return { ok: false, reason: '读取 pyvenv.cfg 失败: ' + String(e) } }
  const backup = cfgPath + '.bak'
  if (!existsSync(backup)) {
    try { copyFileSync(cfgPath, backup) } catch { /* 备份非必需 */ }
  }
  for (const base of candidates) {
    if (!existsSync(join(base, 'python.exe'))) continue
    try {
      writeFileSync(cfgPath, orig.replace(/^home\s*=.*$/m, 'home = ' + base.replace(/[\\/]+$/, '')), 'utf8')
    } catch { continue }
    const vc = await pythonVersion(pythonPath)
    if (vc.ok) return { ok: true }
    try { writeFileSync(cfgPath, orig, 'utf8') } catch { /* 还原失败继续 */ }
  }
  try { writeFileSync(cfgPath, orig, 'utf8') } catch { /* 兜底还原 */ }
  return { ok: false, reason: 'venv 断裂（home=' + brokenHome + '），候选 base 均无法修复' }
}

/** python 环境预检：存在性 + venv 断裂检测/自愈 + 可执行探活。返回可用 python 路径。 */
async function checkPythonEnv(pythonPath: string): Promise<{ ok: boolean; pythonPath: string; reason?: string; repaired?: boolean }> {
  if (!existsSync(pythonPath)) {
    return { ok: false, pythonPath, reason: 'python 不存在: ' + pythonPath + '（可 plugin_configure dsh-comfyui 改 comfyuiPython）' }
  }
  const vb = venvBrokenInfo(pythonPath)
  const vc = await pythonVersion(pythonPath)
  if (vc.ok) return { ok: true, pythonPath, ...(vb.broken ? { reason: '（注：venv home 指向缺失，但探活通过，可运行）' } : {}) }
  if (vb.broken) {
    const rep = await repairVenv(pythonPath, vb.cfgPath, vb.home)
    if (rep.ok) {
      const vc2 = await pythonVersion(pythonPath)
      if (vc2.ok) return { ok: true, pythonPath, repaired: true }
    }
    return { ok: false, pythonPath, reason: rep.reason ?? vc.reason }
  }
  return { ok: false, pythonPath, reason: vc.reason ?? 'python 不可执行' }
}

/** 调用 comfyui-skill，返回解析后的 JSON（stdout 首 JSON 对象） */
function runCli(config: Config, args: string[], timeoutMs?: number): Promise<{ ok: boolean; data: any; raw: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(config.comfyuiBin, ['--json', '--dir', config.workspaceDir, ...args], {
      windowsHide: true,
      shell: false,
    })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill()
      resolve({ ok: false, data: null, raw: '', stderr: 'comfyui-skill 超时（' + (timeoutMs ?? config.timeoutMs) + 'ms）' })
    }, timeoutMs ?? config.timeoutMs)
    child.stdout.on('data', (d: Buffer) => { stdout += d.toString('utf8') })
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString('utf8') })
    child.on('close', (code) => {
      clearTimeout(timer)
      const trimmed = stdout.trim().replace(/^\uFEFF/, '')
      // 先尝试整体解析（对象或数组）；失败再提取首 JSON 块（--json 输出可能带日志前缀）
      let data: any = null
      try {
        data = JSON.parse(trimmed)
      } catch {
        const objMatch = trimmed.match(/\{[\s\S]*\}/)
        const arrMatch = trimmed.match(/\[[\s\S]*\]/)
        const block = objMatch ?? arrMatch
        if (block !== null) {
          try { data = JSON.parse(block[0]) } catch { data = null }
        }
      }
      resolve({ ok: code === 0, data, raw: trimmed, stderr: stderr.trim() })
    })
    child.on('error', (err) => {
      clearTimeout(timer)
      const e = err as NodeJS.ErrnoException
      const kind = e.code === 'ENOENT'
        ? 'comfyui-skill 未找到（ENOENT）——请确认 CLI 已安装并加入 PATH，或用 plugin_configure dsh-comfyui 设置 comfyuiBin 绝对路径'
        : e.code === 'EACCES'
          ? 'comfyui-skill 无执行权限（EACCES）'
          : '无法启动 comfyui-skill'
      resolve({ ok: false, data: null, raw: '', stderr: kind + '：' + e.message })
    })
  })
}

/** 从 CLI 结果构建统一错误信息 */
function cliError(r: { ok: boolean; data: any; raw: string; stderr: string }): string | null {
  if (r.ok) return null
  const d = r.data as { error?: string; status?: string } | null
  if (d !== null && typeof d === 'object' && (d.error !== undefined || d.status !== undefined)) {
    return JSON.stringify(d).slice(0, 500)
  }
  return (r.stderr || r.raw || 'comfyui-skill 执行失败').slice(0, 500)
}

export function apply(ctx: Context, config: Config): void {
  const logger = ctx.logger('dsh-comfyui')

  // ---------- comfy_status：服务器状态 + 资源 ----------
  ctx.tools.register(defineTool({
    name: 'comfy_status',
    description: 'ComfyUI 服务器状态：在线/离线、URL、VRAM/RAM/GPU 资源（stats）。生图前先查，防提交到离线服务器。',
    parameters: {
      withStats: { type: 'boolean', description: '附带资源统计（VRAM/RAM/GPU，缺省 false 只查状态）' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          status: { type: 'json' },
          stats: { type: 'json' },
          error: { type: 'string' },
        },
      },
      render: (_a: unknown, v: any) => [{ type: 'text', text: 'ComfyUI：' + String(v.status?.status ?? v.status?.server_id ?? '?') + (v.status?.status === 'online' ? ' 在线' : ' 离线') + (v.error !== undefined ? ' · ' + String(v.error).slice(0, 80) : '') }],
    },
    async execute(args: { withStats?: boolean }) {
      const status = await runCli(config, ['server', 'status'])
      const statusErr = cliError(status)
      if (statusErr !== null && status.data === null) {
        return { ok: false, status: null, stats: null, error: statusErr }
      }
      if (args.withStats === true && (status.data as { status?: string })?.status === 'online') {
        const stats = await runCli(config, ['server', 'stats'])
        const statsErr = cliError(stats)
        return { ok: statsErr === null, status: status.data, stats: stats.data, ...(statsErr !== null ? { error: statsErr } : {}) }
      }
      return { ok: (status.data as { status?: string })?.status === 'online', status: status.data, stats: null, ...(statusErr !== null ? { error: statusErr } : {}) }
    },
  }))

  // ---------- comfy_start：启动 ComfyUI 服务器 ----------
  ctx.tools.register(defineTool({
    name: 'comfy_start',
    description: '启动 ComfyUI 服务器（后台 detached 进程，不随 web 退出）：spawn python main.py --listen 127.0.0.1 --port 8300，轮询 system_stats 直到在线（最长 300s，冷启动需 2-4 分钟；超时后进程继续启动，可用 comfy_status 复查）。已在线则直接返回。',
    parameters: {},
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          pid: { type: 'number' },
          url: { type: 'string' },
          status: { type: 'json' },
          error: { type: 'string' },
        },
      },
      render: (_a: unknown, v: any) => [{ type: 'text', text: v.ok ? 'ComfyUI 已启动：' + String(v.url) + (v.pid !== undefined ? '（pid ' + v.pid + '）' : '') : '启动失败：' + String(v.error ?? '').slice(0, 120) }],
    },
    async execute() {
      // 已在线 → 直接返回
      const pre = await runCli(config, ['server', 'status'], 15000)
      if (pre.data?.status === 'online') {
        return { ok: true, url: 'http://127.0.0.1:' + config.comfyuiPort, status: pre.data }
      }
      // python 环境预检（存在性 + venv 断裂自愈 + 可执行探活）——避免 120s 干等静默失败
      const env = await checkPythonEnv(config.comfyuiPython)
      if (!env.ok) {
        return { ok: false, error: 'ComfyUI python 环境异常：' + (env.reason ?? '未知') }
      }
      const pythonPath = env.pythonPath
      // 启动日志落盘（stdout/stderr 重定向到文件——失败时可查，不再 stdio ignore）
      const logPath = join(config.comfyuiDir, '.dsh-comfyui-startup.log')
      let logFd: number | undefined
      try { logFd = openSync(logPath, 'a') } catch { /* 日志打不开不阻塞启动 */ }
      let pid: number | undefined
      try {
        // -u 无缓冲：启动日志实时可读（排障时 tail 不再滞后）
        const child = spawn(pythonPath, ['-u', 'main.py', '--listen', '127.0.0.1', '--port', String(config.comfyuiPort), '--enable-manager', '--preview-method', 'auto'], {
          cwd: config.comfyuiDir,
          detached: true,
          stdio: logFd !== undefined ? ['ignore', logFd, logFd] : 'ignore',
          windowsHide: true,
        })
        child.unref()
        pid = child.pid
        // 父进程关闭自己的 fd 副本；子进程已持有重复句柄继续写日志
        if (logFd !== undefined) { try { closeSync(logFd) } catch { /* 忽略 */ } }
        logFd = undefined
        child.on('error', (err) => {
          // spawn 失败（如 python 不可执行）——记录但由轮询/超时统一收尾
          const e = err as NodeJS.ErrnoException
          logger.warn('comfy_start spawn error: ' + e.code + ' ' + e.message)
        })
      } catch (err) {
        if (logFd !== undefined) { try { closeSync(logFd) } catch { /* 忽略 */ } }
        return { ok: false, error: '无法启动 ComfyUI 进程：' + String(err) }
      }
      // 轮询就绪（最长 300s，每 3s 一次）——冷启动实测 2-4 分钟：Manager 启动要 FETCH 180 项
      // 注册表数据 + 冷文件缓存 + Defender 扫描新进程，120s 会误杀正常冷启动（2026-09-01 实测）
      for (let i = 0; i < 100; i += 1) {
        await sleep(3000)
        const st = await runCli(config, ['server', 'status'], 15000)
        if (st.data?.status === 'online') {
          return { ok: true, pid, url: 'http://127.0.0.1:' + config.comfyuiPort, status: st.data, ...(env.repaired === true ? { note: 'venv 已自动修复（pyvenv.cfg home 重指向）' } : {}) }
        }
      }
      // 超时诊断：读启动日志尾部（如果有）
      let logTail = ''
      try {
        const content = readFileSync(logPath, 'utf8')
        logTail = content.slice(-800).trim()
      } catch { /* 无日志 */ }
      return { ok: false, pid, error: '启动超时（300s 未就绪，冷启动可能仍需更久——进程未杀，稍后用 comfy_status 复查）；进程 pid=' + String(pid) + '，启动日志尾：' + (logTail || '（无日志——请检查 ' + config.comfyuiDir + ' 目录权限）') }
    },
  }))

  // ---------- comfy_stop：停止 ComfyUI 服务器（对称于 comfy_start） ----------
  ctx.tools.register(defineTool({
    name: 'comfy_stop',
    description: '停止 ComfyUI 服务器：按端口找到监听进程并 taskkill /F。需先 comfy_status 确认在线。',
    parameters: {},
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          pid: { type: 'number' },
          result: { type: 'json' },
          error: { type: 'string' },
        },
      },
      render: (_a: unknown, v: any) => [{ type: 'text', text: v.ok ? 'ComfyUI 已停止（pid ' + String(v.pid) + '）' : '停止失败：' + String(v.error ?? '').slice(0, 120) }],
    },
    async execute() {
      // 按端口找监听进程 PID（netstat 解析）
      const pid = await new Promise<number | undefined>((resolve) => {
        const child = spawn('netstat', ['-ano'], { windowsHide: true })
        let out = ''
        child.stdout.on('data', (d: Buffer) => { out += d.toString('utf8') })
        child.on('error', () => resolve(undefined))
        child.on('close', () => {
          const portStr = String(config.comfyuiPort)
          const match = out.split(/\r?\n/).find((line) => {
            const parts = line.trim().split(/\s+/)
            return parts.length >= 5 && parts[1] !== undefined && parts[1].endsWith(':' + portStr) && (parts[3] === 'LISTENING' || parts[3] === 'LISTEN')
          })
          if (match === undefined) { resolve(undefined); return }
          const pidPart = match.trim().split(/\s+/).pop()
          const n = pidPart !== undefined ? parseInt(pidPart, 10) : NaN
          resolve(Number.isFinite(n) && n > 0 ? n : undefined)
        })
      })
      if (pid === undefined) {
        return { ok: false, pid: undefined, result: null, error: '端口 ' + config.comfyuiPort + ' 无监听进程（服务器未运行？）' }
      }
      const killed = await new Promise<boolean>((resolve) => {
        const child = spawn('taskkill', ['/F', '/PID', String(pid)], { windowsHide: true })
        let err = ''
        child.stderr.on('data', (d: Buffer) => { err += d.toString('utf8') })
        child.on('error', () => resolve(false))
        child.on('close', (code) => { resolve(code === 0 || err.includes('successfully')) })
      })
      if (!killed) {
        return { ok: false, pid, result: null, error: 'taskkill 失败（pid=' + pid + '）——可能需要管理员权限' }
      }
      return { ok: true, pid, result: { pid, port: config.comfyuiPort, stopped: true } }
    },
  }))

  // ---------- comfy_workflows：工作流列表/详情 ----------
  ctx.tools.register(defineTool({
    name: 'comfy_workflows',
    description: '列出可用工作流（含参数 schema）或查看单个工作流详情。ID 格式 <server>/<workflow>（如 local/anima-v2-timeai-core）。',
    parameters: {
      id: { type: 'string', description: '工作流 ID（缺省=列出全部）' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          workflows: { type: 'json' },
          error: { type: 'string' },
        },
      },
      render: (_a: unknown, v: any) => [{ type: 'text', text: v.ok ? '工作流：' + JSON.stringify(v.workflows).slice(0, 120) : '查询失败：' + String(v.error ?? '').slice(0, 80) }],
    },
    async execute(args: { id?: string }) {
      const r = args.id !== undefined
        ? await runCli(config, ['info', args.id])
        : await runCli(config, ['list'])
      const err = cliError(r)
      if (err !== null) return { ok: false, workflows: null, error: err }
      // CLI list 对无 schema 的工作流返回 []——回退扫描 data/ 目录发现工作流（2026-08-19）
      // 同时发现两种格式：目录格式（data/<server>/<name>/workflow.json）和文件格式（data/*.json）
      // 只扫描 config.json 中声明的 server 目录，避免把工作流目录误认为 server 目录
      if (Array.isArray(r.data) && r.data.length === 0) {
        try {
          const { readdirSync, existsSync, readFileSync } = await import('node:fs')
          const { join } = await import('node:path')
          const base = join(config.workspaceDir, 'data')
          // 读 config.json 获取 server 列表
          let serverIds: Set<string> = new Set(['local'])
          let defaultServer = 'local'
          try {
            const cfg = JSON.parse(readFileSync(join(config.workspaceDir, 'config.json'), 'utf8')) as { servers?: { id: string }[]; default_server?: string }
            if (Array.isArray(cfg.servers)) serverIds = new Set(cfg.servers.map(s => s.id))
            if (cfg.default_server !== undefined) defaultServer = cfg.default_server
          } catch { /* 用默认 */ }
          const found: { workflow_id: string; server_id: string; enabled: boolean; format: string }[] = []
          if (existsSync(base)) {
            for (const entry of readdirSync(base, { withFileTypes: true })) {
              // 只扫描 config.json 中声明的 server 目录
              if (entry.isDirectory() && serverIds.has(entry.name)) {
                const serverDir = join(base, entry.name)
                for (const wf of readdirSync(serverDir, { withFileTypes: true })) {
                  // 目录格式：data/<server>/<name>/workflow.json
                  if (wf.isDirectory() && existsSync(join(serverDir, wf.name, 'workflow.json'))) {
                    found.push({ workflow_id: wf.name, server_id: entry.name, enabled: true, format: 'dir' })
                  }
                  // 文件格式：data/<server>/*.json
                  if (wf.isFile() && wf.name.endsWith('.json')) {
                    found.push({ workflow_id: wf.name.slice(0, -5), server_id: entry.name, enabled: true, format: 'file' })
                  }
                }
              }
              // 顶层文件格式：data/*.json（用 default_server）
              if (entry.isFile() && entry.name.endsWith('.json')) {
                found.push({ workflow_id: entry.name.slice(0, -5), server_id: defaultServer, enabled: true, format: 'file-top' })
              }
            }
          }
          if (found.length > 0) return { ok: true, workflows: found }
        } catch { /* 目录扫描失败则返回 CLI 结果 */ }
      }
      return { ok: true, workflows: r.data }
    },
  }))

  // ---------- comfy_submit：提交工作流（非阻塞） ----------
  ctx.tools.register(defineTool({
    name: 'comfy_submit',
    description: '提交工作流到 ComfyUI 队列（非阻塞，立即返回 prompt_id）。args 为工作流参数 JSON（如 {"prompt": "...", "seed": 123, "width": 920}）。用 comfy_task 查结果。',
    parameters: {
      id: { type: 'string', required: true, description: '工作流 ID（如 local/anima-v2-timeai-core）' },
      args: { type: 'string', description: '参数 JSON 字符串（缺省 = 工作流默认参数）' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          promptId: { type: 'string' },
          result: { type: 'json' },
          error: { type: 'string' },
        },
      },
      render: (_a: unknown, v: any) => [{ type: 'text', text: v.ok ? '已提交 ' + v.promptId : '提交失败：' + String(v.error ?? '').slice(0, 100) }],
    },
    async execute(args: { id: string; args?: string }) {
      const cliArgs = ['submit', args.id]
      if (args.args !== undefined && args.args.trim() !== '') cliArgs.push('--args=' + args.args.trim())
      const r = await runCli(config, cliArgs, 60000)
      const err = cliError(r)
      if (err !== null) return { ok: false, promptId: undefined, result: null, error: err }
      const data = r.data as { prompt_id?: string; id?: string } | null
      const promptId = data?.prompt_id ?? data?.id
      return { ok: promptId !== undefined, promptId, result: r.data, ...(promptId === undefined ? { error: '提交成功但无 prompt_id' } : {}) }
    },
  }))

  // ---------- comfy_run：执行工作流（阻塞轮询） ----------
  ctx.tools.register(defineTool({
    name: 'comfy_run',
    description: '执行工作流并等待完成（阻塞，最长 timeoutMs）。返回最终状态与输出结果。长任务建议用 comfy_submit + comfy_task 轮询。',
    parameters: {
      id: { type: 'string', required: true, description: '工作流 ID' },
      args: { type: 'string', description: '参数 JSON 字符串' },
      timeoutMs: { type: 'number', description: '等待超时（ms，缺省 120000）' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          result: { type: 'json' },
          error: { type: 'string' },
        },
      },
      render: (_a: unknown, v: any) => [{ type: 'text', text: v.ok ? '执行完成：' + JSON.stringify(v.result).slice(0, 120) : '执行失败：' + String(v.error ?? '').slice(0, 100) }],
    },
    async execute(args: { id: string; args?: string; timeoutMs?: number }) {
      const cliArgs = ['run', args.id]
      if (args.args !== undefined && args.args.trim() !== '') cliArgs.push('--args=' + args.args.trim())
      const r = await runCli(config, cliArgs, args.timeoutMs ?? config.timeoutMs)
      const err = cliError(r)
      if (err !== null) return { ok: false, result: null, error: err }
      return { ok: true, result: r.data }
    },
  }))

  // ---------- comfy_task：任务状态/取消/历史 ----------
  ctx.tools.register(defineTool({
    name: 'comfy_task',
    description: '任务管理：status=查询执行状态与输出（prompt_id）；cancel=取消任务；history=最近任务列表。',
    parameters: {
      action: { type: 'string', required: true, description: 'status | cancel | history' },
      promptId: { type: 'string', description: 'prompt_id（status/cancel 必填）' },
      workflowId: { type: 'string', description: 'history 时的工作流 ID（如 local/anima-v2-timeai-core）' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          result: { type: 'json' },
          error: { type: 'string' },
        },
      },
      render: (_a: unknown, v: any) => [{ type: 'text', text: v.ok ? '任务 ' + String(v.result?.status ?? '') + '：' + JSON.stringify(v.result).slice(0, 100) : '失败：' + String(v.error ?? '').slice(0, 80) }],
    },
    async execute(args: { action: string; promptId?: string; workflowId?: string }) {
      let cliArgs: string[] = []
      if (args.action === 'status') {
        if (args.promptId === undefined) return { ok: false, result: null, error: 'status 需要 promptId' }
        cliArgs = ['status', args.promptId]
      } else if (args.action === 'cancel') {
        if (args.promptId === undefined) return { ok: false, result: null, error: 'cancel 需要 promptId' }
        cliArgs = ['cancel', args.promptId]
      } else if (args.action === 'history') {
        if (args.workflowId === undefined) return { ok: false, result: null, error: 'history 需要 workflowId' }
        cliArgs = ['history', 'list', args.workflowId]
      } else {
        return { ok: false, result: null, error: 'action 须为 status|cancel|history' }
      }
      const r = await runCli(config, cliArgs, 60000)
      const err = cliError(r)
      if (err !== null) return { ok: false, result: null, error: err }
      return { ok: true, result: r.data }
    },
  }))

  // ---------- comfy_queue：队列管理 ----------
  ctx.tools.register(defineTool({
    name: 'comfy_queue',
    description: 'ComfyUI 队列：list=查看运行中/排队任务；clear=清空排队。',
    parameters: {
      action: { type: 'string', required: true, description: 'list | clear' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          result: { type: 'json' },
          error: { type: 'string' },
        },
      },
      render: (_a: unknown, v: any) => [{ type: 'text', text: v.ok ? '队列：' + JSON.stringify(v.result).slice(0, 120) : '失败：' + String(v.error ?? '').slice(0, 80) }],
    },
    async execute(args: { action: string }) {
      if (args.action !== 'list' && args.action !== 'clear') {
        return { ok: false, result: null, error: 'action 须为 list|clear' }
      }
      const r = await runCli(config, ['queue', args.action], 60000)
      const err = cliError(r)
      if (err !== null) return { ok: false, result: null, error: err }
      return { ok: true, result: r.data }
    },
  }))

  // ---------- comfy_models：模型列表 ----------
  ctx.tools.register(defineTool({
    name: 'comfy_models',
    description: 'ComfyUI 模型列表：不传 folder = 所有模型文件夹；传 folder（checkpoints/loras/vae/...）= 该文件夹模型。',
    parameters: {
      folder: { type: 'string', description: '模型文件夹（如 checkpoints、loras）' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          result: { type: 'json' },
          error: { type: 'string' },
        },
      },
      render: (_a: unknown, v: any) => [{ type: 'text', text: v.ok ? '模型：' + JSON.stringify(v.result).slice(0, 120) : '失败：' + String(v.error ?? '').slice(0, 80) }],
    },
    async execute(args: { folder?: string }) {
      const r = args.folder !== undefined
        ? await runCli(config, ['models', 'list', args.folder], 60000)
        : await runCli(config, ['models', 'list'], 60000)
      const err = cliError(r)
      if (err !== null) return { ok: false, result: null, error: err }
      return { ok: true, result: r.data }
    },
  }))

  // ---------- comfy_free：释放显存 ----------
  ctx.tools.register(defineTool({
    name: 'comfy_free',
    description: '释放 ComfyUI GPU 显存并卸载模型（长任务/换模型前调用，防 OOM）。',
    parameters: {},
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          result: { type: 'json' },
          error: { type: 'string' },
        },
      },
      render: (_a: unknown, v: any) => [{ type: 'text', text: v.ok ? '显存已释放' : '失败：' + String(v.error ?? '').slice(0, 80) }],
    },
    async execute() {
      const r = await runCli(config, ['free'], 60000)
      const err = cliError(r)
      if (err !== null) return { ok: false, result: null, error: err }
      return { ok: true, result: r.data }
    },
  }))

  // ---------- comfy_upload：上传文件到 ComfyUI ----------
  ctx.tools.register(defineTool({
    name: 'comfy_upload',
    description: '上传文件到 ComfyUI 服务器（图片/音频/视频等），用于工作流输入。可从本地路径上传，或用 --from-output 链接上一次工作流输出。需服务器在线。',
    parameters: {
      filePath: { type: 'string', required: true, description: '本地文件路径' },
      fromOutput: { type: 'string', description: '用上次工作流输出作为输入（prompt_id）' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          result: { type: 'json' },
          error: { type: 'string' },
        },
      },
      render: (_a: unknown, v: any) => [{ type: 'text', text: v.ok ? '已上传：' + JSON.stringify(v.result).slice(0, 120) : '上传失败：' + String(v.error ?? '').slice(0, 100) }],
    },
    async execute(args: { filePath: string; fromOutput?: string }) {
      const cliArgs = ['upload', args.filePath]
      if (args.fromOutput !== undefined && args.fromOutput.trim() !== '') cliArgs.push('--from-output=' + args.fromOutput.trim())
      const r = await runCli(config, cliArgs, 120000)
      const err = cliError(r)
      if (err !== null) return { ok: false, result: null, error: err }
      return { ok: true, result: r.data }
    },
  }))

  // ---------- comfy_templates：工作流模板 ----------
  ctx.tools.register(defineTool({
    name: 'comfy_templates',
    description: '发现 ComfyUI 工作流模板和子图：list=列出可用模板。需服务器在线。',
    parameters: {
      action: { type: 'string', description: 'list=列出模板（缺省）' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          result: { type: 'json' },
          error: { type: 'string' },
        },
      },
      render: (_a: unknown, v: any) => [{ type: 'text', text: v.ok ? '模板：' + JSON.stringify(v.result).slice(0, 120) : '失败：' + String(v.error ?? '').slice(0, 80) }],
    },
    async execute(args: { action?: string }) {
      const r = await runCli(config, ['templates', 'list'], 60000)
      const err = cliError(r)
      if (err !== null) return { ok: false, result: null, error: err }
      return { ok: true, result: r.data }
    },
  }))

  // ---------- comfy_nodes：节点发现 ----------
  ctx.tools.register(defineTool({
    name: 'comfy_nodes',
    description: '发现 ComfyUI 可用节点：list=列出所有节点类型及其输入参数。需服务器在线。',
    parameters: {
      action: { type: 'string', description: 'list=列出节点（缺省）' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          result: { type: 'json' },
          error: { type: 'string' },
        },
      },
      render: (_a: unknown, v: any) => [{ type: 'text', text: v.ok ? '节点：' + JSON.stringify(v.result).slice(0, 120) : '失败：' + String(v.error ?? '').slice(0, 80) }],
    },
    async execute(args: { action?: string }) {
      const r = await runCli(config, ['nodes', 'list'], 60000)
      const err = cliError(r)
      if (err !== null) return { ok: false, result: null, error: err }
      return { ok: true, result: r.data }
    },
  }))

  // ---------- comfy_logs：服务器日志 ----------
  ctx.tools.register(defineTool({
    name: 'comfy_logs',
    description: '查看 ComfyUI 服务器日志：show=显示最近的 ComfyUI 日志输出。需服务器在线。',
    parameters: {},
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          result: { type: 'json' },
          error: { type: 'string' },
        },
      },
      render: (_a: unknown, v: any) => [{ type: 'text', text: v.ok ? '日志：' + JSON.stringify(v.result).slice(0, 200) : '失败：' + String(v.error ?? '').slice(0, 80) }],
    },
    async execute() {
      const r = await runCli(config, ['logs', 'show'], 30000)
      const err = cliError(r)
      if (err !== null) return { ok: false, result: null, error: err }
      return { ok: true, result: r.data }
    },
  }))

  ctx.effect(() => {
    logger.info('ready（comfyui-skill 操控面：14 工具；workspace=' + config.workspaceDir + '；服务器离线时工具返回结构化错误）')
    return () => { /* 清理 */ }
  })
}
