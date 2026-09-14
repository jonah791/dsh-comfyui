/**
 * workflows.ts 纯函数套件（离线、零 IO）。
 * 覆盖：正常路径 + 失败/退化路径（坏 JSON、脏 config、未声明 server、探针缺失、大小写边界、空数组、幂等）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseWorkspaceConfig, discoverWorkflows } from '../lib/workflows.js'

// ---------- parseWorkspaceConfig ----------

test('parseWorkspaceConfig: 正常路径——servers + default_server', () => {
  const { serverIds, defaultServer } = parseWorkspaceConfig('{"servers":[{"id":"local"},{"id":"remote"}],"default_server":"remote"}')
  assert.deepEqual([...serverIds].sort(), ['local', 'remote'])
  assert.equal(defaultServer, 'remote')
})

test('parseWorkspaceConfig: 退化输入——坏 JSON / 空文本 / null 字面量一律回落默认且不抛', () => {
  for (const bad of ['', '   ', '{not json', 'null']) {
    const { serverIds, defaultServer } = parseWorkspaceConfig(bad)
    assert.deepEqual([...serverIds], ['local'], `'${bad}' 应回落默认 server 集`)
    assert.equal(defaultServer, 'local')
  }
})

test('parseWorkspaceConfig: 脏数据——合法但无 servers 键（3 / [] / {}）同样回落默认', () => {
  for (const weird of ['3', '[]', '{}', '"local"']) {
    const { serverIds, defaultServer } = parseWorkspaceConfig(weird)
    assert.deepEqual([...serverIds], ['local'])
    assert.equal(defaultServer, 'local')
  }
})

test('parseWorkspaceConfig: 真实语义——servers 为空数组 ⇒ 空集（不是「加回 local」），只认顶层 file-top', () => {
  const { serverIds, defaultServer } = parseWorkspaceConfig('{"servers":[]}')
  assert.equal(serverIds.size, 0)
  assert.equal(serverIds.has('local'), false)
  assert.equal(defaultServer, 'local')
})

test('parseWorkspaceConfig: 脏数据——条目缺 id 时 Set 里出现 undefined；重复 id 去重', () => {
  const { serverIds } = parseWorkspaceConfig('{"servers":[{"id":"a"},{"id":"a"},{"name":"b"}]}')
  assert.equal(serverIds.size, 2)
  assert.equal(serverIds.has('a'), true)
  assert.equal([...serverIds].includes(undefined), true)
})

test('parseWorkspaceConfig: 边界——default_server 为 null 会被采纳（判据是 !== undefined）', () => {
  assert.equal(parseWorkspaceConfig('{"default_server":null}').defaultServer, null)
  assert.equal(parseWorkspaceConfig('{"default_server":""}').defaultServer, '')
})

// ---------- discoverWorkflows ----------

test('discoverWorkflows: 正常路径——三种格式按 IO 顺序产出（dir / file / file-top）', () => {
  const entries = [
    {
      name: 'local',
      kind: 'dir',
      children: [
        { name: 'anima-v2-timeai-core', kind: 'dir', hasWorkflowJson: true },
        { name: 'legacy', kind: 'file' },
        { name: 'legacy.json', kind: 'file' },
        { name: 'notes.txt', kind: 'file' },
      ],
    },
    { name: 'top.json', kind: 'file' },
    { name: 'README.md', kind: 'file' },
  ]
  assert.deepEqual(discoverWorkflows(entries, new Set(['local']), 'local'), [
    { workflow_id: 'anima-v2-timeai-core', server_id: 'local', enabled: true, format: 'dir' },
    { workflow_id: 'legacy', server_id: 'local', enabled: true, format: 'file' },
    { workflow_id: 'top', server_id: 'local', enabled: true, format: 'file-top' },
  ])
})

test('discoverWorkflows: 退化输入——空数组 / 空 server 集（前者空结果，后者只出 file-top）', () => {
  assert.deepEqual(discoverWorkflows([], new Set(['local']), 'local'), [])
  const entries = [
    { name: 'local', kind: 'dir', children: [{ name: 'wf', kind: 'dir', hasWorkflowJson: true }] },
    { name: 'top.json', kind: 'file' },
  ]
  assert.deepEqual(discoverWorkflows(entries, new Set(), 'local'), [
    { workflow_id: 'top', server_id: 'local', enabled: true, format: 'file-top' },
  ])
})

test('discoverWorkflows: 边界——未在 config.json 声明的 server 目录整棵跳过（children 一律不看）', () => {
  const entries = [
    { name: 'shadow', kind: 'dir', children: [{ name: 'wf', kind: 'dir', hasWorkflowJson: true }, { name: 'x.json', kind: 'file' }] },
  ]
  assert.deepEqual(discoverWorkflows(entries, new Set(['local']), 'local'), [])
})

test('discoverWorkflows: 退化路径——目录探针缺失/false 不计入；kind=other（符号链接等）一律忽略', () => {
  const entries = [
    {
      name: 'local',
      kind: 'dir',
      children: [
        { name: 'no-probe', kind: 'dir' },
        { name: 'probe-false', kind: 'dir', hasWorkflowJson: false },
        { name: 'probe-true', kind: 'dir', hasWorkflowJson: true },
        { name: 'link', kind: 'other' },
      ],
    },
    { name: 'weird', kind: 'other' },
  ]
  assert.deepEqual(discoverWorkflows(entries, new Set(['local']), 'local'), [
    { workflow_id: 'probe-true', server_id: 'local', enabled: true, format: 'dir' },
  ])
})

test('discoverWorkflows: 边界——.json 判据大小写敏感；server 目录缺失 children 不崩', () => {
  const entries = [
    { name: 'local', kind: 'dir' }, // 无 children（IO 层未填）
    { name: 'UPPER.JSON', kind: 'file' },
    { name: 'mixed.Json', kind: 'file' },
    { name: 'ok.json', kind: 'file' },
    { name: 'workflow.json', kind: 'file' },
  ]
  assert.deepEqual(discoverWorkflows(entries, new Set(['local']), 'local'), [
    { workflow_id: 'ok', server_id: 'local', enabled: true, format: 'file-top' },
    { workflow_id: 'workflow', server_id: 'local', enabled: true, format: 'file-top' },
  ])
})

test('discoverWorkflows: 边界——file-top 的 server_id 取 defaultServer（含 null 脏值如实透传）', () => {
  const entries = [{ name: 'a.json', kind: 'file' }]
  assert.equal(discoverWorkflows(entries, new Set(['local']), 'remote')[0].server_id, 'remote')
  assert.equal(discoverWorkflows(entries, new Set(['local']), null)[0].server_id, null)
})

test('discoverWorkflows: 幂等/纯——不修改入参，重复调用结果 deepEqual', () => {
  const entries = [
    { name: 'local', kind: 'dir', children: [{ name: 'wf', kind: 'dir', hasWorkflowJson: true }, { name: 'a.json', kind: 'file' }] },
    { name: 'b.json', kind: 'file' },
  ]
  const snapshot = JSON.parse(JSON.stringify(entries))
  const first = discoverWorkflows(entries, new Set(['local']), 'local')
  const second = discoverWorkflows(entries, new Set(['local']), 'local')
  assert.deepEqual(entries, snapshot, '纯函数不得改写入参')
  assert.deepEqual(first, second, '同输入必须同输出')
  assert.notEqual(first, second, '每次返回新数组（调用方各自持有）')
})
