/**
 * venv.ts — ComfyUI venv 断裂检测的**纯**部分：路径推导 + pyvenv.cfg 的 home 解析。
 *
 * IO（`existsSync` / `readFileSync` / 改写 `pyvenv.cfg`）留在 `src/index.ts`（venvBrokenInfo / repairVenv）。
 * 由 `src/index.ts` 原样搬家（2026-09-14 可维护性补课：S3/S6），行为不变。
 */
import { join, dirname } from 'node:path'

/** pyvenv.cfg 路径 = `<venv>/pyvenv.cfg`（约定 pythonPath = `<venv>/Scripts/python.exe`，故取上一级）。 */
export function pyvenvCfgPath(pythonPath: string): string {
  return join(dirname(pythonPath), '..', 'pyvenv.cfg')
}

/**
 * 从 pyvenv.cfg 文本取 `home` 值：剥空白、剥尾部分隔符（与 `repairVenv` 写回格式一致）。
 *
 * 返回 `null` = **未匹配到 `^home` 行**；返回 `''` = 匹配到但值为空白。
 * 二者在 `venvBrokenInfo` 里走**不同分支**（前者直接判「未断裂」，后者会真的去探 `join('', 'python.exe')`），
 * 故不可合并——这是纯函数必须显式区分的语义边界。
 *
 * 真实语义（刻意保留）：`^home` 锚定行首 ⇒ **前导空格的行不认**；行内引号不剥；多行时取第一个匹配。
 */
export function parsePyvenvHome(cfgText: string): string | null {
  const m = cfgText.match(/^home\s*=\s*(.+)$/m)
  if (m === null) return null
  return (m[1] ?? '').trim().replace(/[\\/]+$/, '')
}

/** base 解释器路径 = `<home>/python.exe`；`home === ''` 时退化为相对路径（交给 `existsSync` 判否）。 */
export function basePythonPath(home: string): string {
  return join(home, 'python.exe')
}
