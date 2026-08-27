import {
  DOC_PREVIEW_EXTERNAL_LINK_CHANNEL,
  parseDocPreviewUrl
} from '../../shared/doc-preview-scheme'
import { normalizeExternalBrowserUrl } from '../../shared/browser-url'
import { enforceBrowserRouteWebRtcPolicy } from './browser-route-webrtc-policy'
import { getDocPreviewGrant } from './doc-preview-grant-registry'

/** The trusted renderer hosting the preview: the sink for link reports and the only sender allowed to drive tools on it. */
type PreviewHostRenderer = {
  id: number
  send: (channel: string, payload: { url: string }) => void
}

type PreviewGuestRegistration = {
  host: PreviewHostRenderer
  readBoundGrantId: () => string | null
  isFocused: () => boolean
}

/**
 * Why a registry: the click report arrives on an IPC channel, where the only thing main holds is
 * the sender. Without this, "is this a live preview guest, and which grant is it bound to" has no
 * answer, and any WebContents that learned the channel name would be routed out.
 */
const previewGuests = new WeakMap<object, PreviewGuestRegistration>()

/**
 * The same guests, reachable by the grant they committed to. A preview joins no browser-page
 * registry, so this is the only way to answer "which contents renders grant X" for a tool request
 * the host renderer makes on the reader's behalf. Keyed by grant, not by tab: a grant dies with
 * the tab that minted it, so an entry can never outlive the surface the reader is looking at.
 */
const previewGuestsByGrantId = new Map<string, { guest: Electron.WebContents; hostId: number }>()

/**
 * Authorize a browser tool request against a preview guest. This grants the guest nothing — it
 * answers only whether the trusted renderer asking is the one hosting a live, grant-bound preview.
 * Deliberately separate from browser-page authorization: neither authority can resolve the
 * other's ids, so a preview never becomes a browser page and a browser page never becomes a preview.
 */
export function getAuthorizedDocPreviewGuest(
  grantId: string,
  senderWebContentsId: number
): Electron.WebContents | null {
  const registration = previewGuestsByGrantId.get(grantId)
  if (!registration || registration.hostId !== senderWebContentsId) {
    return null
  }
  // Why: revocation is how a closed tab withdraws its preview, and it happens before the guest is torn down.
  if (!getDocPreviewGrant(grantId)) {
    return null
  }
  if (registration.guest.isDestroyed()) {
    previewGuestsByGrantId.delete(grantId)
    return null
  }
  return registration.guest
}

/**
 * The preview guest renders a workspace document, not the web: it may only move within its own
 * grant, and nothing it does by itself leaves the preview. The one route out is
 * `reportDocPreviewLinkClick`, which answers for a click the reader really made.
 */
export function installDocPreviewGuestPolicy(
  guest: Electron.WebContents,
  host: PreviewHostRenderer
): void {
  // Why: the first commit is the renderer-set src, already admitted by will-attach-webview;
  // latching it pins every later navigation to that one grant.
  let boundGrantId: string | null = null

  previewGuests.set(guest, {
    host,
    readBoundGrantId: () => boundGrantId,
    isFocused: () => guest.isFocused()
  })
  guest.once('destroyed', () => {
    previewGuests.delete(guest)
    if (boundGrantId !== null && previewGuestsByGrantId.get(boundGrantId)?.guest === guest) {
      previewGuestsByGrantId.delete(boundGrantId)
    }
  })

  const isAllowedPreviewNavigation = (rawUrl: string): boolean => {
    const target = parseDocPreviewUrl(rawUrl)
    if (!target || !getDocPreviewGrant(target.grantId)) {
      return false
    }
    // Why the latch is required and not just consistent: the renderer-set src is browser-initiated,
    // so will-navigate never fires for it. Anything reaching here before the latch is the guest
    // moving itself, which no grant has admitted yet.
    return boundGrantId !== null && target.grantId === boundGrantId
  }

  /**
   * Why deny-only, with nothing routed: a navigation the guest starts cannot be attributed to the
   * reader. The document may read its whole grant over `connect-src 'self'`, so routing an
   * unattributable URL to a real browser tab with full network is how those bytes would get out.
   */
  const navigationGuard = (event: Electron.Event, url: string): void => {
    if (isAllowedPreviewNavigation(url)) {
      return
    }
    event.preventDefault()
  }

  guest.on('did-start-navigation', (details) => {
    // Why: only the top document defines which grant this guest belongs to. Latching from a
    // subframe would let an in-document iframe rebind the guest to another grant.
    if (boundGrantId !== null || !details.isMainFrame) {
      return
    }
    boundGrantId = parseDocPreviewUrl(details.url)?.grantId ?? null
    if (boundGrantId !== null) {
      previewGuestsByGrantId.set(boundGrantId, { guest, hostId: host.id })
    }
  })
  guest.on('will-navigate', navigationGuard)
  guest.on('will-redirect', navigationGuard)
  // Why: will-navigate never fires for a subframe, so without this an <iframe src="https://…">
  // inside a previewed document would load off-machine even though the top frame cannot.
  guest.on('will-frame-navigate', (details) => {
    if (details.isMainFrame || isAllowedPreviewNavigation(details.url)) {
      return
    }
    details.preventDefault()
  })
  // Why deny with nothing routed: previews own no native child windows, and a popup the document
  // asked for is the document asking, not the reader. A link the reader presses is intercepted
  // before Chromium ever considers a popup.
  guest.setWindowOpenHandler(() => ({ action: 'deny' }))
  // Why a second fence for one API: WebRTC opens UDP straight from the network stack, so neither the
  // response CSP nor the session's request filter ever sees it. This is the only layer that can.
  enforceBrowserRouteWebRtcPolicy(guest, () => {})
}

function isWebUrl(url: string): boolean {
  return url.startsWith('http://') || url.startsWith('https://')
}

/**
 * The only way a URL leaves a preview. Every condition is load-bearing: the sender must be a live
 * preview guest still bound to a grant, it must be the contents the reader is looking at, and the
 * target must be the web. Anything else is dropped without a trace the document could observe.
 */
export function reportDocPreviewLinkClick(sender: Electron.WebContents, rawUrl: string): void {
  const registration = previewGuests.get(sender)
  if (!registration) {
    return
  }
  const boundGrantId = registration.readBoundGrantId()
  if (boundGrantId === null || !getDocPreviewGrant(boundGrantId)) {
    return
  }
  // Why focus and not just the preload's trusted-click check: that check runs inside the guest, so
  // it holds only while the guest renderer does. Focus is the half main can verify for itself.
  if (!registration.isFocused()) {
    return
  }
  const externalUrl = normalizeExternalBrowserUrl(rawUrl)
  if (!externalUrl || !isWebUrl(externalUrl)) {
    return
  }
  registration.host.send(DOC_PREVIEW_EXTERNAL_LINK_CHANNEL, { url: externalUrl })
}
