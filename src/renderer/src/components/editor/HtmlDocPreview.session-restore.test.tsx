// @vitest-environment happy-dom
//
// A preview tab that survives a restart comes back into a cold app: no grant exists for it, and
// the machine that owns its document may not be reachable yet. These pin what the reader gets in
// that window — the preview mints its own grant from today's owners when it can, and says so
// instead of vanishing when it cannot, with the reload it already offers as the way back.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { htmlDocPreviewFileId } from '@/store/slices/editor/actions/html-doc-preview-action'

const GRANT_ID = 'd'.repeat(32)
const WORKTREE_ID = 'repo1::/repo'
const ABSOLUTE_PATH = '/repo/report/index.html'
const ENTRY_RELATIVE_PATH = 'report/index.html'

// `hostReachable` stands in for the SSH target being connected: until it is, nothing resolves an
// owner for this document and the request builder answers null, exactly as it does at startup.
const grantRuntime = vi.hoisted(() => ({
  hostReachable: false,
  mints: [] as string[],
  released: [] as string[]
}))

vi.mock('@/lib/doc-preview-grants', () => ({
  buildDocPreviewGrantRequest: () =>
    grantRuntime.hostReachable
      ? {
          owner: { kind: 'ssh' as const, connectionId: 'ssh-1' },
          root: '/repo',
          entryRelativePath: ENTRY_RELATIVE_PATH
        }
      : null,
  ensureDocPreviewGrant: (previewId: string) => {
    grantRuntime.mints.push(previewId)
    return Promise.resolve({
      grantId: GRANT_ID,
      url: `orca-preview://${GRANT_ID}/${ENTRY_RELATIVE_PATH}`
    })
  },
  releaseDocPreviewGrant: (previewId: string) => {
    grantRuntime.released.push(previewId)
  }
}))

vi.mock('@/components/browser-pane/host-guest/webview-registry', () => ({
  moveFocusToRendererBeforeWebviewDetach: () => undefined
}))

vi.mock('@/lib/execution-host-display-label', () => ({
  selectWorktreeHostDisplayLabel: () => 'demo-host'
}))

const storeState = {
  getKnownWorktreeById: () => ({ path: '/repo' }),
  persistedUIReady: true,
  settings: {},
  keybindings: {},
  browserAnnotationsByPageId: {} as Record<string, unknown[]>,
  activeGroupIdByWorktree: {} as Record<string, string>,
  agentSendPopoverTargetMode: null,
  openAgentSendPopoverTargetMode: () => undefined,
  closeAgentSendPopoverTargetMode: () => undefined,
  addBrowserPageAnnotation: () => undefined,
  deleteBrowserPageAnnotation: () => undefined,
  clearBrowserPageAnnotations: () => undefined,
  recordFeatureInteraction: () => undefined,
  openFile: () => 'file-1'
}

vi.mock('@/store', () => ({
  useAppStore: Object.assign(
    (selector?: (state: typeof storeState) => unknown) =>
      selector ? selector(storeState) : storeState,
    { getState: () => storeState }
  )
}))

/** The props EditorContent hands a preview tab, keyed the way hydration mints its id. */
async function renderRestoredPreview(root: Root): Promise<void> {
  const { HtmlDocPreview } = await import('./HtmlDocPreview')
  await act(async () => {
    root.render(
      <TooltipProvider>
        <HtmlDocPreview
          previewId={htmlDocPreviewFileId(WORKTREE_ID, ABSOLUTE_PATH)}
          filePath={ABSOLUTE_PATH}
          relativePath={ENTRY_RELATIVE_PATH}
          worktreeId={WORKTREE_ID}
          externalSshTargetId="ssh-1"
        />
      </TooltipProvider>
    )
  })
}

describe('HtmlDocPreview restored from a persisted session', () => {
  let container: HTMLDivElement
  let root: Root
  let mounted = false

  beforeEach(() => {
    mounted = true
    grantRuntime.hostReachable = true
    grantRuntime.mints = []
    grantRuntime.released = []
    ;(window as unknown as { api: unknown }).api = {
      docPreview: { onLoadFailure: () => () => undefined },
      ui: { writeClipboardText: () => Promise.resolve() },
      browser: { setAnnotationViewportBridge: () => Promise.resolve(true) }
    }
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  })

  afterEach(() => {
    if (mounted) {
      act(() => root.unmount())
      mounted = false
    }
    container.remove()
  })

  // Why the id matters: nothing about the previous run's grant is persisted, so the restored tab
  // mints a fresh one under the id hydration gave it — the same id its tab chrome names.
  it('mints its own grant under the restored tab id', async () => {
    await renderRestoredPreview(root)

    expect(grantRuntime.mints).toEqual([htmlDocPreviewFileId(WORKTREE_ID, ABSOLUTE_PATH)])
    expect(container.querySelector('webview')?.getAttribute('src')).toBe(
      `orca-preview://${GRANT_ID}/${ENTRY_RELATIVE_PATH}`
    )
  })

  // The startup case the reader actually hits: the window is up before the SSH target reconnects.
  it('says the preview is unavailable when its host is not connected yet, and recovers on reload', async () => {
    grantRuntime.hostReachable = false
    await renderRestoredPreview(root)

    expect(container.querySelector('webview')).toBeNull()
    expect(container.textContent).toContain('Preview unavailable')
    expect(grantRuntime.mints).toEqual([])

    grantRuntime.hostReachable = true
    await act(async () => {
      container.querySelector<HTMLButtonElement>('button[aria-label="Reload preview"]')?.click()
    })

    expect(container.querySelector('webview')?.getAttribute('src')).toBe(
      `orca-preview://${GRANT_ID}/${ENTRY_RELATIVE_PATH}`
    )
    expect(container.textContent).not.toContain('Preview unavailable')
  })
})
