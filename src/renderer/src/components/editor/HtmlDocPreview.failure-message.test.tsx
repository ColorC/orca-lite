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
const REMINTED_GRANT_ID = 'c'.repeat(32)
const ENTRY_RELATIVE_PATH = 'doc.html'

const grantRuntime = vi.hoisted(() => ({ mints: 0, released: [] as string[] }))

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
  ensureDocPreviewGrant: () => {
    grantRuntime.mints += 1
    // Why a fresh id per mint: a re-mint after a reconnect must bind the guest to the new grant.
    const grantId = grantRuntime.mints === 1 ? GRANT_ID : REMINTED_GRANT_ID
    return Promise.resolve({ grantId, url: `orca-preview://${grantId}/${ENTRY_RELATIVE_PATH}` })
  },
  releaseDocPreviewGrant: (previewId: string) => {
    grantRuntime.released.push(previewId)
  }
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
    grantRuntime.mints = 0
    grantRuntime.released = []
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

  // Why not "needs a newer server": SSH previews refuse fonts by design, at any server version.
  it('names the file type when the workspace will not send it', async () => {
    await renderPreview(container, root)

    await act(async () => {
      emitFailure({
        grantId: GRANT_ID,
        relativePath: ENTRY_RELATIVE_PATH,
        reason: 'unsupported-asset'
      })
    })

    expect(container.textContent).toContain(
      'This workspace cannot send this file type to a preview.'
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

  // Why: a grant is pinned to the owner ids it was minted with, so after a pairing or SSH
  // reconnect reloading the guest would just refetch the same failure forever.
  it('re-mints the grant when reload is pressed from a failure', async () => {
    await renderPreview(container, root)
    await act(async () => {
      emitFailure({ grantId: GRANT_ID, relativePath: ENTRY_RELATIVE_PATH, reason: 'unreadable' })
    })
    expect(grantRuntime.mints).toBe(1)

    await act(async () => {
      container.querySelector<HTMLButtonElement>('button[aria-label="Reload preview"]')?.click()
    })

    expect(grantRuntime.released).toEqual(['preview-1'])
    expect(grantRuntime.mints).toBe(2)
    expect(container.querySelector('webview')?.getAttribute('src')).toContain(REMINTED_GRANT_ID)
    expect(container.textContent).not.toContain('Preview unavailable')
  })

  it('reloads the guest in place when the document is rendering fine', async () => {
    await renderPreview(container, root)

    await act(async () => {
      container.querySelector<HTMLButtonElement>('button[aria-label="Reload preview"]')?.click()
    })

    expect(grantRuntime.released).toEqual([])
    expect(grantRuntime.mints).toBe(1)
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
