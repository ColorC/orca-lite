import type { BrowserPageConversionOrigin } from '../../../shared/browser-workspace-types'
import { convertBrowserPageToWorkspaceDoc } from '@/lib/file-preview'
import { useAppStore } from '@/store'

/**
 * Back's one-level return across an address-bar conversion: with no guest history left to go back
 * through, a page that was converted returns to what it was converted from. The return leg records
 * no provenance of its own — arriving back consumes it, so Back cannot ping-pong.
 */
export function returnAcrossBrowserPageConversion(
  pageId: string,
  origin: BrowserPageConversionOrigin
): void {
  if (origin.kind === 'workspace-doc') {
    convertBrowserPageToWorkspaceDoc(pageId, origin.docLocation, { recordProvenance: false })
    return
  }
  useAppStore
    .getState()
    .convertBrowserPage(pageId, { kind: 'web', url: origin.url }, { recordProvenance: false })
}
