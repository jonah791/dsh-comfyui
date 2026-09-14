/**
 * venv.ts 纯函数套件（离线、零 IO）。
 * 覆盖：正常路径 + 失败/退化路径（缺 home 行、前导空格、注释行、空值、CRLF、尾部分隔符、空 home）。
 * 重点钉住「未匹配（null）」与「匹配但值为空（''）」的语义分界——它们在 venvBrokenInfo 里走不同分支。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pyvenvCfgPath, parsePyvenvHome, basePythonPath } from '../lib/venv.js'

const posix = (p) => p.replace(/\\/g, '/')

// ---------- 路径推导 ----------

test('pyvenvCfgPath: pythonPath=<venv>/Scripts/python.exe → <venv>/pyvenv.cfg', () => {
  assert.equal(posix(pyvenvCfgPath('D:/桌面/ComfyUI/.venv/Scripts/python.exe')), 'D:/桌面/ComfyUI/.venv/pyvenv.cfg')
})

test('pyvenvCfgPath: 退化输入——空串/相对路径不抛（返回相对 pyvenv.cfg）', () => {
  assert.equal(posix(pyvenvCfgPath('')), '../pyvenv.cfg')
  assert.equal(posix(pyvenvCfgPath('python.exe')), '../pyvenv.cfg')
})

test('basePythonPath: 正常与退化（home 为空 ⇒ 相对路径，交给 existsSync 判否）', () => {
  assert.equal(posix(basePythonPath('C:/Users/tr/scoop/apps/python312/current')), 'C:/Users/tr/scoop/apps/python312/current/python.exe')
  assert.equal(posix(basePythonPath('')), 'python.exe')
})

// ---------- parsePyvenvHome ----------

test('parsePyvenvHome: 正常路径——取 home 值（其余行忽略）', () => {
  const cfg = 'home = C:/Users/tr/scoop/apps/python312/current\ninclude = C:/Python312/Lib/site-packages\nversion = 3.12.7\n'
  assert.equal(parsePyvenvHome(cfg), 'C:/Users/tr/scoop/apps/python312/current')
})

test('parsePyvenvHome: 边界——剥尾部分隔符（正/反斜杠，含多个）', () => {
  assert.equal(parsePyvenvHome('home = C:/py/312///\n'), 'C:/py/312')
  assert.equal(parsePyvenvHome(String.raw`home = C:\py\312\\` + '\n'), String.raw`C:\py\312`)
})

test('parsePyvenvHome: 边界——CRLF 文件（\\r 不混进值里）', () => {
  assert.equal(parsePyvenvHome('home = C:/py/312\r\ninclude = x\r\n'), 'C:/py/312')
})

test('parsePyvenvHome: 失败路径——无 home 行/空文本/纯换行一律返回 null（未匹配）', () => {
  assert.equal(parsePyvenvHome('include = x\nversion = 3.12'), null)
  assert.equal(parsePyvenvHome(''), null)
  assert.equal(parsePyvenvHome('\n\n'), null)
})

test('parsePyvenvHome: 退化路径——前导空格 / 注释 / `#home` 都不算命中（锚定行首，真实语义）', () => {
  assert.equal(parsePyvenvHome('  home = C:/x\n'), null)
  assert.equal(parsePyvenvHome('# home = C:/x\n'), null)
  assert.equal(parsePyvenvHome('#home = C:/x\n'), null)
})

test('parsePyvenvHome: 语义分界——匹配但值为空白返回 ""（≠ null），二者在 venvBrokenInfo 分流不同', () => {
  assert.equal(parsePyvenvHome('home =    \n'), '')
  assert.notEqual(parsePyvenvHome('home =    \n'), null)
  assert.equal(parsePyvenvHome('home=x\n'), 'x')
})

test('parsePyvenvHome: 边界——多行 home 取第一个；值里的引号不被剥（如实透传）', () => {
  assert.equal(parsePyvenvHome('home = first\nhome = second\n'), 'first')
  assert.equal(parsePyvenvHome('home = "C:/quoted"\n'), '"C:/quoted"')
})

test('parsePyvenvHome: 幂等——同一文本重复解析结果稳定（纯函数）', () => {
  const cfg = 'home = C:/py/312/\ninclude = y\n'
  assert.equal(parsePyvenvHome(cfg), parsePyvenvHome(cfg))
})
