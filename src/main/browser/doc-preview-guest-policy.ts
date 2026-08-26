import {
  DOC_PREVIEW_EXTERNAL_LINK_CHANNEL,
  parseDocPreviewUrl
} from '../../shared/doc-preview-scheme'
import { normalizeExternalBrowserUrl } from '../../shared/browser-url'
import { getDocPreviewGrant } from './doc-preview-grant-registry'

type PreviewLinkSink = { send: (channel: string, payload: { url: string }) => void }

/**
 * The preview guest renders a workspace document, not the web: it may only move
 * within its own grant. External http(s) targets — plain clicks and
 * `target="_blank"` alike — leave as a new Orca browser tab through the normal
 * machinery instead of navigating the preview or spawning a native popup.
 */
export function installDocPreviewGuestPolicy(
  guest: Electron.WebContents,
  linkSink: PreviewLinkSink
): void {
  // Why: the first commit is the renderer-set src, already admitted by will-attach-webview;
  // latching it pins every later navigation to that one grant.
  let boundGrantId: string | null = null

  const openExternally = (rawUrl: string): void => {
    const externalUrl = normalizeExternalBrowserUrl(rawUrl)
    if (!externalUrl) {
      return
    }
    linkSink.send(DOC_PREVIEW_EXTERNAL_LINK_CHANNEL, { url: externalUrl })
  }

  const isAllowedPreviewNavigation = (rawUrl: string): boolean => {
    const target = parseDocPreviewUrl(rawUrl)
    if (!target || !getDocPreviewGrant(target.grantId)) {
      return false
    }
    return boundGrantId === null || target.grantId === boundGrantId
  }

  const navigationGuard = (event: Electron.Event, url: string): void => {
    if (isAllowedPreviewNavigation(url)) {
      return
    }
    event.preventDefault()
    openExternally(url)
  }

  guest.on('did-start-navigation', (_event, url) => {
    if (boundGrantId !== null) {
      return
    }
    boundGrantId = parseDocPreviewUrl(url)?.grantId ?? null
  })
  guest.on('will-navigate', navigationGuard)
  guest.on('will-redirect', navigationGuard)
  guest.setWindowOpenHandler(({ url }) => {
    openExternally(url)
    // Why: previews never own native child windows; every popup target becomes an Orca tab or nothing.
    return { action: 'deny' }
  })
}
