// @vitest-environment happy-dom
//
// Two ids run through this hook and they are not interchangeable. Annotations belong to the preview
// tab and have to survive a re-mint; the guest a tool acts on is named by the grant currently on
// screen, which a re-mint replaces. Swapping them is invisible until a preview re-mints.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { createElement, useRef } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const calls = vi.hoisted(() => ({
  annotationSend: [] as { browserTabId: string }[],
  grabAnnotations: [] as { browserTabId: string; toolTargetId: string }[],
  grabMode: [] as string[],
  viewportBridge: [] as { toolTargetId: string }[]
}))

vi.mock('@/components/browser-pane/annotate/use-browser-page-annotation-send', () => ({
  useBrowserPageAnnotationSend: (args: { browserTabId: string }) => {
    calls.annotationSend.push({ browserTabId: args.browserTabId })
    return { browserAnnotations: [], setBrowserAnnotationTrayOpen: () => undefined }
  }
}))

vi.mock('@/components/browser-pane/annotate/use-browser-page-grab-annotations', () => ({
  useBrowserPageGrabAnnotations: (args: { browserTabId: string; toolTargetId: string }) => {
    calls.grabAnnotations.push({
      browserTabId: args.browserTabId,
      toolTargetId: args.toolTargetId
    })
    return { pendingAnnotationPayload: null, grabIntent: null, startGrabIntent: () => undefined }
  }
}))

vi.mock('@/components/browser-pane/annotate/use-browser-page-markup-capture', () => ({
  useBrowserPageMarkupCapture: () => ({ isActive: false })
}))

vi.mock('@/components/browser-pane/annotate/useGrabMode', () => ({
  useGrabMode: (toolTargetId: string) => {
    calls.grabMode.push(toolTargetId)
    return { state: 'idle' }
  }
}))

vi.mock('@/components/browser-pane/annotate/guest-annotation-viewport-bridge', () => ({
  syncGuestAnnotationViewportBridge: (args: { toolTargetId: string }) => {
    calls.viewportBridge.push({ toolTargetId: args.toolTargetId })
  }
}))

vi.mock('@/hooks/useShortcutLabel', () => ({ useShortcutLabel: () => 'G' }))

import { useDocPreviewGuestTools } from './use-doc-preview-guest-tools'

const PREVIEW_ID = 'html-preview::wt-1::/root/demo/report/index.html'
const FIRST_GRANT = 'a'.repeat(32)
const SECOND_GRANT = 'b'.repeat(32)

function Harness({ grantId }: { grantId: string | null }): null {
  const webviewRef = useRef(null)
  const containerRef = useRef(null)
  useDocPreviewGuestTools({
    previewId: PREVIEW_ID,
    worktreeId: 'wt-1',
    grantId,
    webviewRef: webviewRef as never,
    containerRef: containerRef as never,
    toolsReady: true
  })
  return null
}

let container: HTMLDivElement
let root: Root

function render(grantId: string | null): void {
  act(() => {
    root.render(createElement(Harness, { grantId }))
  })
}

beforeEach(() => {
  calls.annotationSend.length = 0
  calls.grabAnnotations.length = 0
  calls.grabMode.length = 0
  calls.viewportBridge.length = 0
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('useDocPreviewGuestTools ids', () => {
  it('scopes annotations to the preview tab and tools to the grant on screen', () => {
    render(FIRST_GRANT)

    expect(calls.annotationSend.at(-1)?.browserTabId).toBe(PREVIEW_ID)
    expect(calls.grabAnnotations.at(-1)?.browserTabId).toBe(PREVIEW_ID)
    expect(calls.grabAnnotations.at(-1)?.toolTargetId).toBe(`doc-preview-grant:${FIRST_GRANT}`)
    expect(calls.grabMode.at(-1)).toBe(`doc-preview-grant:${FIRST_GRANT}`)
  })

  // The failure a swap would cause: a hard reload mints a new grant, and annotations keyed by the
  // tool target would be orphaned under an id nothing reads again.
  it('keeps the annotation key across a re-mint while the tool target follows the new grant', () => {
    render(FIRST_GRANT)
    render(SECOND_GRANT)

    expect(new Set(calls.annotationSend.map((call) => call.browserTabId))).toEqual(
      new Set([PREVIEW_ID])
    )
    expect(new Set(calls.grabAnnotations.map((call) => call.browserTabId))).toEqual(
      new Set([PREVIEW_ID])
    )
    expect(calls.grabAnnotations.at(-1)?.toolTargetId).toBe(`doc-preview-grant:${SECOND_GRANT}`)
    expect(calls.viewportBridge.at(-1)?.toolTargetId).toBe(`doc-preview-grant:${SECOND_GRANT}`)
  })

  // Why an empty target and not the preview id: an id main cannot resolve has to be refused there,
  // and a preview id reaching the tool channels would be a browser-page lookup for a preview.
  it('names no tool target before a grant exists', () => {
    render(null)

    expect(calls.grabMode.at(-1)).toBe('')
    expect(calls.grabAnnotations.at(-1)?.toolTargetId).toBe('')
    expect(calls.viewportBridge).toHaveLength(0)
  })
})
