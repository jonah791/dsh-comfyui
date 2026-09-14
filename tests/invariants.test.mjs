/**
 * 静态不变量守卫（本插件自己的不变量，不是照抄别的插件）。
 *
 * 守卫对象来自 docs/semantic.md §3 的不变量 + §7 验收：
 *   I1 一律走 CLI（src 内不得直接触网）
 *   I3 工具面恰好 14 个 comfy_*
 *   I4 comfy_start 必有落盘启动日志
 *   纯逻辑层必须真的被 index.ts 使用（防接线回退）
 *
 * 每条守卫都先喂**已知坏样本**证明检测器会命中（尸体测试）——否则「真源码零命中」毫无意义。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

function listTs(dir) {
  const out = []
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, ent.name)
    if (ent.isDirectory()) out.push(...listTs(p))
    else if (ent.name.endsWith('.ts')) out.push(p)
  }
  return out
}

const srcFiles = listTs(join(root, 'src'))
const srcText = srcFiles.map((f) => readFileSync(f, 'utf8')).join('\n')
const indexSrc = readFileSync(join(root, 'src', 'index.ts'), 'utf8')

/** 直接触网的写法（本插件唯一允许的出口是 comfyui-skill CLI 子进程）。 */
function findNetworkCalls(text) {
  const hits = []
  text.split('\n').forEach((line, i) => {
    if (/^\s*(\/\/|\*|\/\*)/.test(line)) return // 注释/文档行不算
    if (/\bfetch\s*\(|XMLHttpRequest|axios|\bhttps?\.request\s*\(|from\s+['"]node:https?['"]|require\(['"]node:https?['"]\)|new\s+WebSocket\s*\(/.test(line)) {
      hits.push(i + 1)
    }
  })
  return hits
}

function extractToolNames(text) {
  return [...text.matchAll(/name:\s*'(comfy_[a-z_]+)'/g)].map((m) => m[1])
}

test('前提：本包为 ESM + NodeNext（IO 层静态导入语义成立）', () => {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  assert.equal(pkg.type, 'module')
  assert.match(readFileSync(join(root, 'tsconfig.json'), 'utf8'), /"module"\s*:\s*"NodeNext"/)
})

test('I1: src 内不得直接触网（检测器先过尸体样本，再看真源码）', () => {
  // —— 尸体样本：已知坏写法必须被检测器命中，否则下面的「零命中」是假绿
  assert.deepEqual(findNetworkCalls("const r = await fetch('http://127.0.0.1:8300/prompt')"), [1])
  assert.deepEqual(findNetworkCalls("import http from 'node:http'"), [1])
  assert.deepEqual(findNetworkCalls("const ws = new WebSocket('ws://127.0.0.1:8300/ws')"), [1])
  assert.deepEqual(findNetworkCalls('// await fetch(\'x\')'), [], '注释行不该命中')
  // —— 真源码
  const offenders = []
  for (const f of srcFiles) {
    for (const line of findNetworkCalls(readFileSync(f, 'utf8'))) offenders.push(`${relative(root, f)}:${line}`)
  }
  assert.deepEqual(offenders, [], `src 出现直接触网（违反 I1「一律走 CLI」）：\n${offenders.join('\n')}`)
})

test('I3: 工具面恰好 14 个 comfy_*（检测器先过尸体样本）', () => {
  assert.deepEqual(extractToolNames("defineTool({ name: 'comfy_x', description: 'd' })"), ['comfy_x'])
  assert.deepEqual(extractToolNames("export const name = 'agent-comfyui'"), [], '插件自身 name 不算工具')
  const names = extractToolNames(indexSrc)
  assert.deepEqual(names.slice().sort(), [
    'comfy_free', 'comfy_logs', 'comfy_models', 'comfy_nodes', 'comfy_queue', 'comfy_run', 'comfy_start',
    'comfy_status', 'comfy_stop', 'comfy_submit', 'comfy_task', 'comfy_templates', 'comfy_upload', 'comfy_workflows',
  ])
})

test('I4: comfy_start 的启动日志落点必须在源码里（唯一不依赖内存的物证）', () => {
  assert.match(indexSrc, /\.dsh-comfyui-startup\.log/)
  assert.match(indexSrc, /openSync\(logPath,\s*'a'\)/)
})

test('纯逻辑层必须被 index.ts 真实使用（防重构回退到内联）', () => {
  assert.match(indexSrc, /from '\.\/cli\.js'/)
  assert.match(indexSrc, /from '\.\/workflows\.js'/)
  assert.match(indexSrc, /from '\.\/venv\.js'/)
  assert.match(indexSrc, /buildCliArgs\(config\.workspaceDir, args\)/, 'runCli 必须走 buildCliArgs')
  assert.match(indexSrc, /discoverWorkflows\(/, 'comfy_workflows 回退扫描必须走纯函数')
})
