import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as DocPreviewGuestPolicyModule from '../browser/doc-preview-guest-policy'

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
  previewAuthoritySpy
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
  previewAuthoritySpy: vi.fn()
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

import { registerBrowserHandlers } from './browser'
import { installDocPreviewGuestPolicy } from '../browser/doc-preview-guest-policy'
import {
  mintDocPreviewGrant,
  revokeAllDocPreviewGrants
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
  toolTargetId: string
  contents: object
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
  const guest = {
    isFocused: () => true,
    isDestroyed: () => false,
    on: vi.fn(register),
    once: vi.fn(register),
    setWindowOpenHandler: vi.fn(),
    setWebRTCIPHandlingPolicy: vi.fn()
  }
  installDocPreviewGuestPolicy(guest as never, { id: hostId, send: vi.fn() })
  handlers['did-start-navigation']?.({
    url: buildDocPreviewUrl(grant.id, 'index.html'),
    isMainFrame: true
  } as never)
  return { toolTargetId: toDocPreviewToolTargetId(grant.id), contents: guest }
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

const GUEST_RECEIVING_MOCKS = [
  setGrabModeMock,
  awaitGrabSelectionMock,
  captureSelectionScreenshotMock,
  extractHoverPayloadMock,
  setAnnotationViewportBridgeMock
]

beforeEach(() => {
  vi.stubEnv('ELECTRON_RENDERER_URL', '')
  vi.clearAllMocks()
  revokeAllDocPreviewGrants()
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
      mock.mock.calls.some((args) => args.includes(preview.contents))
    )
    expect(receivedGuest || cancelGrabOpMock.mock.calls.length > 0).toBe(true)
    expect(getAuthorizedGuestMock).not.toHaveBeenCalled()
  })

  // The load-bearing containment claim: page/session management never reaches the preview registry,
  // so a preview can never be resolved as, or managed like, a browser page.
  it.each(BROWSER_PAGE_CHANNELS)('never consults the preview authority from %s', async (channel) => {
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
  })

  it.each(TOOL_CHANNELS)('refuses %s from a renderer that does not host the preview', async (
    channel
  ) => {
    const preview = liveRenderedPreview()
    const handler = registeredHandlers().get(channel)

    await handler?.(trustedSender(OTHER_RENDERER_ID), toolArgs(channel, preview.toolTargetId))

    for (const mock of [...GUEST_RECEIVING_MOCKS, cancelGrabOpMock]) {
      expect(mock).not.toHaveBeenCalled()
    }
  })

  it.each(TOOL_CHANNELS)('refuses %s for a target no preview rendered', async (channel) => {
    const unrenderedTarget = toDocPreviewToolTargetId('a'.repeat(32))
    const handler = registeredHandlers().get(channel)

    await handler?.(trustedSender(HOST_RENDERER_ID), toolArgs(channel, unrenderedTarget))

    for (const mock of [...GUEST_RECEIVING_MOCKS, cancelGrabOpMock]) {
      expect(mock).not.toHaveBeenCalled()
    }
    expect(getAuthorizedGuestMock).not.toHaveBeenCalled()
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
