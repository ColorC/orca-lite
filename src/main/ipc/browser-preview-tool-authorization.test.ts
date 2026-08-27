import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as DocPreviewGuestPolicyModule from '../browser/doc-preview-guest-policy'
import type * as TabRegistrationWaitModule from './browser-tab-registration-wait'

const {
  handleMock,
  removeHandlerMock,
  getAuthorizedGuestMock,
  setGrabModeMock,
  awaitGrabSelectionMock,
  cancelGrabOpMock,
  captureSelectionScreenshotMock,
  extractHoverPayloadMock,
  setAnnotationViewportBridgeMock,
  openDevToolsMock,
  setViewportOverrideMock,
  previewAuthoritySpy,
  registrationWaitSpy
} = vi.hoisted(() => ({
  handleMock: vi.fn(),
  removeHandlerMock: vi.fn(),
  getAuthorizedGuestMock: vi.fn(),
  setGrabModeMock: vi.fn().mockResolvedValue(true),
  awaitGrabSelectionMock: vi.fn().mockResolvedValue({ opId: 'op', kind: 'cancelled' }),
  cancelGrabOpMock: vi.fn(),
  captureSelectionScreenshotMock: vi.fn().mockResolvedValue(null),
  extractHoverPayloadMock: vi.fn().mockResolvedValue(null),
  setAnnotationViewportBridgeMock: vi.fn().mockResolvedValue(true),
  openDevToolsMock: vi.fn().mockResolvedValue(true),
  setViewportOverrideMock: vi.fn().mockResolvedValue(true),
  previewAuthoritySpy: vi.fn(),
  registrationWaitSpy: vi.fn()
}))

vi.mock('electron', () => ({
  BrowserWindow: { fromWebContents: vi.fn() },
  ipcMain: { removeHandler: removeHandlerMock, handle: handleMock },
  webContents: { fromId: vi.fn(() => ({ isDestroyed: () => false })) }
}))

vi.mock('../browser/browser-manager', () => ({
  browserCertificateTrustController: { proceed: vi.fn(() => ({ ok: true })) },
  browserManager: {
    registerGuest: vi.fn(() => true),
    attachGuestPolicies: vi.fn(),
    unregisterGuest: vi.fn(),
    getGuestWebContentsId: vi.fn(),
    getWebContentsIdByTabId: vi.fn(() => new Map()),
    getWorktreeIdForTab: vi.fn(),
    getAuthorizedGuest: getAuthorizedGuestMock,
    setGrabMode: setGrabModeMock,
    awaitGrabSelection: awaitGrabSelectionMock,
    cancelGrabOp: cancelGrabOpMock,
    captureSelectionScreenshot: captureSelectionScreenshotMock,
    extractHoverPayload: extractHoverPayloadMock,
    setAnnotationViewportBridge: setAnnotationViewportBridgeMock,
    openDevTools: openDevToolsMock,
    setViewportOverride: setViewportOverrideMock,
    cancelDownload: vi.fn()
  }
}))

// Why the real policy module behind a spy: the point of these tests is that the preview authority
// is the one answering, so a stub of it would prove nothing about which registry was consulted.
vi.mock('../browser/doc-preview-guest-policy', async (importOriginal) => {
  const actual = await importOriginal<typeof DocPreviewGuestPolicyModule>()
  return {
    ...actual,
    getAuthorizedDocPreviewGuest: (grantId: string, senderWebContentsId: number) => {
      previewAuthoritySpy(grantId, senderWebContentsId)
      return actual.getAuthorizedDocPreviewGuest(grantId, senderWebContentsId)
    }
  }
})

// Why spy rather than stub: the wait is real machinery the browser-page path still depends on;
// only whether a preview target enters it is under test.
vi.mock('./browser-tab-registration-wait', async (importOriginal) => {
  const actual = await importOriginal<typeof TabRegistrationWaitModule>()
  return {
    ...actual,
    waitForNextTabRegistration: (...args: Parameters<typeof actual.waitForNextTabRegistration>) => {
      registrationWaitSpy(args[0])
      return actual.waitForNextTabRegistration(...args)
    }
  }
})

import { registerBrowserHandlers } from './browser'
import { browserManager } from '../browser/browser-manager'
import { installDocPreviewGuestPolicy } from '../browser/doc-preview-guest-policy'
import {
  mintDocPreviewGrant,
  revokeAllDocPreviewGrants,
  revokeDocPreviewGrant
} from '../browser/doc-preview-grant-registry'
import { buildDocPreviewUrl, toDocPreviewToolTargetId } from '../../shared/doc-preview-scheme'

const HOST_RENDERER_ID = 91
const OTHER_RENDERER_ID = 92

/**
 * Every `browser:*` invoke channel, split by whether it acts on a guest the reader is looking at
 * (a tool) or manages browser-page, session and profile state. The split is asserted to be total,
 * so a new channel cannot be added without deciding which side of the preview seam it belongs on.
 */
const TOOL_CHANNELS = [
  'browser:setGrabMode',
  'browser:awaitGrabSelection',
  'browser:cancelGrab',
  'browser:captureSelectionScreenshot',
  'browser:extractHoverPayload',
  'browser:setAnnotationViewportBridge'
]

const BROWSER_PAGE_CHANNELS = [
  'browser:registerGuest',
  'browser:prepareSshWorkspacePartition',
  'browser:repairGuestRegistration',
  'browser:isGuestRegistered',
  'browser:unregisterGuest',
  'browser:respondWebAuthnAccount',
  'browser:proceedCertificate',
  'browser:activeTabChanged',
  'browser:openDevTools',
  'browser:setViewportOverride',
  'browser:publishClientPageMetadata',
  'browser:cancelDownload',
  'browser:session:listProfiles',
  'browser:session:createProfile',
  'browser:session:deleteProfile',
  'browser:session:importCookies',
  'browser:session:resolvePartition',
  'browser:session:clearDefaultCookies',
  'browser:session:importFromBrowserForClientHost',
  'browser:session:clientRouteImportSources',
  'browser:session:detectBrowsers',
  'browser:session:detectBrowsersForClientHost',
  'browser:session:importFromBrowser'
]

type Handler = (event: { sender: Electron.WebContents }, args: unknown) => unknown

function registeredHandlers(): Map<string, Handler> {
  const handlers = new Map<string, Handler>()
  for (const [channel, handler] of handleMock.mock.calls as [string, Handler][]) {
    handlers.set(channel, handler)
  }
  return handlers
}

function trustedSender(id: number): { sender: Electron.WebContents } {
  return {
    sender: {
      id,
      isDestroyed: () => false,
      getType: () => 'window',
      getURL: () => 'file:///renderer/index.html'
    } as unknown as Electron.WebContents
  }
}

/** A preview guest already showing its document, which is the only state a tool can act in. */
function liveRenderedPreview(hostId: number = HOST_RENDERER_ID): {
  grantId: string
  toolTargetId: string
  contents: object
  markContentsDestroyed: () => void
} {
  const grant = mintDocPreviewGrant({
    owner: { kind: 'ssh', connectionId: 'ssh-1' },
    root: '/home/alice/docs',
    entryRelativePath: 'index.html'
  })
  const handlers: Record<string, (...args: never[]) => void> = {}
  const register = (event: string, handler: (...args: never[]) => void): void => {
    handlers[event] = handler
  }
  // Why the guest already reports its URL: the embedder hands a preview over mid-load, so this is
  // the state the policy really installs into.
  const documentUrl = buildDocPreviewUrl(grant.id, 'index.html')
  let contentsDestroyed = false
  const guest = {
    isFocused: () => true,
    isDestroyed: () => contentsDestroyed,
    getURL: () => documentUrl,
    on: vi.fn(register),
    once: vi.fn(register),
    setWindowOpenHandler: vi.fn(),
    setWebRTCIPHandlingPolicy: vi.fn()
  }
  installDocPreviewGuestPolicy(guest as never, { id: hostId, send: vi.fn() })
  handlers['did-start-navigation']?.({ url: documentUrl, isMainFrame: true } as never)
  return {
    grantId: grant.id,
    toolTargetId: toDocPreviewToolTargetId(grant.id),
    contents: guest,
    // Why without the `destroyed` event: Chromium tears the contents down before main runs that
    // listener, so this is the window the authority has to answer for on its own.
    markContentsDestroyed: () => {
      contentsDestroyed = true
    }
  }
}

/** Minimal well-formed args per channel, so a refusal is authorization and not shape validation. */
function toolArgs(channel: string, toolTargetId: string): Record<string, unknown> {
  switch (channel) {
    case 'browser:setGrabMode':
      return { browserPageId: toolTargetId, enabled: true }
    case 'browser:awaitGrabSelection':
      return { browserPageId: toolTargetId, opId: 'op-1' }
    case 'browser:captureSelectionScreenshot':
      return { browserPageId: toolTargetId, rect: { x: 0, y: 0, width: 10, height: 10 } }
    case 'browser:setAnnotationViewportBridge':
      return {
        browserPageId: toolTargetId,
        enabled: true,
        emitViewport: true,
        markers: [],
        token: 'annotation-bridge-token-1'
      }
    default:
      return { browserPageId: toolTargetId }
  }
}

/** The viewport bridge is handed a resolver rather than the contents, so unwrap one call argument. */
function resolvesToGuest(argument: unknown, guest: object): boolean {
  return argument === guest || (typeof argument === 'function' && argument() === guest)
}

const GUEST_RECEIVING_MOCKS = [
  setGrabModeMock,
  awaitGrabSelectionMock,
  captureSelectionScreenshotMock,
  extractHoverPayloadMock,
  setAnnotationViewportBridgeMock
]

beforeEach(() => {
  vi.stubEnv('ELECTRON_RENDERER_URL', '')
  // Why before clearing: revoking the previous test's grants disposes their tool-target state
  // through the mocked manager, and those calls belong to that test, not this one.
  revokeAllDocPreviewGrants()
  vi.clearAllMocks()
  getAuthorizedGuestMock.mockReturnValue(null)
  setGrabModeMock.mockResolvedValue(true)
  awaitGrabSelectionMock.mockResolvedValue({ opId: 'op-1', kind: 'cancelled' })
  captureSelectionScreenshotMock.mockResolvedValue(null)
  extractHoverPayloadMock.mockResolvedValue(null)
  setAnnotationViewportBridgeMock.mockResolvedValue(true)
  registerBrowserHandlers()
})

describe('doc preview tool authorization', () => {
  it('classifies every registered browser channel as a tool or a browser-page channel', () => {
    const registered = [...registeredHandlers().keys()].sort()
    const classified = [...TOOL_CHANNELS, ...BROWSER_PAGE_CHANNELS].sort()

    expect(registered).toEqual(classified)
  })

  it.each(TOOL_CHANNELS)('drives the preview guest from %s', async (channel) => {
    const preview = liveRenderedPreview()
    const handler = registeredHandlers().get(channel)

    await handler?.(trustedSender(HOST_RENDERER_ID), toolArgs(channel, preview.toolTargetId))

    // Why assert on the guest and not on a return value: the whole point of the seam is which
    // WebContents the tool ends up acting on.
    const receivedGuest = GUEST_RECEIVING_MOCKS.some((mock) =>
      mock.mock.calls.some((args) => args.some((arg) => resolvesToGuest(arg, preview.contents)))
    )
    expect(receivedGuest || cancelGrabOpMock.mock.calls.length > 0).toBe(true)
    expect(getAuthorizedGuestMock).not.toHaveBeenCalled()
  })

  // The load-bearing containment claim: page/session management never reaches the preview registry,
  // so a preview can never be resolved as, or managed like, a browser page.
  it.each(BROWSER_PAGE_CHANNELS)(
    'never consults the preview authority from %s',
    async (channel) => {
      const preview = liveRenderedPreview()
      const handler = registeredHandlers().get(channel)

      try {
        await handler?.(trustedSender(HOST_RENDERER_ID), {
          browserPageId: preview.toolTargetId,
          profileId: preview.toolTargetId,
          environmentId: preview.toolTargetId
        })
      } catch {
        // A malformed-for-this-channel payload may throw; the claim is about which registry was read.
      }

      expect(previewAuthoritySpy).not.toHaveBeenCalled()
    }
  )

  it.each(TOOL_CHANNELS)(
    'refuses %s from a renderer that does not host the preview',
    async (channel) => {
      const preview = liveRenderedPreview()
      const handler = registeredHandlers().get(channel)

      await handler?.(trustedSender(OTHER_RENDERER_ID), toolArgs(channel, preview.toolTargetId))

      for (const mock of [...GUEST_RECEIVING_MOCKS, cancelGrabOpMock]) {
        expect(mock).not.toHaveBeenCalled()
      }
    }
  )

  it.each(TOOL_CHANNELS)('refuses %s for a target no preview rendered', async (channel) => {
    const unrenderedTarget = toDocPreviewToolTargetId('a'.repeat(32))
    const handler = registeredHandlers().get(channel)

    await handler?.(trustedSender(HOST_RENDERER_ID), toolArgs(channel, unrenderedTarget))

    for (const mock of [...GUEST_RECEIVING_MOCKS, cancelGrabOpMock]) {
      expect(mock).not.toHaveBeenCalled()
    }
    expect(getAuthorizedGuestMock).not.toHaveBeenCalled()
  })

  // Why the contents check has to be its own condition: the grant is still live and the sender is
  // still the host, so nothing else in the authority notices that the guest is gone.
  it.each(TOOL_CHANNELS)('refuses %s once the preview contents are destroyed', async (channel) => {
    const preview = liveRenderedPreview()
    preview.markContentsDestroyed()
    const handler = registeredHandlers().get(channel)

    await handler?.(trustedSender(HOST_RENDERER_ID), toolArgs(channel, preview.toolTargetId))

    for (const mock of [...GUEST_RECEIVING_MOCKS, cancelGrabOpMock]) {
      expect(mock).not.toHaveBeenCalled()
    }
  })

  // Why: that wait exists for a browser tab whose registration is still in flight. A preview never
  // registers as a tab, so entering it would spend the whole timeout on an event that cannot come.
  it('does not wait for a tab registration a preview will never make', async () => {
    const unrenderedTarget = toDocPreviewToolTargetId('a'.repeat(32))
    const handler = registeredHandlers().get('browser:setGrabMode')

    await expect(
      handler?.(trustedSender(HOST_RENDERER_ID), { browserPageId: unrenderedTarget, enabled: true })
    ).resolves.toEqual({ ok: false, reason: 'not-ready' })

    expect(registrationWaitSpy).not.toHaveBeenCalled()
  })

  it('still waits for a browser page whose registration may be in flight', async () => {
    const handler = registeredHandlers().get('browser:setGrabMode')

    await handler?.(trustedSender(HOST_RENDERER_ID), {
      browserPageId: 'browser-page-1',
      enabled: true
    })

    expect(registrationWaitSpy).toHaveBeenCalledWith('browser-page-1')
  })

  // Why the grant and not the guest: a preview withdraws by revoking, which is also what a
  // re-mint does, and nothing else tells main that this tool target will never be used again.
  it('disposes the grab state a preview target accumulated when its grant is revoked', async () => {
    const preview = liveRenderedPreview()
    const handler = registeredHandlers().get('browser:setGrabMode')
    await handler?.(trustedSender(HOST_RENDERER_ID), {
      browserPageId: preview.toolTargetId,
      enabled: true
    })
    cancelGrabOpMock.mockClear()

    revokeDocPreviewGrant(preview.grantId)

    expect(cancelGrabOpMock).toHaveBeenCalledWith(preview.toolTargetId, 'evicted')
  })

  // Why both halves of this door: the manager refuses a preview id on its own, but the grab
  // disposal beside it takes a renderer-supplied id, and the intent it drops is compared by
  // identity — dropping it makes the grab settle ok without ever arming the guest.
  it('leaves an in-flight preview grab armed when unregisterGuest names its target', async () => {
    const preview = liveRenderedPreview()
    const handlers = registeredHandlers()
    const pending = handlers.get('browser:setGrabMode')?.(trustedSender(HOST_RENDERER_ID), {
      browserPageId: preview.toolTargetId,
      enabled: true
    })

    // Why synchronously here: the intent is recorded before the queued operation runs, so this is
    // the exact window in which a disposal at this door would be invisible to the caller.
    const unregistered = handlers.get('browser:unregisterGuest')?.(
      trustedSender(HOST_RENDERER_ID),
      { browserPageId: preview.toolTargetId }
    )

    // Why the guest and not the result: a dropped intent settles as ok either way, so only the
    // guest actually being driven separates an armed grab from a silent no-op.
    await expect(pending).resolves.toEqual({ ok: true })
    expect(setGrabModeMock).toHaveBeenCalledWith(preview.toolTargetId, true, preview.contents)
    expect(unregistered).toBe(false)
    expect(vi.mocked(browserManager.unregisterGuest)).not.toHaveBeenCalled()
  })

  // The converse, so the guard above cannot be widened into a door that stops closing tabs.
  it('still disposes a browser page grab through the same door', async () => {
    getAuthorizedGuestMock.mockReturnValue({ isDestroyed: () => false })
    const handlers = registeredHandlers()
    const pending = handlers.get('browser:setGrabMode')?.(trustedSender(HOST_RENDERER_ID), {
      browserPageId: 'browser-page-1',
      enabled: true
    })

    const unregistered = handlers.get('browser:unregisterGuest')?.(
      trustedSender(HOST_RENDERER_ID),
      { browserPageId: 'browser-page-1' }
    )

    expect(unregistered).toBe(true)
    await expect(pending).resolves.toEqual({ ok: true })
    expect(setGrabModeMock).not.toHaveBeenCalled()
    expect(vi.mocked(browserManager.unregisterGuest)).toHaveBeenCalledWith('browser-page-1')
  })

  // Why: the two authorities must not be a fallback chain — a browser page id that the page
  // registry refuses must not get a second answer out of the preview registry, or vice versa.
  it('never resolves a browser page id through the preview authority', async () => {
    liveRenderedPreview()
    const handler = registeredHandlers().get('browser:extractHoverPayload')

    await handler?.(trustedSender(HOST_RENDERER_ID), { browserPageId: 'browser-page-1' })

    expect(getAuthorizedGuestMock).toHaveBeenCalledWith('browser-page-1', HOST_RENDERER_ID)
    expect(previewAuthoritySpy).not.toHaveBeenCalled()
  })
})
