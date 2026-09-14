/**
 * cli.ts 纯函数套件（离线、零 IO）。
 * 覆盖：正常路径 + 失败/退化路径（缺参、非法动作、空串、脏 data、超长截断、边界门控）——后者是 S6 判据。
 * 跑 lib 产物（与运行时同源）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildCliArgs, appendOption, appendArgsOption, cliError,
  planWorkflowsCliArgs, planModelsCliArgs, planQueueCliArgs, planTaskCliArgs,
  needsStats, composeStatusResult, composeSubmitResult,
} from '../lib/cli.js'

// ---------- 参数拼装 ----------

test('buildCliArgs: 固定前缀 --json --dir <workspace> + 子命令', () => {
  assert.deepEqual(buildCliArgs('E:/ws', ['server', 'status']), ['--json', '--dir', 'E:/ws', 'server', 'status'])
})

test('buildCliArgs: 退化输入——空参数数组 / 参数含空串（不校验，原样透传交给 CLI）', () => {
  assert.deepEqual(buildCliArgs('E:/ws', []), ['--json', '--dir', 'E:/ws'])
  assert.deepEqual(buildCliArgs('', ['']), ['--json', '--dir', '', ''])
})

test('appendOption: 有值才追加，值 trim 后拼接', () => {
  assert.deepEqual(appendArgsOption(['submit', 'local/wf'], '{"seed":1}'), ['submit', 'local/wf', '--args={"seed":1}'])
  assert.deepEqual(appendArgsOption(['submit', 'w'], '  {"seed":1}  '), ['submit', 'w', '--args={"seed":1}'])
})

test('appendOption: 退化输入——undefined / 空串 / 纯空白一律不加', () => {
  assert.deepEqual(appendArgsOption(['submit', 'w'], undefined), ['submit', 'w'])
  assert.deepEqual(appendArgsOption(['submit', 'w'], ''), ['submit', 'w'])
  assert.deepEqual(appendArgsOption(['submit', 'w'], '   \t\n '), ['submit', 'w'])
  assert.deepEqual(appendOption(['upload', 'a.png'], '--from-output=', undefined), ['upload', 'a.png'])
})

test('appendOption: 真实语义——原地修改并返回同一数组（调用方依赖返回值，不复制）', () => {
  const arr = ['upload', 'a.png']
  const out = appendOption(arr, '--from-output=', 'p-123')
  assert.equal(out, arr)
  assert.deepEqual(out, ['upload', 'a.png', '--from-output=p-123'])
})

// ---------- 子命令计划（入参校验） ----------

test('planWorkflowsCliArgs: 有 id 走 info，无 id 走 list', () => {
  assert.deepEqual(planWorkflowsCliArgs('local/anima-v2'), ['info', 'local/anima-v2'])
  assert.deepEqual(planWorkflowsCliArgs(), ['list'])
})

test('planWorkflowsCliArgs: 边界——空串仍走 info（判据是 !== undefined，不是真值）', () => {
  assert.deepEqual(planWorkflowsCliArgs(''), ['info', ''])
})

test('planModelsCliArgs: 有 folder 限定目录，无则列全部', () => {
  assert.deepEqual(planModelsCliArgs('loras'), ['models', 'list', 'loras'])
  assert.deepEqual(planModelsCliArgs(), ['models', 'list'])
})

test('planModelsCliArgs: 边界——空串被当作 folder 透传（真实语义，如实记录）', () => {
  assert.deepEqual(planModelsCliArgs(''), ['models', 'list', ''])
})

test('planQueueCliArgs: list/clear 通过，非法动作拒收（不落到 CLI）', () => {
  assert.deepEqual(planQueueCliArgs('list'), { ok: true, cliArgs: ['queue', 'list'] })
  assert.deepEqual(planQueueCliArgs('clear'), { ok: true, cliArgs: ['queue', 'clear'] })
  for (const bad of ['LIST', 'clearAll', '', ' ', 'list; rm']) {
    const p = planQueueCliArgs(bad)
    assert.equal(p.ok, false, `'${bad}' 必须被拒收`)
    assert.equal(p.error, 'action 须为 list|clear')
  }
})

test('planTaskCliArgs: status/cancel/history 正常路径', () => {
  assert.deepEqual(planTaskCliArgs('status', 'p-1'), { ok: true, cliArgs: ['status', 'p-1'] })
  assert.deepEqual(planTaskCliArgs('cancel', 'p-1'), { ok: true, cliArgs: ['cancel', 'p-1'] })
  assert.deepEqual(planTaskCliArgs('history', undefined, 'local/wf'), { ok: true, cliArgs: ['history', 'list', 'local/wf'] })
})

test('planTaskCliArgs: 失败路径——缺参逐个拒收并给出对应文案', () => {
  assert.deepEqual(planTaskCliArgs('status'), { ok: false, error: 'status 需要 promptId' })
  assert.deepEqual(planTaskCliArgs('cancel'), { ok: false, error: 'cancel 需要 promptId' })
  assert.deepEqual(planTaskCliArgs('history'), { ok: false, error: 'history 需要 workflowId' })
})

test('planTaskCliArgs: 失败路径——未知/空动作拒收（不给默认分支蒙混过关）', () => {
  for (const bad of ['', 'Status', 'delete', 'list', '  status  ']) {
    assert.deepEqual(planTaskCliArgs(bad, 'p-1', 'local/wf'), { ok: false, error: 'action 须为 status|cancel|history' })
  }
})

// ---------- 错误分类 ----------

test('cliError: 成功返回 null（哪怕 stderr 有内容）', () => {
  assert.equal(cliError({ ok: true, data: { status: 'online' }, raw: '{}', stderr: 'warn' }), null)
})

test('cliError: 失败时优先序列化 data（含 error 或 status 键）', () => {
  assert.equal(cliError({ ok: false, data: { error: 'boom' }, raw: 'x', stderr: 'y' }), '{"error":"boom"}')
  assert.equal(cliError({ ok: false, data: { status: 'offline', detail: 1 }, raw: '', stderr: '' }), '{"status":"offline","detail":1}')
})

test('cliError: 退化 data——空对象/数组/标量都不当作错误载荷，回落 stderr → raw → 兜底文案', () => {
  assert.equal(cliError({ ok: false, data: {}, raw: 'RAW', stderr: 'ERR' }), 'ERR')
  assert.equal(cliError({ ok: false, data: [], raw: 'RAW', stderr: 'ERR' }), 'ERR')
  assert.equal(cliError({ ok: false, data: 42, raw: 'RAW', stderr: '' }), 'RAW')
  assert.equal(cliError({ ok: false, data: null, raw: '', stderr: '   ' }), '   ')
  assert.equal(cliError({ ok: false, data: null, raw: '', stderr: '' }), 'comfyui-skill 执行失败')
})

test('cliError: 边界——错误文案截断到 500 字符（不把整段日志灌进上下文）', () => {
  const long = { error: 'x'.repeat(600) }
  assert.equal(cliError({ ok: false, data: long, raw: '', stderr: '' }).length, 500)
  assert.equal(cliError({ ok: false, data: null, raw: 'y'.repeat(900), stderr: '' }).length, 500)
})

test('cliError: 幂等——同输入重复调用结果一致（纯函数，无记忆）', () => {
  const r = { ok: false, data: { status: 'offline' }, raw: '', stderr: '' }
  assert.equal(cliError(r), cliError(r))
  assert.deepEqual(r, { ok: false, data: { status: 'offline' }, raw: '', stderr: '' })
})

// ---------- comfy_status 组装 ----------

test('needsStats: 只有「显式 true 且在线」才需要第二次 server stats', () => {
  assert.equal(needsStats({ status: 'online' }, true), true)
  assert.equal(needsStats({ status: 'online' }, false), false)
  assert.equal(needsStats({ status: 'online' }, undefined), false)
  assert.equal(needsStats({ status: 'online' }, 'yes'), false) // 非严格 true 不触发（真实语义）
  assert.equal(needsStats({ status: 'offline' }, true), false)
  assert.equal(needsStats(null, true), false) // 退化：data 为 null
  assert.equal(needsStats(undefined, true), false)
})

test('composeStatusResult: 在线 → ok:true，未取 stats 时 stats 为 null', () => {
  const out = composeStatusResult({ ok: true, data: { status: 'online' }, raw: '', stderr: '' }, null, false)
  assert.deepEqual(out, { ok: true, status: { status: 'online' }, stats: null })
})

test('composeStatusResult: 离线 → ok:false，但保留 CLI 原始 status（不谎报）', () => {
  const out = composeStatusResult({ ok: true, data: { status: 'offline' }, raw: '', stderr: '' }, null, false)
  assert.deepEqual(out, { ok: false, status: { status: 'offline' }, stats: null })
})

test('composeStatusResult: 失败路径——CLI 失败且 data 为 null → status/stats 双 null + error', () => {
  const out = composeStatusResult({ ok: false, data: null, raw: '', stderr: 'ENOENT: comfyui-skill 未找到' }, null, false)
  assert.deepEqual(out, { ok: false, status: null, stats: null, error: 'ENOENT: comfyui-skill 未找到' })
})

test('composeStatusResult: 失败路径——CLI 失败但 data 可用 → 保留 data 并附 error', () => {
  const out = composeStatusResult({ ok: false, data: { status: 'offline', error: 'conn refused' }, raw: '', stderr: '' }, null, false)
  assert.deepEqual(out, { ok: false, status: { status: 'offline', error: 'conn refused' }, stats: null, error: '{"status":"offline","error":"conn refused"}' })
})

test('composeStatusResult: withStats 在线且 stats 成功 → ok:true + stats 就位', () => {
  const status = { ok: true, data: { status: 'online' }, raw: '', stderr: '' }
  const stats = { ok: true, data: { vram: { used: 1 } }, raw: '', stderr: '' }
  assert.deepEqual(composeStatusResult(status, stats, true), { ok: true, status: { status: 'online' }, stats: { vram: { used: 1 } } })
})

test('composeStatusResult: 失败路径——stats 失败则整体 ok:false，但 stats 数据仍保留（可诊断）', () => {
  const status = { ok: true, data: { status: 'online' }, raw: '', stderr: '' }
  const stats = { ok: false, data: { error: 'stats boom' }, raw: '', stderr: '' }
  const out = composeStatusResult(status, stats, true)
  assert.equal(out.ok, false)
  assert.deepEqual(out.stats, { error: 'stats boom' })
  assert.equal(out.error, '{"error":"stats boom"}')
})

test('composeStatusResult: 边界——needsStats 门控被违反（在线 + withStats 但 stats=null）不静默，直接抛 TypeError', () => {
  const status = { ok: true, data: { status: 'online' }, raw: '', stderr: '' }
  assert.equal(needsStats(status.data, true), true) // 前提：此时调用方必须已执行 stats
  assert.throws(() => composeStatusResult(status, null, true), TypeError)
})

// ---------- comfy_submit 组装 ----------

test('composeSubmitResult: 正常路径——取 prompt_id', () => {
  const out = composeSubmitResult({ ok: true, data: { prompt_id: 'p-1', number: 3 }, raw: '', stderr: '' })
  assert.equal(out.ok, true)
  assert.equal(out.promptId, 'p-1')
  assert.deepEqual(out.result, { prompt_id: 'p-1', number: 3 })
})

test('composeSubmitResult: 回退路径——无 prompt_id 时取 id', () => {
  const out = composeSubmitResult({ ok: true, data: { id: 'uuid-9' }, raw: '', stderr: '' })
  assert.equal(out.ok, true)
  assert.equal(out.promptId, 'uuid-9')
})

test('composeSubmitResult: 失败路径——CLI 失败 → result 置 null + error，不给假 promptId', () => {
  const out = composeSubmitResult({ ok: false, data: null, raw: 'trace', stderr: '' })
  assert.equal(out.ok, false)
  assert.equal(out.promptId, undefined)
  assert.equal(out.result, null)
  assert.equal(out.error, 'trace')
})

test('composeSubmitResult: 退化路径——成功但无任何 id → ok:false 但保留 result（看得见 CLI 回了什么）', () => {
  const out = composeSubmitResult({ ok: true, data: { queued: true }, raw: '', stderr: '' })
  assert.equal(out.ok, false)
  assert.equal(out.promptId, undefined)
  assert.equal(out.error, '提交成功但无 prompt_id')
  assert.deepEqual(out.result, { queued: true })
})

test('composeSubmitResult: 边界——prompt_id 为 null 回落 id；为空串则算成功（?? 不回落）', () => {
  assert.equal(composeSubmitResult({ ok: true, data: { prompt_id: null, id: 'fallback' }, raw: '', stderr: '' }).promptId, 'fallback')
  const empty = composeSubmitResult({ ok: true, data: { prompt_id: '' }, raw: '', stderr: '' })
  assert.equal(empty.ok, true)
  assert.equal(empty.promptId, '')
  assert.equal(composeSubmitResult({ ok: true, data: null, raw: '', stderr: '' }).ok, false)
})
