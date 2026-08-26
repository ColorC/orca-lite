import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertCircle, Loader2, RotateCw } from 'lucide-react'
import {
  DOC_PREVIEW_PARTITION,
  type DocPreviewFailure,
  type DocPreviewFailureReason
} from '../../../../shared/doc-preview-scheme'
import { ORCA_BROWSER_GUEST_WEB_PREFERENCES_ATTRIBUTE } from '../../../../shared/browser-guest-web-preferences'
import { moveFocusToRendererBeforeWebviewDetach } from '@/components/browser-pane/host-guest/webview-registry'
import { Button } from '@/components/ui/button'
import {
  buildDocPreviewGrantRequest,
  ensureDocPreviewGrant,
  releaseDocPreviewGrant
} from '@/lib/doc-preview-grants'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'

type PreviewState = 'loading' | 'ready' | 'unavailable'

function docPreviewFailureDetail(reason: DocPreviewFailureReason | null): string {
  if (reason === 'too-large') {
    return translate(
      'auto.components.editor.HtmlDocPreview.documentTooLargePanel',
      'This document is too large to preview. Open it in the editor instead.'
    )
  }
  // Why no 'unsupported-asset' sentence here: the entry document is served as text by every owner
  // — only a subresource can be refused for its format, and that failure is a notice, not a panel.
  return translate(
    'auto.components.editor.HtmlDocPreview.documentUnreadablePanel',
    'Orca could not read this file from the workspace.'
  )
}

/**
 * Why a notice and not the failure panel: only the entry document's failure leaves the reader with
 * nothing to look at. A stylesheet, image or font the workspace would not send is a document that
 * rendered — degraded, and the reader deserves to know which piece is missing, but rendered.
 */
function docPreviewAssetNotice(failures: DocPreviewFailure[]): string | null {
  const [first] = failures
  if (!first) {
    return null
  }
  if (failures.length > 1) {
    return translate(
      'auto.components.editor.HtmlDocPreview.multipleAssetsFailedNotice',
      '{{count}} files in this document could not be loaded.',
      { count: failures.length }
    )
  }
  if (first.reason === 'too-large') {
    return translate(
      'auto.components.editor.HtmlDocPreview.assetTooLargeNotice',
      '{{path}} is too large to load in this preview.',
      { path: first.relativePath }
    )
  }
  if (first.reason === 'unsupported-asset') {
    return translate(
      'auto.components.editor.HtmlDocPreview.assetUnsupportedNotice',
      'This workspace cannot send {{path}} to a preview.',
      { path: first.relativePath }
    )
  }
  return translate(
    'auto.components.editor.HtmlDocPreview.assetUnreadableNotice',
    'Orca could not read {{path}} from the workspace.',
    { path: first.relativePath }
  )
}

function attachDocPreviewWebview({
  container,
  url,
  ariaLabel,
  onLoadStarted,
  onLoadStopped,
  onLoadFailed
}: {
  container: HTMLDivElement
  url: string
  ariaLabel: string
  onLoadStarted: () => void
  onLoadStopped: () => void
  onLoadFailed: (event: Electron.DidFailLoadEvent) => void
}): { detach: () => void; reload: () => void } {
  const webview = document.createElement('webview') as Electron.WebviewTag
  // Why no allowpopups: the guest's preload intercepts a trusted click on a link before Chromium
  // considers a popup at all, so target="_blank" needs no popup path and every one stays denied.
  webview.setAttribute('partition', DOC_PREVIEW_PARTITION)
  webview.setAttribute('webpreferences', ORCA_BROWSER_GUEST_WEB_PREFERENCES_ATTRIBUTE)
  webview.setAttribute('aria-label', ariaLabel)
  webview.style.display = 'flex'
  webview.style.width = '100%'
  webview.style.height = '100%'
  webview.style.border = 'none'
  webview.addEventListener('did-start-loading', onLoadStarted)
  webview.addEventListener('did-stop-loading', onLoadStopped)
  webview.addEventListener('did-fail-load', onLoadFailed)
  container.appendChild(webview)
  webview.setAttribute('src', url)

  return {
    detach: () => {
      webview.removeEventListener('did-start-loading', onLoadStarted)
      webview.removeEventListener('did-stop-loading', onLoadStopped)
      webview.removeEventListener('did-fail-load', onLoadFailed)
      moveFocusToRendererBeforeWebviewDetach(webview)
      webview.remove()
    },
    // Why: the protocol handler answers with no-store, so a reload re-reads the workspace disk.
    reload: () => {
      try {
        webview.reload()
      } catch {
        webview.setAttribute('src', url)
      }
    }
  }
}

export function HtmlDocPreview({
  previewId,
  filePath,
  worktreeId
}: {
  previewId: string
  filePath: string
  worktreeId: string
}): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const reloadRef = useRef<(() => void) | null>(null)
  const [state, setState] = useState<PreviewState>('loading')
  const [failureReason, setFailureReason] = useState<DocPreviewFailureReason | null>(null)
  const [assetFailures, setAssetFailures] = useState<DocPreviewFailure[]>([])
  const [remintCount, setRemintCount] = useState(0)

  useEffect(() => {
    let disposed = false
    let detach: (() => void) | undefined
    let loadFailed = false
    const onLoadStarted = (): void => {
      loadFailed = false
      setFailureReason(null)
      setAssetFailures([])
      setState('loading')
    }
    const onLoadStopped = (): void => {
      if (!loadFailed) {
        setState('ready')
      }
    }
    const onLoadFailed = (event: Electron.DidFailLoadEvent): void => {
      if (!event.isMainFrame || event.errorCode === -3) {
        return
      }
      loadFailed = true
      setState('unavailable')
    }

    setState('loading')
    setFailureReason(null)
    setAssetFailures([])
    const request = buildDocPreviewGrantRequest(useAppStore.getState(), worktreeId, filePath)
    if (!request) {
      setState('unavailable')
      return () => {
        disposed = true
      }
    }
    // Why: an unreadable document answers with a status the guest renders as text, so the reason
    // arrives out-of-band. Subscribe before minting so the entry document's failure cannot be missed.
    let boundGrantId: string | null = null
    const unsubscribeFailure = window.api.docPreview?.onLoadFailure?.((payload) => {
      if (disposed || payload.grantId !== boundGrantId) {
        return
      }
      if (payload.relativePath === request.entryRelativePath) {
        setFailureReason(payload.reason)
        return
      }
      setAssetFailures((current) =>
        current.some((failure) => failure.relativePath === payload.relativePath)
          ? current
          : [...current, payload]
      )
    })
    void ensureDocPreviewGrant(previewId, request)
      .then((handle) => {
        boundGrantId = handle.grantId
        if (disposed || !containerRef.current) {
          return
        }
        const attached = attachDocPreviewWebview({
          container: containerRef.current,
          url: handle.url,
          ariaLabel: translate(
            'auto.components.editor.HtmlDocPreview.previewAriaLabel',
            'HTML preview'
          ),
          onLoadStarted,
          onLoadStopped,
          onLoadFailed
        })
        detach = attached.detach
        reloadRef.current = attached.reload
      })
      .catch(() => {
        if (!disposed) {
          setState('unavailable')
        }
      })

    return () => {
      disposed = true
      reloadRef.current = null
      unsubscribeFailure?.()
      detach?.()
    }
  }, [filePath, previewId, remintCount, worktreeId])

  const handleReload = useCallback(() => {
    // Why: a grant is pinned to the owner ids resolved when it was minted, so after a pairing or
    // SSH reconnect the old one reads nothing and reloading the guest would just refetch the
    // failure. Drop it and mint against today's ids instead of making the user close the tab.
    if (failureReason !== null || state === 'unavailable') {
      releaseDocPreviewGrant(previewId)
      setRemintCount((count) => count + 1)
      return
    }
    reloadRef.current?.()
  }, [failureReason, previewId, state])

  const isUnavailable = state === 'unavailable' || failureReason !== null
  const assetNotice = isUnavailable ? null : docPreviewAssetNotice(assetFailures)

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-editor-surface">
      <div className="flex h-8 shrink-0 items-center justify-end gap-1 border-b px-2">
        <Button
          variant="ghost"
          size="icon"
          className="size-6"
          onClick={handleReload}
          aria-label={translate(
            'auto.components.editor.HtmlDocPreview.reloadPreviewControl',
            'Reload preview'
          )}
          title={translate(
            'auto.components.editor.HtmlDocPreview.reloadPreviewControl',
            'Reload preview'
          )}
        >
          <RotateCw className="size-3.5" />
        </Button>
      </div>
      {assetNotice ? (
        <div
          className="flex shrink-0 items-center gap-1.5 border-b px-2 py-1 text-xs text-muted-foreground"
          role="status"
          title={assetNotice}
        >
          <AlertCircle className="size-3.5 shrink-0" />
          <span className="min-w-0 flex-1 truncate">{assetNotice}</span>
        </div>
      ) : null}
      <div className="relative flex min-h-0 flex-1 overflow-hidden" ref={containerRef}>
        {state === 'loading' && failureReason === null ? (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-editor-surface">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : null}
        {isUnavailable ? (
          <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 bg-editor-surface px-6 text-center">
            <AlertCircle className="size-6 text-muted-foreground" />
            <p className="text-sm font-medium">
              {translate(
                'auto.components.editor.HtmlDocPreview.previewUnavailableTitle',
                'Preview unavailable'
              )}
            </p>
            <p className="max-w-sm text-xs text-muted-foreground">
              {docPreviewFailureDetail(failureReason)}
            </p>
          </div>
        ) : null}
      </div>
    </div>
  )
}
