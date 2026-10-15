/**
 * Anima 通用提交：UI 格式工作流 → API 格式 prompt 图 → POST /prompt
 *
 * 为什么不走 comfyui-skill CLI 的 submit：時雨流工作流没有 schema.json
 * （comfy_workflows 返回 parameters={}），CLI 通道注入不了参数。
 *
 * 为什么一律从工作流自取参数：2026-09-30 实测，主人 09-02 瘦身删掉
 * miaomiaoHarem_anima15 / anima8Step10 之后，workspace 里的 submit_core.py /
 * submit_api.py / submit_sos_*.py **全部静默失效**（写死已删模型名），
 * submit_pornmaster_basic.py 还指向废弃路径 E:\alice\交接。
 * ⇒ 硬编码模型名 = 脚本必然腐化。本模块只覆盖 spec 显式给到的字段。
 */

/** 前端专用/纯装饰节点：无 API 语义 */
export const SKIP_TYPES = [
  'Note', 'MarkdownNote', 'Fast Groups Bypasser (rgthree)', 'Label (rgthree)',
  'PlaySound|pysssss', 'MaskPreview+', 'Image Comparer', 'Float To Number',
  'easy globalSeed',
]

/** 纯值节点：widgets_values[0] 即 value（時雨流 701 = turbo 开关） */
export const PRIMITIVE_TYPES = [
  'PrimitiveBoolean', 'PrimitiveInt', 'PrimitiveFloat', 'PrimitiveString',
  'PrimitiveStringMultiline',
]

export interface AnimaSpec {
  positive: string
  negative?: string
  /** 覆盖基模（缺省用工作流自身值） */
  unet?: string
  width?: number
  height?: number
  steps?: number
  cfg?: number
  sampler?: string
  scheduler?: string
  seed?: number
  prefix?: string
  /** 覆盖常驻 LoRA 链：{ lora: 文件名, strength?: 0-1 }[] */
  loras?: Array<{ lora: string; strength?: number }>
}

export interface BuildInfo {
  nodes: number
  unet: string | null
  posNode: string | null
  negNode: string | null
  loras: string[]
}

export interface BuiltApi {
  api: Record<string, { class_type: string; inputs: Record<string, unknown> }>
  info: BuildInfo
}

interface WfNode {
  id: number | string
  type: string
  title?: string
  mode?: number
  inputs?: Array<{ name: string; link?: number | null; widget?: unknown }>
  widgets_values?: unknown[]
}

interface WfLink { 0: number; 1: number; 2: number }

/**
 * 在工作流 JSON 上就地写入常驻 LoRA 链（rgthree Power Lora Loader）。
 * 必须在 buildApi 之前调用——widgets_values 是 API 通道的唯一入口。
 */
export function applyLoraOverride(wf: { nodes: WfNode[] }, loras: NonNullable<AnimaSpec['loras']>): string[] {
  for (const n of wf.nodes) {
    if (n.type !== 'Power Lora Loader (rgthree)' || (n.mode ?? 0) !== 0) { continue }
    const wv = Array.isArray(n.widgets_values) ? n.widgets_values : []
    const head = wv.filter((x) => !(typeof x === 'object' && x !== null && 'lora' in (x as object)))
    const body = loras.map((it) => ({ on: true, lora: it.lora, strength: it.strength ?? 0.8 }))
    n.widgets_values = [...head, ...body]
    return loras.map((it) => it.lora)
  }
  return []
}

/** UI 格式 workflow → API 格式 prompt 图 */
export function buildApiFromWorkflow(wf: { nodes: WfNode[]; links: WfLink[] }, spec: AnimaSpec): BuiltApi {
  const linkById = new Map<number, WfLink>()
  for (const l of wf.links ?? []) { linkById.set(l[0], l) }

  const api: BuiltApi['api'] = {}
  const info: BuildInfo = { nodes: 0, unet: null, posNode: null, negNode: null, loras: [] }

  for (const n of wf.nodes) {
    const nid = String(n.id)
    const ct = n.type
    if ((n.mode ?? 0) !== 0) { continue }
    if (SKIP_TYPES.some((s) => ct.includes(s))) { continue }

    const inputs: Record<string, unknown> = {}
    const wv = Array.isArray(n.widgets_values) ? n.widgets_values : []

    // ① 链接输入
    for (const idef of n.inputs ?? []) {
      if (idef.link === null || idef.link === undefined) { continue }
      const src = linkById.get(idef.link)
      if (src) { inputs[idef.name] = [String(src[1]), src[2]] }
    }

    // ② 关键节点的 widget → inputs 显式映射（值全部取自工作流自身）
    switch (ct) {
      case 'UNETLoader': {
        const name = spec.unet ?? (typeof wv[0] === 'string' ? wv[0] : null)
        inputs.unet_name = name
        inputs.weight_dtype = wv[1] ?? 'default'
        info.unet = name
        break
      }
      case 'CLIPLoader':
        inputs.clip_name = wv[0]
        inputs.type = wv[1] ?? 'stable_diffusion'
        inputs.device = wv[2] ?? 'default'
        break
      case 'VAELoader':
        inputs.vae_name = wv[0]
        break
      case 'KSampler':
        inputs.seed = spec.seed ?? Math.floor(Math.random() * 4294967296)
        inputs.steps = spec.steps ?? wv[2] ?? 12
        inputs.cfg = spec.cfg ?? wv[3] ?? 1.0
        inputs.sampler_name = spec.sampler ?? wv[4] ?? 'euler'
        inputs.scheduler = spec.scheduler ?? wv[5] ?? 'beta57'
        inputs.denoise = 1.0
        break
      case 'EmptyLatentImage':
        inputs.width = spec.width ?? wv[0] ?? 1024
        inputs.height = spec.height ?? wv[1] ?? 1536
        inputs.batch_size = 1
        break
      case 'CLIPTextEncode': {
        const title = n.title ?? ''
        if (title.includes('Positive')) {
          inputs.text = spec.positive
          info.posNode = nid
        } else if (title.includes('Negative')) {
          inputs.text = spec.negative ?? wv[0] ?? ''
          info.negNode = nid
        } else {
          inputs.text = wv[0] ?? ''
        }
        break
      }
      case 'LoraLoaderModelOnly':
        inputs.lora_name = wv[0] ?? ''
        inputs.strength_model = wv[1] ?? 1.0
        break
      case 'SaveImage':
        inputs.filename_prefix = spec.prefix ?? 'alice/anima'
        break
      default:
        if (PRIMITIVE_TYPES.includes(ct)) { inputs.value = wv[0] ?? null }
        break
    }

    api[nid] = { class_type: ct, inputs }
    info.nodes += 1
  }

  return { api, info }
}

/** POST /prompt；返回原始响应（成功含 prompt_id，失败含 node_errors） */
export async function submitPrompt(
  port: number,
  api: BuiltApi['api'],
  timeoutMs = 30000,
): Promise<Record<string, unknown>> {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeoutMs)
  try {
    const res = await fetch('http://127.0.0.1:' + port + '/prompt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: api }),
      signal: ac.signal,
    })
    return (await res.json()) as Record<string, unknown>
  } catch (err) {
    return { error: { type: 'transport', message: String(err) } }
  } finally {
    clearTimeout(timer)
  }
}

/** 从 ComfyUI 的失败响应里抽出可读的节点错误摘要 */
export function describeSubmitFailure(res: Record<string, unknown>): string {
  const nodeErrors = res.node_errors as Record<string, unknown> | undefined
  if (nodeErrors) {
    const parts: string[] = []
    for (const [nid, ne] of Object.entries(nodeErrors)) {
      const errs = (ne as { errors?: Array<{ message?: string; details?: string; extra_info?: { input_name?: string } }> }).errors ?? []
      for (const e of errs) {
        const inp = e.extra_info?.input_name ?? ''
        parts.push('node ' + nid + (inp ? '[' + inp + ']' : '') + ' ' + String(e.message ?? '') + ' ' + String(e.details ?? ''))
      }
    }
    if (parts.length > 0) { return parts.join(' | ').slice(0, 400) }
  }
  const e = res.error as { type?: string; message?: string } | undefined
  return String(e?.message ?? JSON.stringify(res)).slice(0, 400)
}

/** 从工作流里读出 rgthree PowerLora 的 LoRA 条目（API 通道拿不到它们，必须自己取） */
export function readPowerLoraEntries(wf: { nodes: WfNode[] }): Array<{ lora: string; strength?: number }> {
  for (const n of wf.nodes) {
    if (n.type !== 'Power Lora Loader (rgthree)' || (n.mode ?? 0) !== 0) { continue }
    const wv = Array.isArray(n.widgets_values) ? n.widgets_values : []
    const out: Array<{ lora: string; strength?: number }> = []
    for (const item of wv) {
      if (typeof item !== 'object' || item === null) { continue }
      const rec = item as { on?: unknown; lora?: unknown; strength?: unknown }
      const name = typeof rec.lora === 'string' ? rec.lora.trim() : ''
      if (name === '' || rec.on === false) { continue }
      out.push({ lora: name, strength: typeof rec.strength === 'number' ? rec.strength : 0.8 })
    }
    return out
  }
  return []
}

/**
 * 把 API 图里的 PowerLora 节点换成标准 LoraLoaderModelOnly 串链。
 *
 * 为什么必须换：rgthree Power Lora Loader 的 INPUT_TYPES 只有 optional {model, clip}，
 * lora 条目纯属前端 widget 状态 ⇒ **经 API 提交静默不挂、不报错**（2026-09-30 由 PNG
 * 元数据实测确证：常驻三条品质 LoRA 全部缺席，图仍照常出）。标准 LoraLoaderModelOnly
 * 的 required inputs 是 model/lora_name/strength_model，API 认得。
 *
 * 返回 wired = 被重定向的下游引用数（0 表示这条链没接上，值得警觉）。
 */
export function chainLorasInApi(
  api: Record<string, { class_type: string; inputs: Record<string, unknown> }>,
  entries: Array<{ lora: string; strength?: number }>,
): { wired: number; chain: string[] } {
  if (entries.length === 0) { return { wired: 0, chain: [] } }
  const target = Object.entries(api).find(([, n]) => n.class_type === 'Power Lora Loader (rgthree)')
  if (!target) { return { wired: 0, chain: [] } }
  const [pid, pnode] = target
  const upstream = pnode.inputs.model
  if (!Array.isArray(upstream) || upstream.length < 2) { return { wired: 0, chain: [] } }

  let prev: unknown[] = [String(upstream[0]), Number(upstream[1])]
  let seq = 9001
  const chain: string[] = []
  for (const it of entries) {
    const nid = String(seq++)
    api[nid] = {
      class_type: 'LoraLoaderModelOnly',
      inputs: { model: prev, lora_name: it.lora, strength_model: it.strength ?? 0.8 },
    }
    prev = [nid, 0]
    chain.push(nid)
  }

  let wired = 0
  for (const n of Object.values(api)) {
    for (const [k, v] of Object.entries(n.inputs)) {
      if (Array.isArray(v) && v.length >= 1 && String(v[0]) === pid) {
        n.inputs[k] = prev
        wired += 1
      }
    }
  }
  delete api[pid]
  return { wired, chain }
}
