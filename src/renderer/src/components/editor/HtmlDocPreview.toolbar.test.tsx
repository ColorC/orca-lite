// @vitest-environment happy-dom
//
// The preview is an editor tab that has to read like a browser tab. These pin the parts of that
// illusion a reader can catch us on: the document names itself and its owning machine instead of
// showing the internal preview scheme, Back/Forward really drive the guest's history, and the chip
// hands over the path the owner spells rather than the one the grant was minted with.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'

const GRANT_ID = 'a'.repeat(32)
const ENTRY_RELATIVE_PATH = 'docs/reports/index.html'
const ABSOLUTE_PATH = '/repo/docs/reports/index.html'

const clipboard = vi.hoisted(() => ({ writes: [] as string[] }))

vi.mock('@/lib/doc-preview-grants', () => ({
  buildDocPreviewGrantRequest: () => ({
    owner: {
      kind: 'runtime' as const,
      environmentId: 'env-1',
      worktreeSelector: 'id:wt-1',
      worktreeRoot: '/repo'
    },
    root: '/repo',
    entryRelativePath: ENTRY_RELATIVE_PATH
  }),
  ensureDocPreviewGrant: () =>
    Promise.resolve({
      grantId: GRANT_ID,
      url: `orca-preview://${GRANT_ID}/${ENTRY_RELATIVE_PATH}`
    }),
  releaseDocPreviewGrant: () => undefined
}))

vi.mock('@/components/browser-pane/host-guest/webview-registry', () => ({
  moveFocusToRendererBeforeWebviewDetach: () => undefined
}))

// The real one walks half the store to decide who owns a worktree; the chip only cares that
// whatever it decides reaches the pill.
vi.mock('@/lib/execution-host-display-label', () => ({
  selectWorktreeHostDisplayLabel: () => 'Studio Mac mini'
}))

const storeState = {
  getKnownWorktreeById: () => ({ path: '/repo' }),
  persistedUIReady: true
}

vi.mock('@/store', () => ({
  useAppStore: Object.assign(
    (selector?: (state: typeof storeState) => unknown) =>
      selector ? selector(storeState) : storeState,
    { getState: () => storeState }
  )
}))

type StubWebview = Element & {
  canGoBack: () => boolean
  canGoForward: () => boolean
  goBack: () => void
  goForward: () => void
  reload: () => void
}

async function renderPreview(container: HTMLDivElement, root: Root): Promise<StubWebview> {
  const { HtmlDocPreview } = await import('./HtmlDocPreview')
  await act(async () => {
    root.render(
      <TooltipProvider>
        <HtmlDocPreview previewId="preview-1" filePath={ABSOLUTE_PATH} worktreeId="wt-1" />
      </TooltipProvider>
    )
  })
  const webview = container.querySelector('webview') as StubWebview | null
  expect(webview).not.toBeNull()
  return webview as StubWebview
}

function stubHistory(
  webview: StubWebview,
  depth: { canGoBack: boolean; canGoForward: boolean }
): { goBack: ReturnType<typeof vi.fn>; goForward: ReturnType<typeof vi.fn> } {
  const goBack = vi.fn()
  const goForward = vi.fn()
  webview.canGoBack = () => depth.canGoBack
  webview.canGoForward = () => depth.canGoForward
  webview.goBack = goBack
  webview.goForward = goForward
  webview.reload = vi.fn()
  return { goBack, goForward }
}

function button(container: HTMLDivElement, label: string): HTMLButtonElement {
  const element = container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)
  expect(element).not.toBeNull()
  return element as HTMLButtonElement
}

describe('HtmlDocPreview browser chrome', () => {
  let container: HTMLDivElement
  let root: Root
  let mounted = false

  beforeEach(() => {
    mounted = true
    clipboard.writes = []
    ;(window as unknown as { api: unknown }).api = {
      docPreview: { onLoadFailure: () => () => undefined },
      ui: {
        writeClipboardText: (text: string) => {
          clipboard.writes.push(text)
          return Promise.resolve()
        }
      }
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

  it('identifies the document by its workspace path and owning machine', async () => {
    await renderPreview(container, root)

    const text = container.textContent ?? ''
    expect(text).toContain('docs/reports/')
    expect(text).toContain('index.html')
    expect(text).toContain('Workspace file')
    expect(text).toContain('Studio Mac mini')
  })

  // The internal scheme is an implementation detail of how the workspace hands bytes to the guest.
  // The guest's own src attribute necessarily carries it; nothing the reader can read may.
  it('never shows the internal preview scheme to the reader', async () => {
    await renderPreview(container, root)

    expect(container.textContent).not.toContain('orca-preview')
    const toolbar = container.querySelector('[data-orca-doc-preview-toolbar]')
    expect(toolbar).not.toBeNull()
    expect(toolbar?.outerHTML).not.toContain('orca-preview')
  })

  it('copies the absolute path the owning machine spells, not the workspace-relative one', async () => {
    await renderPreview(container, root)

    await act(async () => {
      button(container, 'Copy file path').click()
    })

    expect(clipboard.writes).toEqual([ABSOLUTE_PATH])
    // The icon swap alone says nothing to a screen reader, so the control renames itself.
    expect(button(container, 'Copied')).not.toBeNull()
  })

  it('starts with both history controls disabled', async () => {
    await renderPreview(container, root)

    expect(button(container, 'Back').disabled).toBe(true)
    expect(button(container, 'Forward').disabled).toBe(true)
  })

  it('enables Back once the guest has somewhere to go back to and drives the guest', async () => {
    const webview = await renderPreview(container, root)
    const { goBack, goForward } = stubHistory(webview, { canGoBack: true, canGoForward: false })

    await act(async () => {
      webview.dispatchEvent(new Event('did-navigate'))
    })

    expect(button(container, 'Back').disabled).toBe(false)
    expect(button(container, 'Forward').disabled).toBe(true)

    await act(async () => {
      button(container, 'Back').click()
      button(container, 'Forward').click()
    })

    expect(goBack).toHaveBeenCalledTimes(1)
    // Why: a disabled edge control must be inert, not merely dimmed.
    expect(goForward).not.toHaveBeenCalled()
  })

  // Fragment links navigate in-document, which is still a history entry a reader expects Back to
  // unwind — the guest reports it on a different event than a full navigation.
  it('tracks in-document navigation as history too', async () => {
    const webview = await renderPreview(container, root)
    stubHistory(webview, { canGoBack: true, canGoForward: true })

    await act(async () => {
      webview.dispatchEvent(new Event('did-navigate-in-page'))
    })

    expect(button(container, 'Back').disabled).toBe(false)
    expect(button(container, 'Forward').disabled).toBe(false)
  })

  it('still reloads the guest in place from the toolbar', async () => {
    const webview = await renderPreview(container, root)
    stubHistory(webview, { canGoBack: false, canGoForward: false })

    await act(async () => {
      button(container, 'Reload preview').click()
    })

    expect(webview.reload).toHaveBeenCalledTimes(1)
  })
})
