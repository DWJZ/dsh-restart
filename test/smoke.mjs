/**
 * dsh-restart smoke test — runs the host helpers and the client bundle's
 * factory/apply without a live host.
 *
 * Usage: `node test/smoke.mjs` (from this package, or by path).
 * The render assertion needs React, resolved from a DSH checkout; set
 * `DSH_CHECKOUT` to that checkout's root, or it is skipped.
 */
import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)
const PLUGIN = resolve(dirname(fileURLToPath(import.meta.url)), '..')

let failures = 0
const check = (name, condition, detail = '') => {
  if (condition) console.log(`  ok   ${name}`)
  else {
    failures += 1
    console.log(`  FAIL ${name} ${detail}`)
  }
}

console.log('host half')
const host = await import(pathToFileURL(join(PLUGIN, 'src/index.js')).href)

const launch = host.hostLaunch({
  argv: ['/opt/node/bin/node', 'apps/cli/src/bin.ts', 'web', '--no-open'],
  execArgv: ['--import', 'tsx/esm'],
  platform: 'darwin',
})
check('hostLaunch keeps the host entry absolute', launch.file === process.execPath && launch.args[2] === resolve('apps/cli/src/bin.ts'), JSON.stringify(launch))
check('hostLaunch keeps execArgv', JSON.stringify(launch.args.slice(0, 2)) === JSON.stringify(['--import', 'tsx/esm']))
check('hostLaunch replays the inner argv', JSON.stringify(launch.args.slice(3)) === JSON.stringify(['web', '--no-open']))
check('hostLaunch runs from the entry directory', launch.cwd === resolve('apps/cli/src'), launch.cwd)
check('hostLaunch needs no shell', launch.viaShell === false)
check('hostLaunch falls back to the dsh shim',
  host.hostLaunch({ argv: ['/opt/node/bin/node', '/usr/local/bin/other'], execArgv: [], platform: 'darwin' }).file === 'dsh')

const probe = join(tmpdir(), `dsh-restart-smoke-${String(process.pid)}.txt`)
const logOut = join(tmpdir(), 'dsh-restart-smoke.out.log')
const logErr = join(tmpdir(), 'dsh-restart-smoke.err.log')
rmSync(probe, { force: true })
rmSync(logOut, { force: true })
const { spawn } = await import('node:child_process')
const helper = spawn(process.execPath, ['-e', host.helperSource(
  { file: process.execPath, args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(probe)}, 'up')`], cwd: undefined, viaShell: false },
  logOut, logErr, 45999,
)], { detached: true, stdio: 'ignore' })
helper.unref()
const deadline = Date.now() + 8000
while (Date.now() < deadline && !existsSync(probe)) await new Promise(resolvePromise => setTimeout(resolvePromise, 100))
check('detached helper starts the replacement', existsSync(probe))
check('detached helper opens the replacement stdout log', existsSync(logOut))
rmSync(probe, { force: true })

const request = (overrides = {}) => ({
  method: 'POST',
  headers: { host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080' },
  socket: { remoteAddress: '127.0.0.1' },
  ...overrides,
})
check('sameOriginLoopback accepts a same-origin loopback POST', host.sameOriginLoopback(request()) === true)
check('sameOriginLoopback rejects another origin', host.sameOriginLoopback(request({ headers: { host: '127.0.0.1:3080', origin: 'http://evil.test' } })) === false)
check('sameOriginLoopback rejects a forwarded peer', host.sameOriginLoopback(request({ headers: { host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080', 'x-forwarded-for': '10.0.0.1' } })) === false)
check('sameOriginLoopback rejects a non-loopback peer', host.sameOriginLoopback(request({ socket: { remoteAddress: '10.0.0.5' } })) === false)
check('servingPort reads the Host authority', host.servingPort(request()) === 3080)
check('servingPort is null without a port', host.servingPort(request({ headers: { host: 'dsh.invalid', origin: 'http://dsh.invalid' } })) === null)

console.log('client half')
const found = findReact()
let captured = null
globalThis.window = { __ModuleLoader__: { load: (definition) => { captured = definition } } }
new Function(readFileSync(join(PLUGIN, 'client/client.js'), 'utf8'))()
check('client bundle registers one module', captured !== null && captured.id === 'dsh-restart')

const stubRequire = (specifier) => {
  if (specifier === 'react') return found === null ? { createElement: () => null } : found.react
  if (specifier === '@deepseek-ai/dsh-client-ui-primitives') {
    return { Button: ({ children, ...rest }) => (found === null ? null : found.react.createElement('button', rest, children)) }
  }
  throw new Error(`unexpected require: ${specifier}`)
}
const client = captured.factory(stubRequire)
check('client factory exports apply', typeof client.apply === 'function')
check('client factory exports inject', Array.isArray(client.inject) && client.inject.includes('slots'))

let registration = null
const ctx = {
  effect: (factory) => factory(),
  locale: { register: () => () => {}, bind: () => (key) => key },
  slots: { inject: (_name, factory) => factory(), register: (options, component) => { registration = { options, component }; return () => {} } },
}
client.apply(ctx)
check('client registers a settings section', registration !== null && registration.options.name === 'settings.section')
check('client registers a nav label thunk', typeof registration.options.label === 'function' && registration.options.label() === 'nav')
if (found === null) {
  console.log('  skip render assertion (set DSH_CHECKOUT to a checkout with React installed)')
} else {
  const html = found.server.renderToStaticMarkup(found.react.createElement(registration.component, { t: ctx.locale.bind('dsh-restart') }))
  check('client renders the section', html.includes('dshr_card'))
}

console.log(failures === 0 ? '\nPASS' : `\n${String(failures)} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)

/** Locate React and its server renderer inside a DSH checkout's pnpm store. */
function findReact() {
  const checkouts = [process.env.DSH_CHECKOUT].filter((value) => typeof value === 'string' && value !== '')
  for (const checkout of checkouts) {
    try {
      const store = join(checkout, 'node_modules/.pnpm')
      const react = readdirSync(store).find((name) => /^react@\d/u.test(name))
      const dom = readdirSync(store).find((name) => /^react-dom@\d/u.test(name))
      if (react === undefined || dom === undefined) continue
      return {
        react: require(join(store, react, 'node_modules/react')),
        server: require(join(store, dom, 'node_modules/react-dom/server')),
      }
    }
    catch {
      // No store at this checkout: try the next candidate.
    }
  }
  return null
}
