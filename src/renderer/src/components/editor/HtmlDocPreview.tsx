import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AlertCircle, Loader2 } from 'lucide-react'
import {
  DOC_PREVIEW_PARTITION,
  type DocPreviewFailure,
  type DocPreviewFailureReason
} from '../../../../shared/doc-preview-scheme'
import { ORCA_BROWSER_GUEST_WEB_PREFERENCES_ATTRIBUTE } from '../../../../shared/browser-guest-web-preferences'
import { MarkupOverlay } from '@/components/browser-pane/annotate/MarkupOverlay'
import { useBrowserPageMarkupCapture } from '@/components/browser-pane/annotate/use-browser-page-markup-capture'
import { moveFocusToRendererBeforeWebviewDetach } from '@/components/browser-pane/host-guest/webview-registry'
import {
  buildDocPreviewGrantRequest,
  ensureDocPreviewGrant,
  releaseDocPreviewGrant
} from '@/lib/doc-preview-grants'
import { selectWorktreeHostDisplayLabel } from '@/lib/execution-host-display-label'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { buildDocPreviewDocumentIdentity } from './doc-preview-document-identity'
import { docPreviewAssetNotice, docPreviewFailureDetail } from './doc-preview-failure-messages'
import { useDocPreviewWebviewHistory } from './doc-preview-webview-history'
import { HtmlDocPreviewToolbar } from './html-doc-preview-toolbar'

type PreviewState = 'loading' | 'ready' | 'unavailable'

function attachDocPreviewWebview({
  container,
  url,
  ariaLabel,
  onLoadStarted,
  onLoadStopped,
  onLoadFailed,
  onNavigated
}: {
  container: HTMLDivElement
  url: string
  ariaLabel: string
  onLoadStarted: () => void
  onLoadStopped: () => void
  onLoadFailed: (event: Electron.DidFailLoadEvent) => void
  onNavigated: () => void
}): { webview: Electron.WebviewTag; detach: () => void; reload: () => void } {
  const webview = document.createElement('webview') as Electron.WebviewTag
  // Why no allowpopups: the guest's preload intercepts a trusted click on a link before Chromium
  // considers a popup at all, so target="_blank" needs no popup path and every one stays denied.
  webview.setAttribute('partition', DOC_PREVIEW_PARTITION)
  webview.setAttribute('webpreferences', ORCA_BROWSER_GUEST_WEB_PREFERENCES_ATTRIBUTE)
  webview.setAttribute('aria-label', ariaLabel)
  // Browsers paint an undeclared page canvas white; the guest is transparent, so without this the
  // editor's dark surface shows through and default black text becomes unreadable.
  webview.style.backgroundColor = '#fff'
  webview.style.display = 'flex'
  webview.style.width = '100%'
  webview.style.height = '100%'
  webview.style.border = 'none'
  webview.addEventListener('did-start-loading', onLoadStarted)
  webview.addEventListener('did-stop-loading', onLoadStopped)
  webview.addEventListener('did-fail-load', onLoadFailed)
  // Both: a link to a sibling document is a full navigation, a fragment link is an in-page one,
  // and only the pair together tracks what Back can actually return to.
  webview.addEventListener('did-navigate', onNavigated)
  webview.addEventListener('did-navigate-in-page', onNavigated)
  container.appendChild(webview)
  webview.setAttribute('src', url)

  return {
    webview,
    detach: () => {
      webview.removeEventListener('did-start-loading', onLoadStarted)
      webview.removeEventListener('did-stop-loading', onLoadStopped)
      webview.removeEventListener('did-fail-load', onLoadFailed)
      webview.removeEventListener('did-navigate', onNavigated)
      webview.removeEventListener('did-navigate-in-page', onNavigated)
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
  const containerRef = useRef<HTMLDivElement | null>(null)
  const webviewRef = useRef<Electron.WebviewTag | null>(null)
  const reloadRef = useRef<(() => void) | null>(null)
  const [state, setState] = useState<PreviewState>('loading')
  const [failureReason, setFailureReason] = useState<DocPreviewFailureReason | null>(null)
  const [assetFailures, setAssetFailures] = useState<DocPreviewFailure[]>([])
  const [remintCount, setRemintCount] = useState(0)

  const history = useDocPreviewWebviewHistory(webviewRef)
  const { sync: syncHistory, reset: resetHistory } = history
  const markup = useBrowserPageMarkupCapture(webviewRef, containerRef)

  const worktreeRoot = useAppStore((store) => store.getKnownWorktreeById(worktreeId)?.path ?? null)
  const hostLabel = useAppStore((store) => selectWorktreeHostDisplayLabel(store, worktreeId))
  const identity = useMemo(
    () => buildDocPreviewDocumentIdentity({ filePath, worktreeRoot, hostLabel }),
    [filePath, hostLabel, worktreeRoot]
  )

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
      // Why sync here too: a navigation's history entry is only committed once loading settles.
      syncHistory()
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
    resetHistory()
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
          onLoadFailed,
          onNavigated: syncHistory
        })
        detach = attached.detach
        reloadRef.current = attached.reload
        webviewRef.current = attached.webview
      })
      .catch(() => {
        if (!disposed) {
          setState('unavailable')
        }
      })

    return () => {
      disposed = true
      reloadRef.current = null
      webviewRef.current = null
      unsubscribeFailure?.()
      detach?.()
    }
  }, [filePath, previewId, remintCount, resetHistory, syncHistory, worktreeId])

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
      <HtmlDocPreviewToolbar
        identity={identity}
        history={history}
        loading={state === 'loading' && failureReason === null}
        onReload={handleReload}
        markupActive={markup.isActive}
        onToggleMarkup={() => (markup.isActive ? markup.cancel() : void markup.start())}
        // Nothing has painted yet on a loading or failed preview, so there is nothing to draw on.
        markupDisabled={state !== 'ready' || failureReason !== null}
      />
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
        {markup.isActive && markup.baseImage ? (
          <MarkupOverlay
            baseImage={markup.baseImage}
            busy={markup.state === 'composing'}
            onComplete={(input) => void markup.complete(input)}
            onCancel={markup.cancel}
          />
        ) : null}
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
