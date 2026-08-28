import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as NodeFsPromisesModule from 'node:fs/promises'
import type * as WslRunningPathFilterModule from '../wsl-running-path-filter'

const UBUNTU_HOME = '\\\\wsl.localhost\\Ubuntu\\home\\ada'
const ROLLOUT_LINUX =
  '/home/ada/.local/share/orca/codex-runtime-home/home/sessions/2026/07/24/rollout-wsl.jsonl'
const ROLLOUT_UNC =
  '\\\\wsl.localhost\\Ubuntu\\home\\ada\\.local\\share\\orca\\codex-runtime-home\\home\\sessions\\2026\\07\\24\\rollout-wsl.jsonl'

const mocks = vi.hoisted(() => ({
  filterPathsToRunningWslDistrosAsync: vi.fn(),
  getWslHomeAsync: vi.fn(),
  install: vi.fn(),
  listRunningWslDistrosAsync: vi.fn(),
  resolve: vi.fn()
}))

vi.mock('./session-file-resolver', () => ({
  resolveSessionFilePath: mocks.resolve
}))
vi.mock('./transcript-watch-engine', () => ({
  getActiveNativeChatWatcherCount: vi.fn(() => 0),
  installTranscriptWatcher: mocks.install
}))
vi.mock('../wsl', () => ({
  getWslHomeAsync: mocks.getWslHomeAsync,
  listRunningWslDistrosAsync: mocks.listRunningWslDistrosAsync,
  listRunningWslHomeDirsAsync: vi.fn(async () => [UBUNTU_HOME])
}))
vi.mock('../wsl-running-path-filter', async (importOriginal) => ({
  ...(await importOriginal<typeof WslRunningPathFilterModule>()),
  filterPathsToRunningWslDistrosAsync: mocks.filterPathsToRunningWslDistrosAsync
}))
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFsPromisesModule>()
  return {
    ...actual,
    access: async (path: string) => {
      if (path !== ROLLOUT_UNC) {
        await actual.access(path)
      }
    }
  }
})

import { resetHostReadableTranscriptPathCacheForTests } from './host-readable-transcript-path'
import { subscribeNativeChatTranscript } from './transcript-watch'
import { WslTranscriptFsError } from './wsl-transcript-fs-gate'

const realPlatform = process.platform

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })
}

describe('exact hook path install on a Windows host with WSL (#10326)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    resetHostReadableTranscriptPathCacheForTests()
    mocks.filterPathsToRunningWslDistrosAsync
      .mockReset()
      .mockImplementation(async (paths: readonly string[]) => [...paths])
    mocks.getWslHomeAsync.mockReset().mockResolvedValue(UBUNTU_HOME)
    mocks.install.mockReset().mockReturnValue(null)
    mocks.listRunningWslDistrosAsync.mockReset().mockResolvedValue(['Ubuntu'])
    mocks.resolve.mockReset().mockResolvedValue(null)
  })

  afterEach(() => {
    vi.useRealTimers()
    setPlatform(realPlatform)
  })

  it('installs the watcher on the WSL UNC twin of the guest transcript path', async () => {
    setPlatform('win32')
    const subscription = await subscribeNativeChatTranscript({
      agent: 'codex',
      sessionId: 'wsl-sess',
      transcriptPath: ROLLOUT_LINUX,
      resolvePollIntervalMs: 10,
      onAppend: () => {}
    })

    await vi.advanceTimersByTimeAsync(50)
    expect(mocks.install).toHaveBeenCalledWith(
      ROLLOUT_UNC,
      expect.anything(),
      expect.anything(),
      expect.any(AbortSignal)
    )
    expect(mocks.install.mock.calls.every(([path]) => path !== ROLLOUT_LINUX)).toBe(true)
    subscription.unsubscribe()
  })

  it('passes the raw path through untouched off Windows', async () => {
    setPlatform('darwin')
    const subscription = await subscribeNativeChatTranscript({
      agent: 'codex',
      sessionId: 'wsl-sess',
      transcriptPath: ROLLOUT_LINUX,
      resolvePollIntervalMs: 10,
      onAppend: () => {}
    })

    await vi.advanceTimersByTimeAsync(50)
    expect(mocks.install).toHaveBeenCalledWith(
      ROLLOUT_LINUX,
      expect.anything(),
      expect.anything(),
      expect.any(AbortSignal)
    )
    subscription.unsubscribe()
  })

  it('does not install an already-UNC path after its distro stops', async () => {
    setPlatform('win32')
    mocks.listRunningWslDistrosAsync.mockResolvedValue([])
    const subscription = await subscribeNativeChatTranscript({
      agent: 'codex',
      sessionId: 'wsl-sess',
      transcriptPath: ROLLOUT_UNC,
      resolvePollIntervalMs: 10,
      onAppend: () => {}
    })

    await vi.advanceTimersByTimeAsync(50)
    expect(mocks.listRunningWslDistrosAsync).toHaveBeenCalledTimes(1)
    expect(mocks.install).not.toHaveBeenCalled()
    subscription.unsubscribe()
  })

  it('shares one running snapshot across exact and id fallback resolution', async () => {
    setPlatform('win32')
    mocks.listRunningWslDistrosAsync.mockResolvedValue([])
    const subscription = await subscribeNativeChatTranscript({
      agent: 'codex',
      sessionId: 'wsl-sess',
      transcriptPath: ROLLOUT_UNC,
      resolvePollIntervalMs: 10,
      onAppend: () => {}
    })

    await vi.advanceTimersByTimeAsync(100)
    mocks.listRunningWslDistrosAsync.mockClear()
    mocks.resolve.mockClear()
    await vi.advanceTimersByTimeAsync(5_100)

    expect(mocks.listRunningWslDistrosAsync).toHaveBeenCalledTimes(1)
    expect(mocks.resolve).toHaveBeenCalledTimes(1)
    expect(mocks.resolve.mock.calls[0]?.[2]).toMatchObject({
      transcriptPath: undefined,
      wslSnapshot: { runningDistros: [], homeDirs: [] }
    })
    subscription.unsubscribe()
  })

  it('revalidates an absent UNC transcript before retrying after the distro stops', async () => {
    setPlatform('win32')
    mocks.listRunningWslDistrosAsync
      .mockResolvedValueOnce(['Ubuntu'])
      .mockResolvedValue([])
    const subscription = await subscribeNativeChatTranscript({
      agent: 'codex',
      sessionId: 'wsl-sess',
      transcriptPath: ROLLOUT_UNC,
      resolvePollIntervalMs: 10,
      onAppend: () => {}
    })

    await vi.advanceTimersByTimeAsync(100)
    expect(mocks.install).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(5_100)
    expect(mocks.listRunningWslDistrosAsync).toHaveBeenCalledTimes(2)
    expect(mocks.install).toHaveBeenCalledTimes(1)
    subscription.unsubscribe()
  })

  it('revalidates an UNC transcript after a gated install failure', async () => {
    setPlatform('win32')
    mocks.listRunningWslDistrosAsync
      .mockResolvedValueOnce(['Ubuntu'])
      .mockResolvedValue([])
    mocks.install.mockRejectedValueOnce(new WslTranscriptFsError('timeout', 'stalled'))
    const subscription = await subscribeNativeChatTranscript({
      agent: 'codex',
      sessionId: 'wsl-sess',
      transcriptPath: ROLLOUT_UNC,
      resolvePollIntervalMs: 10,
      onAppend: () => {}
    })

    await vi.advanceTimersByTimeAsync(100)
    expect(mocks.install).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(5_100)
    expect(mocks.listRunningWslDistrosAsync).toHaveBeenCalledTimes(2)
    expect(mocks.install).toHaveBeenCalledTimes(1)
    subscription.unsubscribe()
  })
})
