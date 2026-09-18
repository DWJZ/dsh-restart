/**
 * dsh-restart — host half.
 *
 * Registers two loopback-only routes on the Web host's HTTP server:
 *
 * - `GET /dsh-restart/status` — this process's boot id, pid, start time, and
 *   serving port, so the settings page can tell the replacement host from the
 *   one that scheduled it.
 * - `POST /dsh-restart/restart` — replace this process with a fresh one that
 *   replays the same launch invocation.
 *
 * The replacement is spawned by a detached helper that outlives this process:
 * it waits for the port to stop accepting connections before starting, so the
 * replacement never dies of EADDRINUSE while the old socket is still held.
 */
import { spawn } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

/** Stable Cordis plugin name. */
export const name = 'dsh-restart'

/** Identifies this process on every route answer; a replacement mints its own. */
const BOOT_ID = `${String(process.pid)}-${String(Date.now())}`

/** When this process started serving, as an ISO timestamp. */
const STARTED_AT = new Date().toISOString()

/**
 * Answer one route with JSON.
 * @param res - the response to own.
 * @param statusCode - HTTP status to send.
 * @param payload - value serialized as the body.
 */
function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

/**
 * The request's Host header authority.
 * @param req - incoming request.
 * @returns the authority, or undefined when the request carries none.
 */
function requestHost(req) {
  const host = req.headers.host
  return typeof host === 'string' ? host : undefined
}

/**
 * Whether a process-control request came from this Web host on loopback.
 *
 * A restart has no body and no credentials of its own, so the peer address and
 * a matching Origin/Host pair are the whole authorization: any forwarding
 * header means the loopback peer is a proxy rather than the page itself.
 * @param req - incoming request.
 * @returns true only for a direct same-origin loopback request.
 */
export function sameOriginLoopback(req) {
  const address = req.socket.remoteAddress
  if (address !== '127.0.0.1' && address !== '::1' && address !== '::ffff:127.0.0.1') return false
  if (req.headers.forwarded !== undefined
    || req.headers['x-forwarded-for'] !== undefined
    || req.headers['x-real-ip'] !== undefined) return false
  const host = requestHost(req)
  const origin = req.headers.origin
  if (host === undefined || typeof origin !== 'string') return false
  try {
    const parsed = new URL(origin)
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.host === host
  }
  catch {
    // URL() rejects a malformed Origin; an unparseable authority authorizes nothing.
    return false
  }
}

/**
 * The port this process serves on, read off the request that asks for the
 * restart — the Host header is what the browser actually reached us on, so it
 * is the port the replacement has to take over.
 * @param req - incoming request.
 * @returns the port, or null when the authority carries none.
 */
export function servingPort(req) {
  const host = requestHost(req)
  if (host === undefined) return null
  const match = /:(\d{1,5})$/u.exec(host)
  if (match === null) return null
  const port = Number(match[1])
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : null
}

/**
 * This process's own launch invocation, in the shape the detached helper
 * replays. A `bin.js`/`bin.ts`/`dsh` entry is relaunched through the running
 * Node binary with the same exec arguments and absolute entry, because a
 * source launch passes a relative entry that the child would resolve against
 * its own working directory.
 * @param argv - launch arguments, defaulting to this process's.
 * @param execArgv - Node exec arguments, defaulting to this process's.
 * @param platform - platform deciding the shell fallback, defaulting to this host's.
 * @returns the file, arguments, working directory, and shell requirement.
 */
export function hostLaunch({
  argv = process.argv,
  execArgv = process.execArgv,
  platform = process.platform,
} = {}) {
  const entry = argv[1]
  if (typeof entry === 'string' && /[\\/](?:bin\.(?:js|ts)|dsh)$/u.test(entry)) {
    const absoluteEntry = resolve(entry)
    return {
      file: process.execPath,
      args: [...execArgv, absoluteEntry, ...argv.slice(2)],
      cwd: dirname(absoluteEntry),
      viaShell: false,
    }
  }
  // Bare `dsh` is a .cmd shim on Windows that only a shell can start.
  return {
    file: 'dsh',
    args: [...argv.slice(2)],
    cwd: undefined,
    viaShell: platform === 'win32',
  }
}

/**
 * Source of the detached helper that outlives this process: wait for the port
 * to go quiet, start the replacement, then report when it never binds.
 * @param launch - the invocation to replay.
 * @param logOut - file receiving the replacement's stdout.
 * @param logErr - file receiving the replacement's stderr and helper notes.
 * @param port - the port the replacement must bind; null when unknown.
 * @returns a Node program run with `node -e`.
 */
export function helperSource(launch, logOut, logErr, port) {
  return [
    "const { spawn } = require('node:child_process')",
    "const fs = require('node:fs')",
    "const net = require('node:net')",
    `const file = ${JSON.stringify(launch.file)}`,
    `const args = ${JSON.stringify(launch.args)}`,
    `const cwd = ${JSON.stringify(launch.cwd ?? null)}`,
    `const viaShell = ${JSON.stringify(launch.viaShell)}`,
    `const logOut = ${JSON.stringify(logOut)}`,
    `const logErr = ${JSON.stringify(logErr)}`,
    `const port = ${JSON.stringify(port)}`,
    'const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))',
    'const note = (line) => { try { fs.appendFileSync(logErr, `[dsh-restart] ${line}\\n`) } catch {} }',
    // "Free" means nothing accepts a connection. Checked by connecting rather
    // than by binding: binding to test would itself hold the port.
    'const listening = () => new Promise((resolve) => {',
    '  const probe = net.connect({ host: "127.0.0.1", port })',
    '  const done = (value) => { probe.destroy(); resolve(value) }',
    '  probe.on("connect", () => done(true))',
    '  probe.on("error", () => done(false))',
    '  setTimeout(() => done(false), 500)',
    '})',
    'const main = async () => {',
    '  if (port !== null) {',
    '    const until = Date.now() + 30000',
    '    while (Date.now() < until && await listening()) await sleep(250)',
    '    await sleep(300)',
    '  } else {',
    '    await sleep(1500)',
    '  }',
    '  let child',
    '  try {',
    '    const out = fs.openSync(logOut, "a")',
    '    const err = fs.openSync(logErr, "a")',
    '    child = spawn(file, args, { cwd: cwd === null ? undefined : cwd, detached: true, stdio: ["ignore", out, err], shell: viaShell })',
    '    child.on("error", (error) => note(`could not start the replacement: ${error && error.message ? error.message : error}`))',
    '    child.unref()',
    '  } catch (error) {',
    '    note(`could not start the replacement: ${error && error.message ? error.message : error}`)',
    '    return',
    '  }',
    '  if (port === null) return',
    '  const upBy = Date.now() + 20000',
    '  while (Date.now() < upBy && !(await listening())) await sleep(500)',
    '  if (!(await listening())) note(`the replacement did not bind port ${port} within 20s`)',
    '}',
    'main()',
  ].join('\n')
}

/**
 * Start the detached helper, then stop this process so the helper's
 * replacement can take the port.
 * @param port - the port the replacement must bind; null when unknown.
 * @returns the scheduling facts written to the route answer and the log.
 */
function scheduleRestart(port) {
  const launch = hostLaunch()
  const stamp = new Date().toISOString().replace(/[:.]/gu, '-').slice(0, 19)
  const logOut = join(tmpdir(), `dsh-restart-${stamp}.out.log`)
  const logErr = join(tmpdir(), `dsh-restart-${stamp}.err.log`)
  const helper = spawn(process.execPath, ['-e', helperSource(launch, logOut, logErr, port)], {
    detached: true,
    stdio: 'ignore',
  })
  helper.unref()
  try {
    appendFileSync(logErr, `[dsh-restart] scheduled pid=${String(process.pid)} helper=${String(helper.pid)} port=${String(port)}\n`)
  }
  catch {
    // A missing log file only costs the postmortem; the restart itself proceeds.
  }
  setTimeout(() => { process.kill(process.pid, 'SIGTERM') }, 400)
  return { pid: process.pid, helperPid: helper.pid, logOut, logErr }
}

/**
 * Answer `/dsh-restart/status` with this process's identity.
 * @param req - incoming request.
 * @param res - the response to own.
 */
function statusHandler(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { allow: 'GET, HEAD' })
    res.end()
    return
  }
  if (req.method === 'HEAD') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end()
    return
  }
  sendJson(res, 200, {
    ok: true,
    boot: BOOT_ID,
    pid: process.pid,
    startedAt: STARTED_AT,
    uptimeMs: Math.round(process.uptime() * 1000),
    port: servingPort(req),
  })
}

/**
 * Answer `/dsh-restart/restart` by replacing this process.
 * @param req - incoming request.
 * @param res - the response to own.
 */
function restartHandler(req, res) {
  if (req.method !== 'POST') {
    res.writeHead(405, { allow: 'POST' })
    res.end()
    return
  }
  if (!sameOriginLoopback(req)) {
    sendJson(res, 403, { ok: false, error: 'restart is limited to same-origin loopback requests' })
    return
  }
  try {
    const scheduled = scheduleRestart(servingPort(req))
    sendJson(res, 202, { ok: true, boot: BOOT_ID, ...scheduled })
  }
  catch (error) {
    sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
  }
}

/**
 * Mount the two routes once a Web host server exists. Profiles without a Web
 * host simply never take the injection, so the plugin loads everywhere.
 * @param ctx - Cordis context of this plugin's fiber.
 */
export function apply(ctx) {
  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'exact',
      path: '/dsh-restart/status',
      handler: statusHandler,
    }), 'dsh-restart: status route')
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'exact',
      path: '/dsh-restart/restart',
      handler: restartHandler,
    }), 'dsh-restart: restart route')
  })
}
