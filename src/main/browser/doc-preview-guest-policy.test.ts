import { beforeEach, describe, expect, it, vi } from 'vitest'
import { installDocPreviewGuestPolicy } from './doc-preview-guest-policy'
import { buildDocPreviewUrl } from '../../shared/doc-preview-scheme'
import { mintDocPreviewGrant, revokeAllDocPreviewGrants } from './doc-preview-grant-registry'

type GuestHandlers = Record<string, (...args: never[]) => void>

function installOnFakeGuest(): {
  handlers: GuestHandlers
  send: ReturnType<typeof vi.fn>
  windowOpenHandler: (details: { url: string }) => { action: string }
} {
  const handlers: GuestHandlers = {}
  const send = vi.fn()
  let windowOpenHandler: (details: { url: string }) => { action: string } = () => ({
    action: 'deny'
  })
  const guest = {
    on: vi.fn((event: string, handler: (...args: never[]) => void) => {
      handlers[event] = handler
    }),
    setWindowOpenHandler: vi.fn((handler: (details: { url: string }) => { action: string }) => {
      windowOpenHandler = handler
    })
  }
  installDocPreviewGuestPolicy(guest as never, { send })
  return { handlers, send, windowOpenHandler: (details) => windowOpenHandler(details) }
}

type FakeGuest = ReturnType<typeof installOnFakeGuest>

function startMainFrameNavigation(guest: FakeGuest, url: string): void {
  guest.handlers['did-start-navigation']?.({ url, isMainFrame: true } as never)
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
