import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const mode = process.argv[2] || '--unit'
if (process.argv.length > 3 || !['--unit', '--runtime', '--all'].includes(mode)) {
  console.error('用法：node bin/test.mjs [--unit|--runtime|--all]')
  process.exit(1)
}
if (mode !== '--unit' && !process.env.DSH_BOOT_MODULE) {
  console.error('请设置 DSH_BOOT_MODULE=<DSH运行时>/lib/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js')
  process.exit(1)
}
const tests = readdirSync(path.join(root, 'tests'))
  .filter(name => name.endsWith('.test.mjs'))
  .filter(name => mode === '--all' || name.includes('-runtime.') === (mode === '--runtime'))
  .sort()
  .map(name => path.join(root, 'tests', name))
if (!tests.length) throw new Error('没有匹配的测试文件')
const result = spawnSync(process.execPath, ['--test', ...tests], {
  cwd: root,
  env: process.env,
  stdio: 'inherit',
})
if (result.error) throw result.error
process.exit(result.status ?? 1)
