/**
 * dsh-pc-monitor — host half.
 *
 * Owns two data sources and one HTTP route:
 *   - CPU / memory come from Node itself (os.cpus diffs, os.freemem), so they
 *     cost nothing and never depend on a child process.
 *   - GPU utilization (and the "available memory" figure) come from perf.ps1, a
 *     resident PowerShell child that samples Windows performance counters every
 *     ~2 s and prints one JSON line per sample. It has to be resident: opening
 *     300+ GPU engine counters costs seconds, and Get-Counter fails the whole
 *     call when a single engine went stale.
 *
 * No temperature: the only unprivileged Windows source is the ACPI thermal zone,
 * which reports a coarse chassis value (34.2 -> 34.7 C under 64% CPU load here).
 * A real core temperature needs a kernel driver and admin rights.
 *
 * The route always answers. When the child is missing, dead, or its newest
 * frame is older than STALE_MS, gpu comes back as null and the client shows a
 * dash instead of a fabricated number.
 *
 * @module dsh-pc-monitor
 */
import os from 'node:os'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

export const name = 'dsh-pc-monitor'
/** The route is registered on the shared web server. */
export const inject = ['webServer']

/** Browser poll interval; also the child's own sampling cadence. */
const SAMPLE_MS = 2000
/** A frame older than this means the child stalled: report null, not stale data. */
const STALE_MS = 8000
/** Delay before restarting a child that exited on its own. */
const RESTART_MS = 3000
const ROUTE_PATH = '/api/dsh-pc-monitor/snapshot'
const SCRIPT_PATH = join(dirname(fileURLToPath(import.meta.url)), 'perf.ps1')

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])

function round1(value) {
  return Math.round(value * 10) / 10
}

function isLoopback(request) {
  const address = request.socket?.remoteAddress ?? ''
  return LOOPBACK.has(address)
}

/** CPU busy percentage over the interval since the previous call. */
function createCpuMeter() {
  const read = () => {
    let idle = 0
    let total = 0
    for (const cpu of os.cpus()) {
      idle += cpu.times.idle
      for (const value of Object.values(cpu.times)) total += value
    }
    return { idle, total }
  }
  let previous = read()
  return () => {
    const current = read()
    const totalDelta = current.total - previous.total
    const idleDelta = current.idle - previous.idle
    previous = current
    if (!(totalDelta > 0)) return null
    return Math.min(100, Math.max(0, (1 - idleDelta / totalDelta) * 100))
  }
}

/**
 * Supervises perf.ps1: spawn, line-parse, restart on exit, kill on dispose.
 * @returns {{ frame: () => object | null, state: () => object }}
 */
function startSampler(ctx, logger) {
  let child = null
  let frame = null
  let stderrTail = ''
  let restarts = 0
  let stopped = false
  let restartTimer = null

  const finish = (line) => {
    const text = line.trim()
    if (!text.startsWith('{')) return
    let parsed
    try {
      parsed = JSON.parse(text)
    } catch {
      return
    }
    if (typeof parsed.ts !== 'number') return
    frame = {
      ts: Date.now(),
      perfTs: parsed.ts,
      gpu: typeof parsed.gpu === 'number' ? parsed.gpu : null,
      gpuSum: typeof parsed.gpuSum === 'number' ? parsed.gpuSum : null,
      gpuMax: typeof parsed.gpuMax === 'number' ? parsed.gpuMax : null,
      gpuEngines: typeof parsed.gpuEngines === 'number' ? parsed.gpuEngines : 0,
      memFreeMB: typeof parsed.memFreeMB === 'number' ? parsed.memFreeMB : null,
      err: typeof parsed.err === 'string' ? parsed.err : '',
    }
  }

  const launch = () => {
    if (stopped) return
    let proc
    try {
      proc = spawn(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT_PATH],
        { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
      )
    } catch (error) {
      // A sandboxed or locked-down host can refuse the spawn outright. Keep the
      // Node-sourced dials working and retry later instead of failing the mount.
      stderrTail = `${error?.message ?? error}`.slice(-2000)
      logger?.warn?.(`dsh-pc-monitor: cannot start sampler: ${error?.message ?? error}`)
      restarts++
      restartTimer = setTimeout(launch, RESTART_MS)
      restartTimer.unref?.()
      return
    }
    child = proc
    let pending = ''
    proc.stdout.setEncoding('utf8')
    proc.stdout.on('data', (chunk) => {
      pending += chunk
      let index
      while ((index = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, index)
        pending = pending.slice(index + 1)
        finish(line)
      }
      // A pathological child could emit without newlines; cap the buffer.
      if (pending.length > 65536) pending = pending.slice(-4096)
    })
    proc.stderr.setEncoding('utf8')
    proc.stderr.on('data', (chunk) => {
      stderrTail = (stderrTail + chunk).slice(-2000)
    })
    proc.on('error', (error) => {
      stderrTail = `${error?.message ?? error}`.slice(-2000)
      logger?.warn?.(`dsh-pc-monitor: sampler spawn failed: ${error?.message ?? error}`)
    })
    proc.on('exit', (code) => {
      if (child === proc) child = null
      if (stopped) return
      restarts++
      if (stderrTail.trim()) logger?.warn?.(`dsh-pc-monitor: sampler exited (${code}): ${stderrTail.trim()}`)
      restartTimer = setTimeout(launch, RESTART_MS)
      restartTimer.unref?.()
    })
  }

  launch()

  ctx.effect(() => () => {
    stopped = true
    if (restartTimer) clearTimeout(restartTimer)
    if (child) {
      try {
        child.kill()
      } catch {
        // already gone
      }
      child = null
    }
  }, 'dsh-pc-monitor:sampler')

  return {
    frame: () => frame,
    state: () => ({
      restarts,
      pid: child?.pid ?? null,
      stderr: stderrTail.trim(),
    }),
  }
}

export function apply(ctx) {
  const cpuMeter = createCpuMeter()
  const sampler = startSampler(ctx, ctx.logger)

  const snapshot = () => {
    const now = Date.now()
    const total = os.totalmem()
    const cpu = cpuMeter()
    const frame = sampler.frame()
    const fresh = frame !== null && now - frame.ts < STALE_MS
    // Prefer the counter's "available" memory: os.freemem() excludes the standby
    // lists on Windows and would report a machine at 97% as a machine at 93%.
    const availableBytes =
      fresh && frame.memFreeMB !== null ? Math.min(total, frame.memFreeMB * 1024 * 1024) : os.freemem()
    const usedBytes = total - availableBytes
    return {
      ts: now,
      cpu: cpu === null ? null : round1(cpu),
      mem: {
        pct: round1(Math.min(100, Math.max(0, (usedBytes / total) * 100))),
        used: usedBytes,
        total,
      },
      gpu: fresh && frame.gpu !== null ? round1(frame.gpu) : null,
      sample: {
        ageMs: frame === null ? null : now - frame.ts,
        gpuSum: fresh ? frame.gpuSum : null,
        gpuMax: fresh ? frame.gpuMax : null,
        gpuEngines: fresh ? frame.gpuEngines : 0,
        err: frame?.err ?? '',
        child: sampler.state(),
      },
    }
  }

  ctx.effect(() => {
    return ctx.webServer.register({
      kind: 'exact',
      path: ROUTE_PATH,
      // The GUI's own fetch carries the session; the loopback check below keeps
      // this local-only read from becoming remotely readable.
      auth: 'anonymous',
      handler: (request, response) => {
        if (!isLoopback(request)) {
          response.statusCode = 403
          response.setHeader('content-type', 'application/json; charset=utf-8')
          response.end(JSON.stringify({ ok: false, error: 'loopback only' }))
          return
        }
        if (request.method !== 'GET' && request.method !== 'HEAD') {
          response.statusCode = 405
          response.setHeader('allow', 'GET, HEAD')
          response.end()
          return
        }
        const body = JSON.stringify(snapshot())
        response.statusCode = 200
        response.setHeader('content-type', 'application/json; charset=utf-8')
        response.setHeader('cache-control', 'no-store')
        response.end(request.method === 'HEAD' ? undefined : body)
      },
    })
  }, 'dsh-pc-monitor:route')

  ctx.logger?.info?.('dsh-pc-monitor: sampling CPU/memory/GPU')
}
