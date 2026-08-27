import { runInNewContext } from 'node:vm'
// TypeScript 7 is a native CLI; transpile tests still need the legacy JavaScript API.
import ts from 'typescript-api'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { getPiTitlebarExtensionSource } from './titlebar-extension-source'

const BRAILLE_RE = /[⠀-⣿]/

type TitlebarContext = { ui: { setTitle: (title: string) => void } }
type HookHandler = (event?: unknown, context?: TitlebarContext) => Promise<void> | void

type Harness = {
  handlers: Record<string, HookHandler>
  titles: string[]
  lastTitle: () => string | undefined
  callHook: (name: string, event?: unknown) => Promise<void>
}

const CWD = '/repo/orca-app'
const SESSION = 'omp-session'
const IDLE_TITLE = `π - ${SESSION} - orca-app`

function createHarness(options: { paneKey?: string } = {}): Harness {
  const titles: string[] = []
  const ctx: TitlebarContext = {
    ui: {
      setTitle: (title: string) => {
        titles.push(title)
      }
    }
  }

  const module = {
    exports: {} as {
      default?: (pi: {
        on: (name: string, handler: HookHandler) => void
        getSessionName: () => string
      }) => void
    }
  }

  const context = {
    module,
    exports: module.exports,
    process: {
      env: { ORCA_PANE_KEY: options.paneKey ?? 'pane-1' },
      cwd: () => CWD
    },
    console: { warn: vi.fn(), error: vi.fn(), log: vi.fn() },
    Promise,
    // Why: forward to the test realm's timers so vi.useFakeTimers() drives the VM's interval.
    setInterval: (...args: Parameters<typeof setInterval>) => setInterval(...args),
    clearInterval: (timer: ReturnType<typeof setInterval>) => clearInterval(timer)
  } as Record<string, unknown>
  context.globalThis = context

  const output = ts.transpileModule(getPiTitlebarExtensionSource(), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }
  }).outputText
  runInNewContext(output, context)

  const register = module.exports.default
  if (!register) {
    throw new Error('expected default export from generated source')
  }

  const handlers: Record<string, HookHandler> = {}
  register({
    on(name: string, handler: HookHandler) {
      handlers[name] = handler
    },
    getSessionName: () => SESSION
  })

  return {
    handlers,
    titles,
    lastTitle: () => titles.at(-1),
    callHook: async (name, event) => {
      const handler = handlers[name]
      if (!handler) {
        throw new Error(`no handler registered for ${name}`)
      }
      await handler(event, ctx)
    }
  }
}

describe('getPiTitlebarExtensionSource', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('registers nothing outside an Orca pane', () => {
    expect(createHarness({ paneKey: '' }).handlers).toEqual({})
  })

  it('stops the spinner when the agent settles', async () => {
    const harness = createHarness()

    await harness.callHook('agent_start')
    expect(vi.getTimerCount()).toBe(1)

    await harness.callHook('agent_settled')

    expect(vi.getTimerCount()).toBe(0)
    expect(harness.lastTitle()).toBe(IDLE_TITLE)
    expect(harness.lastTitle()).not.toMatch(BRAILLE_RE)

    const titleCountAtSettle = harness.titles.length
    vi.advanceTimersByTime(800)
    expect(harness.titles.length).toBe(titleCountAtSettle)
  })

  it('spins for idle auto-compaction and clears it on completion', async () => {
    const harness = createHarness()

    await harness.callHook('auto_compaction_start', { reason: 'idle' })
    expect(vi.getTimerCount()).toBe(1)
    vi.advanceTimersByTime(80)
    expect(harness.lastTitle()).toMatch(BRAILLE_RE)

    await harness.callHook('auto_compaction_end', { reason: 'idle' })

    expect(vi.getTimerCount()).toBe(0)
    expect(harness.lastTitle()).toBe(IDLE_TITLE)
  })

  it('caps the idle-maintenance spinner when no completion event arrives', async () => {
    const harness = createHarness()

    await harness.callHook('auto_compaction_start', { reason: 'idle' })
    // Just past the ~5-minute cap; the guard is checked at the top of the next frame.
    vi.advanceTimersByTime(301_000)

    expect(vi.getTimerCount()).toBe(0)
    expect(harness.lastTitle()).toBe(IDLE_TITLE)
  })

  it('does not cap an agent-owned spinner', async () => {
    const harness = createHarness()

    await harness.callHook('agent_start')
    vi.advanceTimersByTime(301_000)

    expect(vi.getTimerCount()).toBe(1)
    expect(harness.lastTitle()).toMatch(BRAILLE_RE)
  })

  it('keeps spinning through threshold compaction inside an active run', async () => {
    const harness = createHarness()

    await harness.callHook('agent_start')
    await harness.callHook('auto_compaction_start', { reason: 'threshold' })
    await harness.callHook('auto_compaction_end', { reason: 'threshold' })

    expect(vi.getTimerCount()).toBe(1)
    vi.advanceTimersByTime(80)
    expect(harness.lastTitle()).toMatch(BRAILLE_RE)
  })

  it('does not let an idle compaction adopt an already-running agent spinner', async () => {
    const harness = createHarness()

    await harness.callHook('agent_start')
    await harness.callHook('auto_compaction_start', { reason: 'idle' })
    await harness.callHook('auto_compaction_end', { reason: 'idle' })

    expect(vi.getTimerCount()).toBe(1)
    vi.advanceTimersByTime(80)
    expect(harness.lastTitle()).toMatch(BRAILLE_RE)
  })

  it('does not let a stale idle-compaction completion stop a newer run', async () => {
    const harness = createHarness()

    await harness.callHook('auto_compaction_start', { reason: 'idle' })
    await harness.callHook('agent_start')
    await harness.callHook('auto_compaction_end', { reason: 'idle' })

    expect(vi.getTimerCount()).toBe(1)
    vi.advanceTimersByTime(80)
    expect(harness.lastTitle()).toMatch(BRAILLE_RE)
  })

  it('still stops on legacy agent_end and on session shutdown', async () => {
    const harness = createHarness()

    await harness.callHook('agent_start')
    await harness.callHook('agent_end')
    expect(vi.getTimerCount()).toBe(0)
    expect(harness.lastTitle()).toBe(IDLE_TITLE)

    await harness.callHook('agent_start')
    await harness.callHook('session_shutdown')
    expect(vi.getTimerCount()).toBe(0)
    expect(harness.lastTitle()).toBe(IDLE_TITLE)
  })
})
