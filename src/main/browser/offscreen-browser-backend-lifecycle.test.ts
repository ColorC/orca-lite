import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  windows: [] as MockBrowserWindow[],
  BrowserWindow: vi.fn(),
  finishLoads: true
}))

class MockWebContents extends EventEmitter {
  readonly id: number

  constructor(id: number) {
    super()
    this.id = id
  }

  loadURL(): Promise<void> {
    if (mocks.finishLoads) {
      queueMicrotask(() => this.emit('did-finish-load'))
    }
    return Promise.resolve()
  }
}

class MockBrowserWindow {
  readonly webContents: MockWebContents
  private destroyed = false

  constructor() {
    this.webContents = new MockWebContents(mocks.windows.length + 1)
    mocks.windows.push(this)
  }

  isDestroyed(): boolean {
    return this.destroyed
  }

  destroy(): void {
    this.destroyed = true
    this.webContents.emit('destroyed')
  }
}

vi.mock('electron', () => ({ BrowserWindow: mocks.BrowserWindow }))
vi.mock('./browser-session-registry', () => ({
  browserSessionRegistry: {
    getDefaultProfile: vi.fn(() => ({ id: 'default', partition: 'persist:orca-browser' }))
  }
}))

import { OffscreenBrowserBackend } from './offscreen-browser-backend'
import { parseDocPreviewToolTargetId } from '../../shared/doc-preview-scheme'

/** The real door's answer, so the backend is tested against the refusal it will actually get. */
function registerOffscreenGuestLikeBrowserManager({
  browserPageId
}: {
  browserPageId: string
}): boolean {
  return parseDocPreviewToolTargetId(browserPageId) === null
}

describe('OffscreenBrowserBackend lifecycle', () => {
  beforeEach(() => {
    mocks.windows.length = 0
    mocks.finishLoads = true
    mocks.BrowserWindow.mockImplementation(
      function BrowserWindowMock(this: {
        webContents: MockWebContents
        isDestroyed: () => boolean
        destroy: () => void
      }) {
        const window = new MockBrowserWindow()
        this.webContents = window.webContents
        this.isDestroyed = window.isDestroyed.bind(window)
        this.destroy = window.destroy.bind(window)
      }
    )
  })

  it('settles a pending load and removes its waiters when the page is destroyed', async () => {
    vi.useFakeTimers()
    mocks.finishLoads = false
    const browserManager = {
      registerOffscreenGuest: vi.fn(registerOffscreenGuestLikeBrowserManager),
      unregisterGuest: vi.fn()
    }
    const backend = new OffscreenBrowserBackend(browserManager as never)

    await backend.createTab({
      browserPageId: 'page-1',
      url: 'https://example.com',
      worktreeId: 'wt'
    })
    const webContents = mocks.windows[0].webContents
    expect(webContents.listenerCount('did-finish-load')).toBe(1)
    expect(webContents.listenerCount('did-fail-load')).toBe(1)

    await backend.closeTab('page-1')
    expect(webContents.listenerCount('did-finish-load')).toBe(0)
    expect(webContents.listenerCount('did-fail-load')).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
    vi.useRealTimers()
  })

  // Why the unregister assertion and not just the destroy: a refused id is one the preview
  // authority may own, and the teardown hook would cancel that grant's work on the way out.
  it('destroys a window whose registration was refused without unregistering the id', async () => {
    const browserManager = {
      registerOffscreenGuest: vi.fn(registerOffscreenGuestLikeBrowserManager),
      unregisterGuest: vi.fn()
    }
    const backend = new OffscreenBrowserBackend(browserManager as never)

    await expect(
      backend.createTab({
        browserPageId: `doc-preview-grant:${'b'.repeat(32)}`,
        url: 'https://example.com',
        worktreeId: 'wt'
      })
    ).rejects.toThrow('was refused')

    expect(mocks.windows[0].isDestroyed()).toBe(true)
    expect(browserManager.unregisterGuest).not.toHaveBeenCalled()

    // Why shutdown and not the map: a refused id left behind is invisible until teardown walks it
    // and hands that id to the other authority after all.
    backend.destroyAll()
    expect(browserManager.unregisterGuest).not.toHaveBeenCalled()
  })
})
