import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  callRuntimeEnvironment: vi.fn(),
  readFile: vi.fn(),
  requireSshFilesystemProvider: vi.fn()
}))

vi.mock('../ipc/runtime-environment-transport-routing', () => ({
  callRuntimeEnvironment: mocks.callRuntimeEnvironment
}))
vi.mock('../persistence', () => ({ getCanonicalUserDataPath: () => '/user-data' }))
vi.mock('../providers/ssh-filesystem-dispatch', () => ({
  requireSshFilesystemProvider: mocks.requireSshFilesystemProvider
}))

import { FileReadCapExceededError } from '../ssh/ssh-filesystem-stream-reader'
import { docPreviewContentType, readDocPreviewFile } from './doc-preview-file-reader'
import { mintDocPreviewGrant, revokeAllDocPreviewGrants } from './doc-preview-grant-registry'

function sshGrant(): ReturnType<typeof mintDocPreviewGrant> {
  return mintDocPreviewGrant({
    owner: { kind: 'ssh', connectionId: 'ssh-1' },
    root: '/home/alice/docs',
    entryRelativePath: 'index.html'
  })
}

function runtimeGrant(root = '/srv/repo/docs'): ReturnType<typeof mintDocPreviewGrant> {
  return mintDocPreviewGrant({
    owner: {
      kind: 'runtime',
      environmentId: 'env-1',
      worktreeSelector: 'id:wt-1',
      worktreeRoot: '/srv/repo'
    },
    root,
    entryRelativePath: 'index.html'
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  revokeAllDocPreviewGrants()
  mocks.requireSshFilesystemProvider.mockReturnValue({ readFile: mocks.readFile })
})

describe('docPreviewContentType', () => {
  it('maps document and asset extensions, defaulting to octet-stream', () => {
    expect(docPreviewContentType('index.html')).toBe('text/html; charset=utf-8')
    expect(docPreviewContentType('assets/app.CSS')).toBe('text/css; charset=utf-8')
    expect(docPreviewContentType('assets/logo.png')).toBe('image/png')
    expect(docPreviewContentType('data.bin')).toBe('application/octet-stream')
  })
})

describe('readDocPreviewFile — ssh owner', () => {
  it('reads text through the SSH filesystem provider', async () => {
    mocks.readFile.mockResolvedValue({ content: '<h1>hi</h1>', isBinary: false })

    const outcome = await readDocPreviewFile(sshGrant(), 'index.html')

    expect(mocks.requireSshFilesystemProvider).toHaveBeenCalledWith('ssh-1')
    expect(mocks.readFile).toHaveBeenCalledWith('/home/alice/docs/index.html')
    expect(outcome).toEqual({
      ok: true,
      bytes: Buffer.from('<h1>hi</h1>', 'utf8'),
      contentType: 'text/html; charset=utf-8'
    })
  })

  it('decodes a base64 binary asset', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47])
    mocks.readFile.mockResolvedValue({ content: png.toString('base64'), isBinary: true })

    const outcome = await readDocPreviewFile(sshGrant(), 'assets/logo.png')

    expect(outcome).toEqual({ ok: true, bytes: png, contentType: 'image/png' })
  })

  // Why: the SSH reader rejects an over-cap file rather than clamping it, so a completed read is
  // always whole and needs no truncation flag.
  it('serves a whole SSH read that carries no truncation flag', async () => {
    mocks.readFile.mockResolvedValue({ content: '<h1>whole</h1>', isBinary: false })

    expect(await readDocPreviewFile(sshGrant(), 'index.html')).toMatchObject({ ok: true })
  })

  it('reports an unservable binary rather than an empty asset', async () => {
    mocks.readFile.mockResolvedValue({ content: '', isBinary: true })

    const outcome = await readDocPreviewFile(sshGrant(), 'assets/archive.zip')

    expect(outcome).toMatchObject({ ok: false, status: 415 })
  })

  it('404s a path outside the grant root without touching the provider', async () => {
    const outcome = await readDocPreviewFile(sshGrant(), '../../etc/passwd')

    expect(outcome).toMatchObject({ ok: false, status: 404 })
    expect(mocks.requireSshFilesystemProvider).not.toHaveBeenCalled()
  })

  it('reports an over-cap SSH file as too large rather than unreadable', async () => {
    mocks.readFile.mockRejectedValue(new FileReadCapExceededError('exceeds client cap'))

    expect(await readDocPreviewFile(sshGrant(), 'huge.html')).toMatchObject({
      ok: false,
      status: 413
    })
  })

  it('404s when the provider read fails', async () => {
    mocks.readFile.mockRejectedValue(new Error('no such file'))

    expect(await readDocPreviewFile(sshGrant(), 'missing.html')).toMatchObject({
      ok: false,
      status: 404
    })
  })
})

describe('readDocPreviewFile — paired runtime owner', () => {
  it('reads text over worktree-relative files.read', async () => {
    mocks.callRuntimeEnvironment.mockResolvedValue({
      ok: true,
      result: { content: '<h1>remote</h1>', truncated: false, byteLength: 15 }
    })

    const outcome = await readDocPreviewFile(runtimeGrant(), 'index.html')

    expect(mocks.callRuntimeEnvironment).toHaveBeenCalledWith(
      '/user-data',
      'env-1',
      'files.read',
      { worktree: 'id:wt-1', relativePath: 'docs/index.html' },
      15_000
    )
    expect(outcome).toEqual({
      ok: true,
      bytes: Buffer.from('<h1>remote</h1>', 'utf8'),
      contentType: 'text/html; charset=utf-8'
    })
  })

  it('falls back to the base64 preview RPC for a binary asset', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47])
    mocks.callRuntimeEnvironment
      .mockResolvedValueOnce({
        ok: false,
        error: { code: 'runtime_error', message: 'binary_file' }
      })
      .mockResolvedValueOnce({
        ok: true,
        result: {
          content: png.toString('base64'),
          isBinary: true,
          isImage: true,
          mimeType: 'image/png'
        }
      })

    const outcome = await readDocPreviewFile(runtimeGrant(), 'assets/logo.png')

    expect(mocks.callRuntimeEnvironment).toHaveBeenNthCalledWith(
      2,
      '/user-data',
      'env-1',
      'files.readPreview',
      { worktree: 'id:wt-1', relativePath: 'docs/assets/logo.png' },
      15_000
    )
    expect(outcome).toEqual({ ok: true, bytes: png, contentType: 'image/png' })
  })

  it('degrades on an old server whose empty binary preview carries no metadata', async () => {
    mocks.callRuntimeEnvironment
      .mockResolvedValueOnce({
        ok: false,
        error: { code: 'runtime_error', message: 'binary_file' }
      })
      .mockResolvedValueOnce({ ok: true, result: { content: '', isBinary: true } })

    expect(await readDocPreviewFile(runtimeGrant(), 'assets/logo.png')).toMatchObject({
      ok: false,
      status: 415
    })
  })

  // Why: files.read clamps text at the host cap and only says so in `truncated`; serving the
  // clamped bytes renders a document that silently stops halfway.
  it('refuses a truncated text read instead of serving the clamped bytes', async () => {
    mocks.callRuntimeEnvironment.mockResolvedValue({
      ok: true,
      result: { content: '<h1>half of', truncated: true, byteLength: 40_000_000 }
    })

    const outcome = await readDocPreviewFile(runtimeGrant(), 'index.html')

    expect(outcome).toMatchObject({ ok: false, status: 413 })
    expect(outcome).not.toMatchObject({ ok: true })
  })

  it('serves a read the host reports as complete', async () => {
    mocks.callRuntimeEnvironment.mockResolvedValue({
      ok: true,
      result: { content: '<h1>all</h1>', truncated: false, byteLength: 12 }
    })

    expect(await readDocPreviewFile(runtimeGrant(), 'index.html')).toMatchObject({ ok: true })
  })

  // Why: the binary RPC has no `truncated` field — it rejects an over-cap asset with this error.
  it('reports the host rejecting an over-cap binary as too large', async () => {
    mocks.callRuntimeEnvironment
      .mockResolvedValueOnce({
        ok: false,
        error: { code: 'runtime_error', message: 'binary_file' }
      })
      .mockResolvedValueOnce({
        ok: false,
        error: { code: 'runtime_error', message: 'file_too_large' }
      })

    expect(await readDocPreviewFile(runtimeGrant(), 'assets/huge.png')).toMatchObject({
      ok: false,
      status: 413
    })
  })

  it('does not treat an unrelated RPC failure as a binary fallback', async () => {
    mocks.callRuntimeEnvironment.mockResolvedValue({
      ok: false,
      error: { code: 'runtime_error', message: 'permission_denied' }
    })

    expect(await readDocPreviewFile(runtimeGrant(), 'index.html')).toMatchObject({
      ok: false,
      status: 404
    })
    expect(mocks.callRuntimeEnvironment).toHaveBeenCalledOnce()
  })

  it('404s a document outside the worktree, which files.read cannot address', async () => {
    const outcome = await readDocPreviewFile(runtimeGrant('/tmp/agent-docs'), 'index.html')

    expect(outcome).toMatchObject({ ok: false, status: 404 })
    expect(mocks.callRuntimeEnvironment).not.toHaveBeenCalled()
  })
})
