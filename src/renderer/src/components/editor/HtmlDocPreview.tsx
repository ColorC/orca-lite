import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertCircle, Loader2, RotateCw } from 'lucide-react'
import {
  DOC_PREVIEW_PARTITION,
  type DocPreviewFailureReason
} from '../../../../shared/doc-preview-scheme'
import { ORCA_BROWSER_GUEST_WEB_PREFERENCES_ATTRIBUTE } from '../../../../shared/browser-guest-web-preferences'
import { moveFocusToRendererBeforeWebviewDetach } from '@/components/browser-pane/host-guest/webview-registry'
import { Button } from '@/components/ui/button'
import { buildDocPreviewGrantRequest, ensureDocPreviewGrant } from '@/lib/doc-preview-grants'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'

type PreviewState = 'loading' | 'ready' | 'unavailable'

function docPreviewFailureDetail(reason: DocPreviewFailureReason | null): string {
  if (reason === 'too-large') {
    return translate(
      'auto.components.editor.HtmlDocPreview.4e17b0c8da',
      'This document is too large to preview. Open it in the editor instead.'
    )
  }
  if (reason === 'unsupported-binary') {
    return translate(
      'auto.components.editor.HtmlDocPreview.2b6ad4f019',
      'This document needs a newer Orca server to render one of its assets.'
    )
  }
  return translate(
    'auto.components.editor.HtmlDocPreview.b93a6f1e75',
    'Orca could not read this file from the workspace.'
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

  useEffect(() => {
    let disposed = false
    let detach: (() => void) | undefined
    let loadFailed = false
    const onLoadStarted = (): void => {
      loadFailed = false
      setFailureReason(null)
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
      if (
        disposed ||
        payload.grantId !== boundGrantId ||
        payload.relativePath !== request.entryRelativePath
      ) {
        return
      }
      setFailureReason(payload.reason)
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
          ariaLabel: translate('auto.components.editor.HtmlDocPreview.a1f0c3d29b', 'HTML preview'),
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
  }, [filePath, previewId, worktreeId])

  const handleReload = useCallback(() => {
    reloadRef.current?.()
  }, [])

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-editor-surface">
      <div className="flex h-8 shrink-0 items-center justify-end gap-1 border-b px-2">
        <Button
          variant="ghost"
          size="icon"
          className="size-6"
          onClick={handleReload}
          aria-label={translate(
            'auto.components.editor.HtmlDocPreview.5c8b7e41a0',
            'Reload preview'
          )}
          title={translate('auto.components.editor.HtmlDocPreview.5c8b7e41a0', 'Reload preview')}
        >
          <RotateCw className="size-3.5" />
        </Button>
      </div>
      <div className="relative flex min-h-0 flex-1 overflow-hidden" ref={containerRef}>
        {state === 'loading' && failureReason === null ? (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-editor-surface">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : null}
        {state === 'unavailable' || failureReason !== null ? (
          <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 bg-editor-surface px-6 text-center">
            <AlertCircle className="size-6 text-muted-foreground" />
            <p className="text-sm font-medium">
              {translate('auto.components.editor.HtmlDocPreview.7d2e90b6c4', 'Preview unavailable')}
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
