import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  /** What the per-file resolver answers: null local, a string remote, undefined unresolved. */
  connectionIdForFile: null as string | null | undefined,
  /** What the workspace-scoped resolver answers, which is not always the same thing. */
  connectionIdForWorkspace: null as string | null | undefined,
  worktreePath: '/srv/repo' as string | null,
  activeRuntimeEnvironmentId: undefined as string | undefined,
  openFile: vi.fn(),
  openFilePath: vi.fn().mockResolvedValue(true),
  downloadAndOpen: vi.fn()
}))

vi.mock('@/lib/connection-owner-resolution', () => ({
  getConnectionIdForFileFromState: () => mocks.connectionIdForFile
}))
vi.mock('@/lib/connection-context', () => ({
  getConnectionId: () => mocks.connectionIdForWorkspace,
  getConnectionIdForFile: () => mocks.connectionIdForFile
}))
vi.mock('@/components/terminal-pane/terminal-remote-file-download-open', () => ({
  downloadAndOpenRemoteTerminalFile: mocks.downloadAndOpen
}))
vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => ({
      settings: {
        activeRuntimeEnvironmentId: mocks.activeRuntimeEnvironmentId
      },
      getKnownWorktreeById: () =>
        mocks.worktreePath === null ? undefined : { id: 'wt-1', path: mocks.worktreePath },
      openFile: mocks.openFile
    })
  }
}))

import { openDocPreviewExternally, openDocPreviewSource } from './doc-preview-document-actions'

const REMOTE_DOCUMENT = {
  filePath: '/root/demo/report/index.html',
  relativePath: 'report/index.html',
  worktreeId: 'wt-1',
  runtimeEnvironmentId: null,
  externalSshTargetId: null
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.connectionIdForFile = null
  mocks.connectionIdForWorkspace = null
  mocks.worktreePath = '/srv/repo'
  mocks.activeRuntimeEnvironmentId = undefined
  mocks.openFilePath.mockResolvedValue(true)
  vi.stubGlobal('window', { api: { shell: { openFilePath: mocks.openFilePath } } })
})

describe('openDocPreviewSource', () => {
  it('opens the document as an ordinary source tab with the editor language', () => {
    openDocPreviewSource(REMOTE_DOCUMENT)

    expect(mocks.openFile).toHaveBeenCalledWith(
      expect.objectContaining({
        filePath: REMOTE_DOCUMENT.filePath,
        relativePath: REMOTE_DOCUMENT.relativePath,
        worktreeId: 'wt-1',
        language: 'html',
        mode: 'edit'
      })
    )
  })

  // Why this field and not the rest: an absolute SSH path outside the worktree is indistinguishable
  // from a client-local external file, so dropping it makes the reopened tab read the wrong host.
  it('carries the external SSH target onto the source tab', () => {
    openDocPreviewSource({ ...REMOTE_DOCUMENT, externalSshTargetId: 'ssh-7' })

    expect(mocks.openFile).toHaveBeenCalledWith(
      expect.objectContaining({ externalSshTargetId: 'ssh-7' })
    )
  })

  it('omits the field entirely when the document has no external target', () => {
    openDocPreviewSource(REMOTE_DOCUMENT)

    expect(mocks.openFile.mock.calls[0]?.[0]).not.toHaveProperty('externalSshTargetId')
  })
})

describe('openDocPreviewExternally', () => {
  it('hands a local document straight to the OS', () => {
    openDocPreviewExternally(REMOTE_DOCUMENT)

    expect(mocks.openFilePath).toHaveBeenCalledWith(REMOTE_DOCUMENT.filePath)
    expect(mocks.downloadAndOpen).not.toHaveBeenCalled()
  })

  it('downloads an SSH document before handing it over', () => {
    mocks.connectionIdForFile = 'ssh-1'
    mocks.connectionIdForWorkspace = 'ssh-1'

    openDocPreviewExternally(REMOTE_DOCUMENT)

    expect(mocks.openFilePath).not.toHaveBeenCalled()
    expect(mocks.downloadAndOpen).toHaveBeenCalledWith(
      expect.objectContaining({ connectionId: 'ssh-1' }),
      REMOTE_DOCUMENT.filePath
    )
  })

  // Why this case exists at all: a folder workspace can span repos on different hosts, so asking
  // who owns the *workspace* answers nothing while the file itself has a definite owner. Routing on
  // the workspace answer would hand the OS a remote absolute path — a silent no-op, or worse, an
  // unrelated local file that happens to share the path.
  it('routes on the file owner when the workspace-scoped owner is unresolved', () => {
    mocks.connectionIdForFile = 'ssh-1'
    mocks.connectionIdForWorkspace = undefined

    openDocPreviewExternally(REMOTE_DOCUMENT)

    expect(mocks.openFilePath).not.toHaveBeenCalled()
    expect(mocks.downloadAndOpen).toHaveBeenCalledWith(
      expect.objectContaining({ connectionId: 'ssh-1' }),
      REMOTE_DOCUMENT.filePath
    )
  })

  // Why an unknown owner downloads rather than opens: "not resolved yet" is not "local", and the
  // OS branch is the one that cannot be taken back.
  it('downloads when the owner cannot be resolved at all', () => {
    mocks.connectionIdForFile = undefined
    mocks.connectionIdForWorkspace = undefined

    openDocPreviewExternally(REMOTE_DOCUMENT)

    expect(mocks.openFilePath).not.toHaveBeenCalled()
    expect(mocks.downloadAndOpen).toHaveBeenCalled()
  })

  // Why the root matters: remote-runtime detection is relative to the workspace root, so an unknown
  // root makes every path look outside the runtime — which reads as local.
  it('downloads a runtime document whose workspace root is unknown', () => {
    mocks.worktreePath = null
    mocks.activeRuntimeEnvironmentId = 'env-1'

    openDocPreviewExternally({ ...REMOTE_DOCUMENT, runtimeEnvironmentId: 'env-1' })

    expect(mocks.openFilePath).not.toHaveBeenCalled()
    expect(mocks.downloadAndOpen).toHaveBeenCalled()
  })
})
