/**
 * workflows.ts — `comfy_workflows` 的空列表回退扫描：config.json 解析 + data/ 树分类（纯逻辑）。
 *
 * 无 IO：IO 侧（`readdirSync` / `existsSync`）留在 `src/index.ts` 闭包，把目录树**规范化**后传进来。
 * 由 `src/index.ts` 原样搬家（2026-09-14 可维护性补课：S3/S6），行为不变——含两种落盘格式的
 * 判定顺序（同一子项先判目录格式、再判文件格式）与「未声明的 server 目录一律不看」的过滤。
 */

export type FsKind = 'dir' | 'file' | 'other'

/** data/<server>/ 下的一项（IO 层规范化） */
export interface ScanChild {
  name: string
  kind: FsKind
  /** 仅当 kind==='dir' 时由 IO 层探测：`<server>/<name>/workflow.json` 是否存在 */
  hasWorkflowJson?: boolean
}

/** data/ 下的一项（IO 层规范化） */
export interface ScanEntry {
  name: string
  kind: FsKind
  /** 仅当 kind==='dir' 且该目录名在 serverIds 内时由 IO 层填充 */
  children?: ScanChild[]
}

export interface WorkflowEntry {
  workflow_id: string
  server_id: string
  enabled: boolean
  format: 'dir' | 'file' | 'file-top'
}

/**
 * 解析 workspace 的 `config.json` 文本 → `{ serverIds, defaultServer }`。
 *
 * 退化一律回落默认（`serverIds={'local'}` / `defaultServer='local'`），**不抛**：
 * - 坏 JSON / 空文本 / `'null'`（`cfg.servers` 取值即抛 → catch）→ 默认
 * - `'3'` / `'[]'` 等无 `servers` 键的合法 JSON → 属性缺失，同样落到默认
 * - 真实语义（刻意保留）：`servers` 是数组时**完全替换**默认集（空数组 ⇒ 空集，不是「加 local」）；
 *   条目缺 `id` ⇒ Set 里出现 `undefined`；`default_server` 用 `!== undefined` 判定（`null` 会被采纳）。
 */
export function parseWorkspaceConfig(cfgText: string): { serverIds: Set<string>; defaultServer: string } {
  let serverIds: Set<string> = new Set(['local'])
  let defaultServer = 'local'
  try {
    const cfg = JSON.parse(cfgText) as { servers?: { id: string }[]; default_server?: string }
    if (Array.isArray(cfg.servers)) serverIds = new Set(cfg.servers.map((s) => s.id))
    if (cfg.default_server !== undefined) defaultServer = cfg.default_server
  } catch {
    /* 用默认 */
  }
  return { serverIds, defaultServer }
}

/**
 * data/ 树 → 工作流条目（保持 IO 层给定的顺序）。
 *
 * 三种格式（与 CLI `list` 空数组回退路径一致）：
 * - `dir`：`data/<server>/<name>/workflow.json` ⇒ id=`<name>`
 * - `file`：`data/<server>/<name>.json` ⇒ id=`<name>`（去 `.json`）
 * - `file-top`：`data/<name>.json` ⇒ id=`<name>`，server 取 `defaultServer`
 *
 * 真实语义（刻意保留）：只在 `serverIds` 内声明的目录里扫；`.json` 判据**大小写敏感**；
 * `kind==='dir'` 但 `hasWorkflowJson !== true` 的目录不计入（探针结果缺失即不认）。
 */
export function discoverWorkflows(
  entries: readonly ScanEntry[],
  serverIds: ReadonlySet<string>,
  defaultServer: string,
): WorkflowEntry[] {
  const found: WorkflowEntry[] = []
  for (const entry of entries) {
    if (entry.kind === 'dir' && serverIds.has(entry.name)) {
      for (const wf of entry.children ?? []) {
        // 目录格式：data/<server>/<name>/workflow.json
        if (wf.kind === 'dir' && wf.hasWorkflowJson === true) {
          found.push({ workflow_id: wf.name, server_id: entry.name, enabled: true, format: 'dir' })
        }
        // 文件格式：data/<server>/*.json
        if (wf.kind === 'file' && wf.name.endsWith('.json')) {
          found.push({ workflow_id: wf.name.slice(0, -5), server_id: entry.name, enabled: true, format: 'file' })
        }
      }
    }
    // 顶层文件格式：data/*.json（用 default_server）
    if (entry.kind === 'file' && entry.name.endsWith('.json')) {
      found.push({ workflow_id: entry.name.slice(0, -5), server_id: defaultServer, enabled: true, format: 'file-top' })
    }
  }
  return found
}
