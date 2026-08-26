import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ORCA_BROWSER_GUEST_WEB_PREFERENCES } from '../../shared/browser-guest-web-preferences'

const mocks = vi.hoisted(() => ({
  attachGuestPolicies: vi.fn(),
  installNavigationPolicy: vi.fn(),
  isAllowedPartition: vi.fn(),
  attachRouteGuest: vi.fn(),
  installDocPreviewGuestPolicy: vi.fn(),
  registerPluginGuard: vi.fn()
}))

vi.mock('../browser/browser-manager', () => ({
  browserManager: { attachGuestPolicies: mocks.attachGuestPolicies }
}))
vi.mock('../browser/browser-session-registry', () => ({
  browserSessionRegistry: { isAllowedPartition: mocks.isAllowedPartition }
}))
vi.mock('../plugins/plugin-panel-navigation-guard', () => ({
  registerPluginPanelNavigationGuard: mocks.registerPluginGuard
}))
vi.mock('./privileged-window-navigation', () => ({
  installPrivilegedWindowNavigationPolicy: mocks.installNavigationPolicy
}))
vi.mock('../browser/browser-route-session-runtime', () => ({
  browserRouteSessionRegistry: { isAllowedPartition: () => false },
  browserRouteWebContentsRegistry: { attachGuest: mocks.attachRouteGuest }
}))
vi.mock('../browser/local-ssh-browser-partitions', () => ({
  isLocalSshBrowserPartition: () => false,
  enforceLocalSshWebRtcPolicyForGuest: vi.fn()
}))
vi.mock('../browser/doc-preview-protocol', () => ({
  isDocPreviewSession: (candidate: unknown) => candidate === 'doc-preview-session'
}))
vi.mock('../browser/doc-preview-guest-policy', () => ({
  installDocPreviewGuestPolicy: mocks.installDocPreviewGuestPolicy
}))

import { installMainWindowWebviewSecurity } from './main-window-webview-security'
import {
  mintDocPreviewGrant,
  revokeAllDocPreviewGrants
} from '../browser/doc-preview-grant-registry'
import { buildDocPreviewUrl, DOC_PREVIEW_PARTITION } from '../../shared/doc-preview-scheme'

function installOnFakeWindow(): {
  handlers: Record<string, (...args: never[]) => void>
  webContents: { on: ReturnType<typeof vi.fn> }
} {
  const handlers: Record<string, (...args: never[]) => void> = {}
  const webContents = {
    on: vi.fn((event: string, handler: (...args: never[]) => void) => {
      handlers[event] = handler
    })
  }
  installMainWindowWebviewSecurity({ webContents } as never)
  return { handlers, webContents }
}

function mintPreviewGrant(): ReturnType<typeof mintDocPreviewGrant> {
  return mintDocPreviewGrant({
    owner: { kind: 'ssh', connectionId: 'ssh-1' },
    root: '/home/alice/docs',
    entryRelativePath: 'index.html'
  })
}

describe('main window webview security', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    revokeAllDocPreviewGrants()
  })

  it('fails closed before applying hardened guest preferences', () => {
    const handlers: Record<string, (...args: never[]) => void> = {}
    const webContents = {
      on: vi.fn((event: string, handler: (...args: never[]) => void) => {
        handlers[event] = handler
      })
    }
    installMainWindowWebviewSecurity({ webContents } as never)
    mocks.isAllowedPartition.mockReturnValue(false)
    const preventDefault = vi.fn()

    handlers['will-attach-webview']?.(
      { preventDefault } as never,
      { partition: 'persist:untrusted', preload: 'attacker.js' } as never,
      { src: 'https://example.com', preload: 'attacker.js' } as never
    )

    expect(preventDefault).toHaveBeenCalledOnce()
    expect(mocks.installNavigationPolicy).toHaveBeenCalledWith(webContents)
    expect(mocks.registerPluginGuard).toHaveBeenCalledWith(webContents)
  })

  it('removes renderer preload input and restores every hardened preference', () => {
    const handlers: Record<string, (...args: never[]) => void> = {}
    const webContents = {
      on: vi.fn((event: string, handler: (...args: never[]) => void) => {
        handlers[event] = handler
      })
    }
    installMainWindowWebviewSecurity({ webContents } as never)
    mocks.isAllowedPartition.mockReturnValue(true)
    const params = { src: 'https://example.com', preload: 'attacker.js' }
    const preferences: Record<string, unknown> = {
      partition: 'persist:orca-browser',
      preload: 'attacker.js',
      preloadURL: 'attacker.js',
      sandbox: false
    }

    handlers['will-attach-webview']?.(
      { preventDefault: vi.fn() } as never,
      preferences as never,
      params as never
    )

    expect(params).not.toHaveProperty('preload')
    expect(preferences).toMatchObject({
      ...ORCA_BROWSER_GUEST_WEB_PREFERENCES,
      partition: 'persist:orca-browser',
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      sandbox: true,
      webSecurity: true
    })
    expect(preferences).not.toHaveProperty('preloadURL')
    expect(String(preferences.preload)).toMatch(/browser-window-close-preload\.js$/)
  })
})

describe('orca-preview scheme admission', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    revokeAllDocPreviewGrants()
  })

  it('admits a preview URL only on the preview partition and only with a live grant', () => {
    const grant = mintPreviewGrant()
    const { handlers } = installOnFakeWindow()
    mocks.isAllowedPartition.mockReturnValue(false)
    const preventDefault = vi.fn()
    const preferences: Record<string, unknown> = {
      partition: DOC_PREVIEW_PARTITION,
      preload: 'attacker.js',
      sandbox: false
    }

    handlers['will-attach-webview']?.(
      { preventDefault } as never,
      preferences as never,
      { src: buildDocPreviewUrl(grant.id, 'index.html'), preload: 'attacker.js' } as never
    )

    expect(preventDefault).not.toHaveBeenCalled()
    expect(preferences).toMatchObject({
      partition: DOC_PREVIEW_PARTITION,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true
    })
    expect(preferences).not.toHaveProperty('preloadURL')
  })

  it('denies a preview URL whose grant is unknown or revoked', () => {
    const { handlers } = installOnFakeWindow()
    mocks.isAllowedPartition.mockReturnValue(false)
    const preventDefault = vi.fn()

    handlers['will-attach-webview']?.(
      { preventDefault } as never,
      { partition: DOC_PREVIEW_PARTITION } as never,
      { src: `orca-preview://${'0'.repeat(32)}/index.html` } as never
    )

    expect(preventDefault).toHaveBeenCalledOnce()
  })

  it('denies a preview URL smuggled onto a browsing partition', () => {
    const grant = mintPreviewGrant()
    const { handlers } = installOnFakeWindow()
    // Even an allowlisted browsing partition must not load the preview scheme.
    mocks.isAllowedPartition.mockReturnValue(true)
    const preventDefault = vi.fn()

    handlers['will-attach-webview']?.(
      { preventDefault } as never,
      { partition: 'persist:orca-browser' } as never,
      { src: buildDocPreviewUrl(grant.id, 'index.html') } as never
    )

    expect(preventDefault).toHaveBeenCalledOnce()
  })

  it('denies a web URL on the preview partition', () => {
    const { handlers } = installOnFakeWindow()
    mocks.isAllowedPartition.mockReturnValue(false)
    const preventDefault = vi.fn()

    handlers['will-attach-webview']?.(
      { preventDefault } as never,
      { partition: DOC_PREVIEW_PARTITION } as never,
      { src: 'https://example.com' } as never
    )

    expect(preventDefault).toHaveBeenCalledOnce()
  })

  it('gives a preview guest its own policy instead of the browser guest policies', () => {
    const { handlers, webContents } = installOnFakeWindow()

    handlers['did-attach-webview']?.({} as never, { session: 'doc-preview-session' } as never)

    expect(mocks.installDocPreviewGuestPolicy).toHaveBeenCalledWith(
      { session: 'doc-preview-session' },
      webContents
    )
    expect(mocks.attachGuestPolicies).not.toHaveBeenCalled()
    expect(mocks.attachRouteGuest).not.toHaveBeenCalled()
  })

  it('keeps browser guests on the browser policies', () => {
    const { handlers } = installOnFakeWindow()

    handlers['did-attach-webview']?.({} as never, { session: 'browser-session' } as never)

    expect(mocks.installDocPreviewGuestPolicy).not.toHaveBeenCalled()
    expect(mocks.attachGuestPolicies).toHaveBeenCalledOnce()
  })
})
