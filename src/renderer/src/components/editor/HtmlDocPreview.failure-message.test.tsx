// @vitest-environment happy-dom
//
// The preview guest paints the handler's error body as if it were the document, so every
// unreadable outcome arrives out-of-band on the failure channel. These pin that each reason
// reaches the reader as its own sentence, and that a broken subresource cannot blank the page.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DocPreviewFailure } from '../../../../shared/doc-preview-scheme'

const GRANT_ID = 'a'.repeat(32)
const ENTRY_RELATIVE_PATH = 'doc.html'

vi.mock('@/lib/doc-preview-grants', () => ({
  buildDocPreviewGrantRequest: () => ({
    owner: {
      kind: 'runtime' as const,
      environmentId: 'env-1',
      worktreeSelector: 'id:wt-1',
      worktreeRoot: '/repo'
    },
    root: '/repo/docs',
    entryRelativePath: ENTRY_RELATIVE_PATH
  }),
  ensureDocPreviewGrant: () =>
    Promise.resolve({
      grantId: GRANT_ID,
      url: `orca-preview://${GRANT_ID}/${ENTRY_RELATIVE_PATH}`
    })
}))

vi.mock('@/components/browser-pane/host-guest/webview-registry', () => ({
  moveFocusToRendererBeforeWebviewDetach: () => undefined
}))

vi.mock('@/store', () => ({
  useAppStore: { getState: () => ({}) }
}))

const failureListeners: ((payload: DocPreviewFailure) => void)[] = []

function emitFailure(payload: DocPreviewFailure): void {
  for (const listener of failureListeners.slice()) {
    listener(payload)
  }
}

async function renderPreview(container: HTMLDivElement, root: Root): Promise<void> {
  const { HtmlDocPreview } = await import('./HtmlDocPreview')
  await act(async () => {
    root.render(
      <HtmlDocPreview previewId="preview-1" filePath="/repo/docs/doc.html" worktreeId="wt-1" />
    )
  })
  expect(container.querySelector('webview')).not.toBeNull()
}

describe('HtmlDocPreview failure messages', () => {
  let container: HTMLDivElement
  let root: Root
  let mounted = false

  beforeEach(() => {
    mounted = true
    failureListeners.length = 0
    ;(window as unknown as { api: unknown }).api = {
      docPreview: {
        onLoadFailure: (callback: (payload: DocPreviewFailure) => void) => {
          failureListeners.push(callback)
          return () => {
            const index = failureListeners.indexOf(callback)
            if (index !== -1) {
              failureListeners.splice(index, 1)
            }
          }
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

  it('tells the reader the document is too large instead of showing a bare failure', async () => {
    await renderPreview(container, root)

    await act(async () => {
      emitFailure({ grantId: GRANT_ID, relativePath: ENTRY_RELATIVE_PATH, reason: 'too-large' })
    })

    expect(container.textContent).toContain(
      'This document is too large to preview. Open it in the editor instead.'
    )
  })

  // Why: an old server declining an asset format is a server-version problem, not a broken file.
  it('names the server version when it will not serve an asset type', async () => {
    await renderPreview(container, root)

    await act(async () => {
      emitFailure({
        grantId: GRANT_ID,
        relativePath: ENTRY_RELATIVE_PATH,
        reason: 'unsupported-binary'
      })
    })

    expect(container.textContent).toContain(
      'This document needs a newer Orca server to render one of its assets.'
    )
    expect(container.textContent).not.toContain('too large')
  })

  it('falls back to the read failure for any other unreadable document', async () => {
    await renderPreview(container, root)

    await act(async () => {
      emitFailure({ grantId: GRANT_ID, relativePath: ENTRY_RELATIVE_PATH, reason: 'unreadable' })
    })

    expect(container.textContent).toContain('Orca could not read this file from the workspace.')
  })

  it('keeps rendering when a subresource fails, since the document itself arrived', async () => {
    await renderPreview(container, root)

    await act(async () => {
      emitFailure({ grantId: GRANT_ID, relativePath: 'assets/logo.png', reason: 'unreadable' })
    })

    expect(container.textContent).not.toContain('Preview unavailable')
  })

  it('ignores a failure minted for another preview tab', async () => {
    await renderPreview(container, root)

    await act(async () => {
      emitFailure({
        grantId: 'b'.repeat(32),
        relativePath: ENTRY_RELATIVE_PATH,
        reason: 'too-large'
      })
    })

    expect(container.textContent).not.toContain('Preview unavailable')
  })

  it('unsubscribes on unmount so a late failure cannot touch a torn-down preview', async () => {
    await renderPreview(container, root)
    expect(failureListeners).toHaveLength(1)

    await act(async () => {
      root.unmount()
      mounted = false
    })

    expect(failureListeners).toHaveLength(0)
  })
})
