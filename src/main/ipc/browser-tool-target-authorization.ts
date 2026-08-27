import { parseDocPreviewToolTargetId } from '../../shared/doc-preview-scheme'
import { browserManager } from '../browser/browser-manager'
import { getAuthorizedDocPreviewGuest } from '../browser/doc-preview-guest-policy'

/**
 * Resolve the guest a browser tool (grab, hover describe, selection capture) should act on.
 *
 * Two authorities, chosen by the id's own namespace rather than tried in turn: a preview target
 * only ever reaches the preview registry, a browser page id only ever reaches the browser page
 * registry. A tool operates on a guest at the reader's initiative and grants it nothing, so
 * answering for previews here does not put them on any browser-page path.
 */
export function resolveBrowserToolTargetGuest(
  toolTargetId: string,
  senderWebContentsId: number
): Electron.WebContents | null {
  const grantId = parseDocPreviewToolTargetId(toolTargetId)
  if (grantId !== null) {
    return getAuthorizedDocPreviewGuest(grantId, senderWebContentsId)
  }
  return browserManager.getAuthorizedGuest(toolTargetId, senderWebContentsId)
}

/** True when the id names a preview surface, which owns no browser-page state to wait on or dispose. */
export function isDocPreviewToolTargetId(toolTargetId: string): boolean {
  return parseDocPreviewToolTargetId(toolTargetId) !== null
}
