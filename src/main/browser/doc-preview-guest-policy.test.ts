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
    guest.handlers['did-start-navigation']?.(
      {} as never,
      buildDocPreviewUrl(grant.id, 'index.html') as never
    )
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
    guest.handlers['did-start-navigation']?.(
      {} as never,
      buildDocPreviewUrl(grant.id, 'index.html') as never
    )
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
    guest.handlers['did-start-navigation']?.(
      {} as never,
      buildDocPreviewUrl(grant.id, 'index.html') as never
    )
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
    guest.handlers['did-start-navigation']?.(
      {} as never,
      buildDocPreviewUrl(grant.id, 'index.html') as never
    )
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
})
