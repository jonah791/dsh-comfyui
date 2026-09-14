/**
 * cli.ts — dsh-comfyui 纯逻辑层：CLI 参数拼装 / 入参校验 / 结果组装与错误分类。
 *
 * 无 IO、无时间依赖 —— 可离线单测（`tests/cli.test.mjs`，跑 lib 产物）。
 * 本文件由 `src/index.ts` 原样搬家（2026-09-14 可维护性补课：S3/S6），**行为不变**：
 * 每条函数都保留搬家前的判定顺序与边界（见各函数注释里的「真实语义」标注）。
 */

/** runCli 的结果形状（与搬家前 runCli 的 resolve 值逐字段一致）。 */
export interface CliResult {
  ok: boolean
  data: any
  raw: string
  stderr: string
}

/** CLI 参数计划：ok=false 时**不执行子进程**，直接把 error 交给工具应答。 */
export type CliPlan = { ok: true; cliArgs: string[] } | { ok: false; error: string }

/** runCli 的固定前缀：`--json --dir <workspaceDir>` + 子命令参数。 */
export function buildCliArgs(workspaceDir: string, args: readonly string[]): string[] {
  return ['--json', '--dir', workspaceDir, ...args]
}

/**
 * 值型选项：只判「有没有传」+「trim 后非空」，值一律 trim 后拼接。
 * 真实语义（搬家前如此，刻意保留）：{@link appendOption} **原地修改并返回同一数组**；
 * `''` 与纯空白串一律不加（避免 `--args=` 空值让 CLI 解析出空 JSON）。
 */
export function appendOption(cliArgs: string[], flag: string, raw?: string): string[] {
  if (raw !== undefined && raw.trim() !== '') cliArgs.push(flag + raw.trim())
  return cliArgs
}

/** `--args=<json>`（comfy_submit / comfy_run 共用）。 */
export function appendArgsOption(cliArgs: string[], raw?: string): string[] {
  return appendOption(cliArgs, '--args=', raw)
}

/** comfy_workflows：给了 id 走 `info <id>`，否则 `list`（判据是 `!== undefined`，空串仍走 info）。 */
export function planWorkflowsCliArgs(id?: string): string[] {
  return id !== undefined ? ['info', id] : ['list']
}

/** comfy_models：给了 folder 限定目录，否则列全部（`''` 也会被当作 folder 透传——边界如实保留）。 */
export function planModelsCliArgs(folder?: string): string[] {
  return folder !== undefined ? ['models', 'list', folder] : ['models', 'list']
}

/** comfy_queue：动作白名单 list|clear，其余**拒收**（不落到 CLI）。 */
export function planQueueCliArgs(action: string): CliPlan {
  if (action !== 'list' && action !== 'clear') return { ok: false, error: 'action 须为 list|clear' }
  return { ok: true, cliArgs: ['queue', action] }
}

/** comfy_task：status/cancel 需 promptId，history 需 workflowId；未知动作拒收。 */
export function planTaskCliArgs(action: string, promptId?: string, workflowId?: string): CliPlan {
  if (action === 'status') {
    if (promptId === undefined) return { ok: false, error: 'status 需要 promptId' }
    return { ok: true, cliArgs: ['status', promptId] }
  }
  if (action === 'cancel') {
    if (promptId === undefined) return { ok: false, error: 'cancel 需要 promptId' }
    return { ok: true, cliArgs: ['cancel', promptId] }
  }
  if (action === 'history') {
    if (workflowId === undefined) return { ok: false, error: 'history 需要 workflowId' }
    return { ok: true, cliArgs: ['history', 'list', workflowId] }
  }
  return { ok: false, error: 'action 须为 status|cancel|history' }
}

/**
 * 从 CLI 结果构建统一错误信息（成功 = null）。
 * 优先序：`data`（对象且含 `error`/`status` 键）→ `stderr` → `raw` → 固定兜底文案；一律截断 500 字符。
 * 真实语义：`data` 为数组/标量/无该二键时**不**序列化 data，直接回落 stderr（避免把正常输出当错误播报）。
 */
export function cliError(r: CliResult): string | null {
  if (r.ok) return null
  const d = r.data as { error?: string; status?: string } | null
  if (d !== null && typeof d === 'object' && (d.error !== undefined || d.status !== undefined)) {
    return JSON.stringify(d).slice(0, 500)
  }
  return (r.stderr || r.raw || 'comfyui-skill 执行失败').slice(0, 500)
}

/**
 * comfy_status：**只有「显式 withStats===true 且已在线」才需要第二次 `server stats` 调用**。
 * 真实语义：判据是 `=== true`（`'yes'`/`1` 等真值不触发）；statusData 为 null/非对象时不触发。
 */
export function needsStats(statusData: any, withStats?: boolean): boolean {
  return withStats === true && (statusData as { status?: string } | null)?.status === 'online'
}

export interface StatusOutput {
  ok: boolean
  status: any
  stats: any
  error?: string
}

/**
 * comfy_status 结果组装（纯）。
 *
 * 前置契约：`stats` **仅在** `needsStats(status.data, withStats)` 为真时由调用方执行并传入。
 * 违反前提（在线 + withStats 却传 null）会抛 TypeError —— 与搬家前 `stats.data` 的行为一致，
 * 是调用前置条件而非新缺陷（`tests/cli.test.mjs` 用一条边界测试把该契约钉住）。
 */
export function composeStatusResult(status: CliResult, stats: CliResult | null, withStats?: boolean): StatusOutput {
  const statusErr = cliError(status)
  const statusData = status.data as { status?: string } | null
  // 完全拿不到结果（data 为 null）→ 直接失败，不谎报 status
  if (statusErr !== null && status.data === null) {
    return { ok: false, status: null, stats: null, error: statusErr }
  }
  if (needsStats(status.data, withStats)) {
    const statsErr = cliError(stats as CliResult)
    const statsData = (stats as CliResult).data
    return statsErr === null
      ? { ok: true, status: status.data, stats: statsData }
      : { ok: false, status: status.data, stats: statsData, error: statsErr }
  }
  // 未取 stats：ok 只看 status.data.status；statusErr 非空但 data 可用时**保留原始 data 并附 error**
  return {
    ok: statusData?.status === 'online',
    status: status.data,
    stats: null,
    ...(statusErr !== null ? { error: statusErr } : {}),
  }
}

export interface SubmitOutput {
  ok: boolean
  promptId?: string
  result: any
  error?: string
}

/**
 * comfy_submit 结果组装（纯）：CLI 成功后取 `data.prompt_id`，缺失则回退 `data.id`。
 * 真实语义：判据是 `!== undefined`（`prompt_id: ''` 也算成功）；拿不到 id 时 ok=false 但**保留原始 result**
 * （便于上层看见 CLI 到底回了什么）。
 */
export function composeSubmitResult(r: CliResult): SubmitOutput {
  const err = cliError(r)
  if (err !== null) return { ok: false, promptId: undefined, result: null, error: err }
  const data = r.data as { prompt_id?: string; id?: string } | null
  const promptId = data?.prompt_id ?? data?.id
  return {
    ok: promptId !== undefined,
    promptId,
    result: r.data,
    ...(promptId === undefined ? { error: '提交成功但无 prompt_id' } : {}),
  }
}
