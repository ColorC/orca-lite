import { beforeEach, describe, expect, it, vi } from 'vitest'
import { installDocPreviewGuestPolicy } from './doc-preview-guest-policy'
import { buildDocPreviewUrl } from '../../shared/doc-preview-scheme'
import { mintDocPreviewGrant, revokeAllDocPreviewGrants } from './doc-preview-grant-registry'

type GuestHandlers = Record<string, (...args: never[]) => void>

function installOnFakeGuest(): {
  handlers: GuestHandlers
  send: ReturnType<typeof vi.fn>
  setWebRTCIPHandlingPolicy: ReturnType<typeof vi.fn>
  windowOpenHandler: (details: { url: string }) => { action: string }
} {
  const handlers: GuestHandlers = {}
  const send = vi.fn()
  const setWebRTCIPHandlingPolicy = vi.fn()
  let windowOpenHandler: (details: { url: string }) => { action: string } = () => ({
    action: 'deny'
  })
  const guest = {
    on: vi.fn((event: string, handler: (...args: never[]) => void) => {
      handlers[event] = handler
    }),
    setWindowOpenHandler: vi.fn((handler: (details: { url: string }) => { action: string }) => {
      windowOpenHandler = handler
    }),
    setWebRTCIPHandlingPolicy
  }
  installDocPreviewGuestPolicy(guest as never, { send })
  return {
    handlers,
    send,
    setWebRTCIPHandlingPolicy,
    windowOpenHandler: (details) => windowOpenHandler(details)
  }
}

type FakeGuest = ReturnType<typeof installOnFakeGuest>

function startMainFrameNavigation(guest: FakeGuest, url: string): void {
  guest.handlers['did-start-navigation']?.({ url, isMainFrame: true } as never)
}

/** The shape Electron delivers for a real press, which is the only thing that opens the link route. */
function pressPointer(guest: FakeGuest): void {
  guest.handlers['input-event']?.({} as never, { type: 'mouseDown' } as never)
}

function mintGrant(): ReturnType<typeof mintDocPreviewGrant> {
  return mintDocPreviewGrant({
    owner: { kind: 'ssh', connectionId: 'ssh-1' },
    root: '/home/alice/docs',
    entryRelativePath: 'index.html'
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  revokeAllDocPreviewGrants()
})

describe('doc preview guest policy', () => {
  it('allows relative navigation within the bound grant', () => {
    const grant = mintGrant()
    const guest = installOnFakeGuest()
    startMainFrameNavigation(guest, buildDocPreviewUrl(grant.id, 'index.html'))
    const preventDefault = vi.fn()

    guest.handlers['will-navigate']?.(
      { preventDefault } as never,
      buildDocPreviewUrl(grant.id, 'guide.html') as never
    )

    expect(preventDefault).not.toHaveBeenCalled()
    expect(guest.send).not.toHaveBeenCalled()
  })

  it('blocks navigation into a different live grant once bound', () => {
    const grant = mintGrant()
    const otherGrant = mintGrant()
    const guest = installOnFakeGuest()
    startMainFrameNavigation(guest, buildDocPreviewUrl(grant.id, 'index.html'))
    const preventDefault = vi.fn()

    guest.handlers['will-navigate']?.(
      { preventDefault } as never,
      buildDocPreviewUrl(otherGrant.id, 'index.html') as never
    )

    expect(preventDefault).toHaveBeenCalledOnce()
  })

  it('blocks a revoked grant even when it matches the bound id', () => {
    const grant = mintGrant()
    const guest = installOnFakeGuest()
    startMainFrameNavigation(guest, buildDocPreviewUrl(grant.id, 'index.html'))
    revokeAllDocPreviewGrants()
    const preventDefault = vi.fn()

    guest.handlers['will-navigate']?.(
      { preventDefault } as never,
      buildDocPreviewUrl(grant.id, 'guide.html') as never
    )

    expect(preventDefault).toHaveBeenCalledOnce()
  })

  it('sends an external http(s) link to the renderer instead of navigating the preview', () => {
    const grant = mintGrant()
    const guest = installOnFakeGuest()
    startMainFrameNavigation(guest, buildDocPreviewUrl(grant.id, 'index.html'))
    const preventDefault = vi.fn()

    pressPointer(guest)
    guest.handlers['will-navigate']?.({ preventDefault } as never, 'https://example.com/' as never)

    expect(preventDefault).toHaveBeenCalledOnce()
    expect(guest.send).toHaveBeenCalledWith('docPreview:externalLink', {
      url: 'https://example.com/'
    })
  })

  it('blocks a file: navigation without offering it to the renderer', () => {
    mintGrant()
    const guest = installOnFakeGuest()
    const preventDefault = vi.fn()

    // Why press first: with no gesture the link route is shut for every URL, which would let this
    // pass without the scheme check ever running.
    pressPointer(guest)
    guest.handlers['will-navigate']?.({ preventDefault } as never, 'file:///etc/passwd' as never)

    expect(preventDefault).toHaveBeenCalledOnce()
    expect(guest.send).not.toHaveBeenCalled()
  })

  it('applies the same rule to redirects', () => {
    mintGrant()
    const guest = installOnFakeGuest()
    const preventDefault = vi.fn()

    guest.handlers['will-redirect']?.({ preventDefault } as never, 'https://evil.test/' as never)

    expect(preventDefault).toHaveBeenCalledOnce()
  })

  it('denies every popup and routes target=_blank to a new Orca browser tab', () => {
    const guest = installOnFakeGuest()

    pressPointer(guest)
    expect(guest.windowOpenHandler({ url: 'https://example.com/docs' })).toEqual({
      action: 'deny'
    })
    expect(guest.send).toHaveBeenCalledWith('docPreview:externalLink', {
      url: 'https://example.com/docs'
    })
  })

  it('denies a popup to a non-web scheme without sending anything', () => {
    const guest = installOnFakeGuest()

    expect(guest.windowOpenHandler({ url: 'file:///etc/passwd' })).toEqual({ action: 'deny' })
    expect(guest.send).not.toHaveBeenCalled()
  })

  // Why: will-navigate never fires for a subframe, so an <iframe src="https://…"> would load
  // off-machine even though the top frame cannot.
  it('blocks a subframe navigating outside the grant, without opening a tab for it', () => {
    const grant = mintGrant()
    const guest = installOnFakeGuest()
    startMainFrameNavigation(guest, buildDocPreviewUrl(grant.id, 'index.html'))
    const preventDefault = vi.fn()

    // Why press first: the gesture gate alone would suppress the send, hiding whether the subframe
    // rule is doing anything.
    pressPointer(guest)
    guest.handlers['will-frame-navigate']?.({
      preventDefault,
      url: 'https://tracker.test/pixel',
      isMainFrame: false
    } as never)

    expect(preventDefault).toHaveBeenCalledOnce()
    // Why not routed out like a main-frame click: a subframe navigates on its own, so a tab here
    // would let a document spawn browser tabs the user never asked for.
    expect(guest.send).not.toHaveBeenCalled()
  })

  it('lets a subframe load an in-grant asset', () => {
    const grant = mintGrant()
    const guest = installOnFakeGuest()
    startMainFrameNavigation(guest, buildDocPreviewUrl(grant.id, 'index.html'))
    const preventDefault = vi.fn()

    guest.handlers['will-frame-navigate']?.({
      preventDefault,
      url: buildDocPreviewUrl(grant.id, 'chart.html'),
      isMainFrame: false
    } as never)

    expect(preventDefault).not.toHaveBeenCalled()
  })

  // Why this group exists: the external-link route ends in a real browser tab with full network, so
  // a document that can read its grant and reach that route can exfiltrate it. Only a human may.
  describe('gesture gate on the external-link route', () => {
    it('refuses a scripted location change that no one asked for', () => {
      const grant = mintGrant()
      const guest = installOnFakeGuest()
      startMainFrameNavigation(guest, buildDocPreviewUrl(grant.id, 'index.html'))
      const preventDefault = vi.fn()

      guest.handlers['will-navigate']?.(
        { preventDefault } as never,
        'https://attacker.test/?d=secret' as never
      )

      expect(preventDefault).toHaveBeenCalledOnce()
      expect(guest.send).not.toHaveBeenCalled()
    })

    it('refuses a scripted window.open that no one asked for', () => {
      const guest = installOnFakeGuest()

      expect(guest.windowOpenHandler({ url: 'https://attacker.test/?d=secret' })).toEqual({
        action: 'deny'
      })
      expect(guest.send).not.toHaveBeenCalled()
    })

    it('routes a popup opened right after a press', () => {
      const guest = installOnFakeGuest()

      pressPointer(guest)

      expect(guest.windowOpenHandler({ url: 'https://example.com/docs' })).toEqual({
        action: 'deny'
      })
      expect(guest.send).toHaveBeenCalledOnce()
    })

    it('spends the press on one tab, so a loop cannot ride a single click', () => {
      const guest = installOnFakeGuest()

      pressPointer(guest)
      guest.windowOpenHandler({ url: 'https://example.com/1' })
      guest.windowOpenHandler({ url: 'https://example.com/2' })
      guest.windowOpenHandler({ url: 'https://example.com/3' })

      expect(guest.send).toHaveBeenCalledOnce()
      expect(guest.send).toHaveBeenCalledWith('docPreview:externalLink', {
        url: 'https://example.com/1'
      })
    })

    it('lets the keyboard open a link, since a document can be read without a mouse', () => {
      const guest = installOnFakeGuest()

      guest.handlers['before-input-event']?.({} as never, { type: 'keyDown' } as never)

      guest.windowOpenHandler({ url: 'https://example.com/docs' })
      expect(guest.send).toHaveBeenCalledOnce()
    })

    it('does not count a pointer merely crossing the document', () => {
      const guest = installOnFakeGuest()

      guest.handlers['input-event']?.({} as never, { type: 'mouseMove' } as never)
      guest.handlers['input-event']?.({} as never, { type: 'mouseWheel' } as never)

      guest.windowOpenHandler({ url: 'https://attacker.test/?d=secret' })
      expect(guest.send).not.toHaveBeenCalled()
    })

    it('lets a press go stale, so a document cannot wait out the reader', () => {
      vi.useFakeTimers()
      try {
        const guest = installOnFakeGuest()
        pressPointer(guest)
        vi.advanceTimersByTime(2_001)

        guest.windowOpenHandler({ url: 'https://attacker.test/?d=secret' })
        expect(guest.send).not.toHaveBeenCalled()
      } finally {
        vi.useRealTimers()
      }
    })
  })

  // Why: a peer connection is UDP straight off the network stack — the response CSP and the
  // session's request filter both miss it, so this is the only place it can be refused.
  it('denies the guest non-proxied WebRTC UDP at attach', () => {
    const guest = installOnFakeGuest()

    expect(guest.setWebRTCIPHandlingPolicy).toHaveBeenCalledWith('disable_non_proxied_udp')
  })

  // Why: latching from a subframe would let an in-document iframe decide which grant the guest
  // belongs to, and every later main-frame check would be measured against that.
  it('binds the guest from the main frame only', () => {
    const grant = mintGrant()
    const otherGrant = mintGrant()
    const guest = installOnFakeGuest()

    guest.handlers['did-start-navigation']?.({
      url: buildDocPreviewUrl(otherGrant.id, 'index.html'),
      isMainFrame: false
    } as never)
    startMainFrameNavigation(guest, buildDocPreviewUrl(grant.id, 'index.html'))
    const preventDefault = vi.fn()

    guest.handlers['will-navigate']?.(
      { preventDefault } as never,
      buildDocPreviewUrl(otherGrant.id, 'index.html') as never
    )

    expect(preventDefault).toHaveBeenCalledOnce()
  })
})
