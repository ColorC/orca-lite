import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  readDocPreviewFile: vi.fn()
}))

const previewSession = { protocol: { isProtocolHandled: () => false, handle: vi.fn() } }
vi.mock('electron', () => ({
  protocol: { registerSchemesAsPrivileged: vi.fn() },
  session: { fromPartition: () => previewSession }
}))
vi.mock('./doc-preview-file-reader', () => ({ readDocPreviewFile: mocks.readDocPreviewFile }))

import {
  getDocPreviewSession,
  handleDocPreviewRequest,
  isDocPreviewSession
} from './doc-preview-protocol'
import {
  mintDocPreviewGrant,
  revokeAllDocPreviewGrants,
  revokeDocPreviewGrant
} from './doc-preview-grant-registry'
import {
  buildDocPreviewUrl,
  DOC_PREVIEW_LOAD_FAILURE_CHANNEL
} from '../../shared/doc-preview-scheme'
import { setDocPreviewFailureSink } from './doc-preview-failure-notice'

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
  setDocPreviewFailureSink(null)
  mocks.readDocPreviewFile.mockResolvedValue({
    ok: true,
    bytes: Buffer.from('<h1>hi</h1>', 'utf8'),
    contentType: 'text/html; charset=utf-8'
  })
})

describe('handleDocPreviewRequest', () => {
  it('serves an in-grant document with no-store so reload re-reads the workspace', async () => {
    const grant = mintGrant()

    const response = await handleDocPreviewRequest(
      new Request(buildDocPreviewUrl(grant.id, 'index.html'))
    )

    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Type')).toBe('text/html; charset=utf-8')
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    expect(await response.text()).toBe('<h1>hi</h1>')
    expect(mocks.readDocPreviewFile).toHaveBeenCalledWith(grant, 'index.html')
  })

  it('falls back to the granted entry document for a root request', async () => {
    const grant = mintGrant()

    await handleDocPreviewRequest(new Request(`orca-preview://${grant.id}/`))

    expect(mocks.readDocPreviewFile).toHaveBeenCalledWith(grant, 'index.html')
  })

  it('decodes percent-encoded segments before resolving', async () => {
    const grant = mintGrant()

    await handleDocPreviewRequest(new Request(buildDocPreviewUrl(grant.id, 'a b/c#d.html')))

    expect(mocks.readDocPreviewFile).toHaveBeenCalledWith(grant, 'a b/c#d.html')
  })

  it('404s an unknown grant without reading anything', async () => {
    const response = await handleDocPreviewRequest(
      new Request(`orca-preview://${'0'.repeat(32)}/index.html`)
    )

    expect(response.status).toBe(404)
    expect(mocks.readDocPreviewFile).not.toHaveBeenCalled()
  })

  it('404s a revoked grant', async () => {
    const grant = mintGrant()
    revokeDocPreviewGrant(grant.id)

    const response = await handleDocPreviewRequest(
      new Request(buildDocPreviewUrl(grant.id, 'index.html'))
    )

    expect(response.status).toBe(404)
    expect(mocks.readDocPreviewFile).not.toHaveBeenCalled()
  })

  it('404s a malformed grant id', async () => {
    const response = await handleDocPreviewRequest(new Request('orca-preview://not-a-grant/x.html'))

    expect(response.status).toBe(404)
    expect(mocks.readDocPreviewFile).not.toHaveBeenCalled()
  })

  it('propagates the reader status for an unservable asset', async () => {
    const grant = mintGrant()
    mocks.readDocPreviewFile.mockResolvedValue({
      ok: false,
      status: 415,
      message: 'needs a newer server'
    })

    const response = await handleDocPreviewRequest(
      new Request(buildDocPreviewUrl(grant.id, 'a.zip'))
    )

    expect(response.status).toBe(415)
    expect(await response.text()).toBe('needs a newer server')
  })

  // Why: the guest paints a 4xx body as if it were the document, so the shell only learns the
  // reason from this push.
  it('pushes the failure reason for the requested path', async () => {
    const send = vi.fn()
    setDocPreviewFailureSink({ send })
    const grant = mintGrant()
    mocks.readDocPreviewFile.mockResolvedValue({ ok: false, status: 413, message: 'too large' })

    await handleDocPreviewRequest(new Request(buildDocPreviewUrl(grant.id, 'index.html')))

    expect(send).toHaveBeenCalledWith(DOC_PREVIEW_LOAD_FAILURE_CHANNEL, {
      grantId: grant.id,
      relativePath: 'index.html',
      reason: 'too-large'
    })
  })

  it('pushes nothing when the document is served', async () => {
    const send = vi.fn()
    setDocPreviewFailureSink({ send })
    const grant = mintGrant()

    await handleDocPreviewRequest(new Request(buildDocPreviewUrl(grant.id, 'index.html')))

    expect(send).not.toHaveBeenCalled()
  })
})

describe('isDocPreviewSession', () => {
  it('claims no session until the preview session has been materialized', () => {
    expect(isDocPreviewSession({} as never)).toBe(false)
  })

  it('matches only the memoized preview session', () => {
    const created = getDocPreviewSession()

    expect(isDocPreviewSession(created)).toBe(true)
    expect(isDocPreviewSession({} as never)).toBe(false)
    expect(getDocPreviewSession()).toBe(created)
  })
})
