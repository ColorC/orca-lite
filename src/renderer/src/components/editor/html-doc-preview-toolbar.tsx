import { ArrowLeft, ArrowRight, Loader2, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { MarkupDrawButton } from '@/components/browser-pane/annotate/MarkupDrawButton'
import { translate } from '@/i18n/i18n'
import { DocPreviewDocumentChip } from './doc-preview-document-chip'
import type { DocPreviewDocumentIdentity } from './doc-preview-document-identity'
import type { DocPreviewHistory } from './doc-preview-webview-history'

/**
 * The preview's browser chrome. Deliberately the same shape as BrowserNavigationControlRow, but
 * not that component: it is built around an editable address bar, and this surface must not offer
 * one — the reader can only ever be looking at a document the workspace already granted.
 */
export function HtmlDocPreviewToolbar({
  identity,
  history,
  loading,
  onReload,
  markupActive,
  onToggleMarkup,
  markupDisabled
}: {
  identity: DocPreviewDocumentIdentity
  history: DocPreviewHistory
  loading: boolean
  onReload: () => void
  markupActive: boolean
  onToggleMarkup: () => void
  markupDisabled: boolean
}): React.JSX.Element {
  const reloadLabel = translate(
    'auto.components.editor.HtmlDocPreview.reloadPreviewControl',
    'Reload preview'
  )

  return (
    <div
      data-orca-doc-preview-toolbar="true"
      className="relative z-10 flex shrink-0 items-center gap-2 border-b border-border/70 bg-background/95 px-3 py-1.5"
    >
      <Button
        size="icon"
        variant="ghost"
        className="h-7 w-7"
        onClick={history.goBack}
        disabled={!history.canGoBack}
        aria-label={translate('browser.navigation.back', 'Back')}
      >
        <ArrowLeft className="size-4" />
      </Button>
      <Button
        size="icon"
        variant="ghost"
        className="h-7 w-7"
        onClick={history.goForward}
        disabled={!history.canGoForward}
        aria-label={translate('browser.navigation.forward', 'Forward')}
      >
        <ArrowRight className="size-4" />
      </Button>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            size="icon"
            variant="ghost"
            className="h-7 w-7"
            onClick={onReload}
            aria-label={reloadLabel}
          >
            {loading ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <RefreshCw className="size-4" />
            )}
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom" sideOffset={4}>
          {reloadLabel}
        </TooltipContent>
      </Tooltip>

      <DocPreviewDocumentChip identity={identity} />

      <MarkupDrawButton
        onClick={onToggleMarkup}
        disabled={markupDisabled}
        active={markupActive}
        // Why false: the preview tab has no isActive of its own, and an inactive editor pane must
        // not force-open the discovery popover against a zero-size trigger.
        surfaceActive={false}
        className="h-7 w-7"
      />
    </div>
  )
}
