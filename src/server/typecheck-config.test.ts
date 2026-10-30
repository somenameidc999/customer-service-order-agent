import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// Regression guard for the follow-up to PR #7 review finding P3: tsconfig.server.json
// excludes *.test.ts so the production build stays clean, which used to mean a type
// error in a server test only surfaced at test runtime. tsconfig.test.json type-checks
// the tests and `npm run typecheck` runs it, so tests fail at build time instead.
const rootDirectory = fileURLToPath(new URL('../../', import.meta.url))

async function readJson(name: string) {
  return JSON.parse(await readFile(join(rootDirectory, name), 'utf8'))
}

test('server tests are type-checked even though the server build excludes them', async () => {
  const buildConfig = await readJson('tsconfig.server.json')
  assert.deepEqual(
    buildConfig.exclude,
    ['src/server/**/*.test.ts'],
    'the production server build should still exclude test files',
  )

  const testConfig = await readJson('tsconfig.test.json')
  assert.ok(
    Array.isArray(testConfig.include) && testConfig.include.some((entry: string) => entry.includes('src/server/**/*.test.ts')),
    'tsconfig.test.json should include src/server/**/*.test.ts',
  )
  assert.equal(testConfig.compilerOptions?.noEmit, true, 'the test type-check must not emit files')

  const pkg = await readJson('package.json')
  const typecheck = pkg.scripts?.typecheck
  assert.equal(typeof typecheck, 'string', 'package.json should define a typecheck script')
  assert.match(typecheck, /tsc -p tsconfig\.test\.json/, 'typecheck should run the test TypeScript config')
  assert.match(pkg.scripts?.check ?? '', /npm run (test|build)/, 'npm run check should still drive the verification')
})
