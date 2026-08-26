import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, ...args: unknown[]) => unknown>(),
  isTrustedBrowserRenderer: vi.fn()
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) => {
      mocks.handlers.set(channel, handler)
    }
  }
}))
vi.mock('./browser-renderer-trust', () => ({
  isTrustedBrowserRenderer: mocks.isTrustedBrowserRenderer
}))

import {
  registerDocPreviewGrantHandlers,
  type DocPreviewGrantRequest
} from './doc-preview-grant-ipc'
import {
  getDocPreviewGrant,
  revokeAllDocPreviewGrants
} from '../browser/doc-preview-grant-registry'
import {
  DOC_PREVIEW_MINT_GRANT_CHANNEL,
  DOC_PREVIEW_REVOKE_GRANT_CHANNEL,
  parseDocPreviewUrl
} from '../../shared/doc-preview-scheme'

const REQUEST: DocPreviewGrantRequest = {
  owner: { kind: 'ssh', connectionId: 'ssh-1' },
  root: '/home/alice/docs',
  entryRelativePath: 'index.html'
}

const sender = { id: 7 }

function mint(request: DocPreviewGrantRequest = REQUEST): { grantId: string; url: string } {
  const handler = mocks.handlers.get(DOC_PREVIEW_MINT_GRANT_CHANNEL)
  if (!handler) {
    throw new Error('mint handler not registered')
  }
  return handler({ sender }, request) as { grantId: string; url: string }
}

function revoke(grantId: string): boolean {
  const handler = mocks.handlers.get(DOC_PREVIEW_REVOKE_GRANT_CHANNEL)
  if (!handler) {
    throw new Error('revoke handler not registered')
  }
  return handler({ sender }, grantId) as boolean
}

beforeEach(() => {
  mocks.handlers.clear()
  revokeAllDocPreviewGrants()
  mocks.isTrustedBrowserRenderer.mockReturnValue(true)
  registerDocPreviewGrantHandlers()
})

describe('document preview grant handlers', () => {
  it('mints a grant addressable by the URL it returns', () => {
    const result = mint()

    expect(parseDocPreviewUrl(result.url)).toEqual({
      grantId: result.grantId,
      relativePath: 'index.html'
    })
    expect(getDocPreviewGrant(result.grantId)?.root).toBe('/home/alice/docs')
    expect(mocks.isTrustedBrowserRenderer).toHaveBeenCalledWith(sender)
  })

  it('revokes a grant it minted', () => {
    const result = mint()

    expect(revoke(result.grantId)).toBe(true)
    expect(getDocPreviewGrant(result.grantId)).toBeNull()
  })

  it('rejects a request that names no root or entry document', () => {
    expect(() => mint({ ...REQUEST, root: '  ' })).toThrow(/Invalid/)
    expect(() => mint({ ...REQUEST, entryRelativePath: '' })).toThrow(/Invalid/)
  })

  // Why: this channel hands out filesystem-read authority, so an untrusted sender must leave with
  // nothing rather than with a grant id the scheme handler would honor.
  it('mints nothing for a sender that is not the trusted renderer', () => {
    mocks.isTrustedBrowserRenderer.mockReturnValue(false)

    expect(() => mint()).toThrow(/Untrusted/)
  })

  it('refuses to revoke on behalf of a sender that is not the trusted renderer', () => {
    const result = mint()
    mocks.isTrustedBrowserRenderer.mockReturnValue(false)

    expect(revoke(result.grantId)).toBe(false)
    expect(getDocPreviewGrant(result.grantId)).not.toBeNull()
  })
})
