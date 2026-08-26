import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  REMOTE_FILE_BROWSER_UNSUPPORTED_MESSAGE,
  canShowWorkspaceFileBrowserAction,
  getWorkspaceFileBrowserOpenTarget,
  openFileInBrowserTab,
  openFilePreviewToSide
} from './file-preview'
import { folderWorkspaceKey } from '../../../shared/workspace-scope'

function browserActionState(connectionId: string | null = null): never {
  return {
    repos: [{ id: 'repo-1', connectionId }],
    worktreesByRepo: { 'repo-1': [{ id: 'wt-1', repoId: 'repo-1' }] },
    getKnownWorktreeById: () => ({ id: 'wt-1', path: '/repo' })
  } as never
}

const mocks = vi.hoisted(() => ({
  browserAvailability: {
    state: 'enabled' as const,
    provider: 'local-client' as 'local-client' | 'paired-runtime'
  } as
    | { state: 'enabled'; provider: 'local-client' | 'paired-runtime' }
    | { state: 'hidden'; reason: string },
  createBrowserTab: vi.fn(),
  createEmptySplitGroup: vi.fn(() => 'group-2'),
  openHtmlDocPreview: vi.fn(),
  environmentId: null as string | null,
  connectionId: null as string | null,
  layoutByWorktree: {} as Record<string, unknown>,
  toastError: vi.fn()
}))

vi.mock('sonner', () => ({ toast: { error: mocks.toastError } }))

vi.mock('@/lib/client-creation-action-policy', () => ({
  getClientCreationActionPolicy: () => ({ 'managed-browser': mocks.browserAvailability })
}))

vi.mock('@/lib/worktree-runtime-owner', () => ({
  getRuntimeEnvironmentIdForWorktree: () => mocks.environmentId
}))

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => ({
      createBrowserTab: mocks.createBrowserTab,
      createEmptySplitGroup: mocks.createEmptySplitGroup,
      openHtmlDocPreview: mocks.openHtmlDocPreview,
      getKnownWorktreeById: () => ({ id: 'wt-1', path: '/srv/repo' }),
      groupsByWorktree: {},
      layoutByWorktree: mocks.layoutByWorktree,
      repos: [{ id: 'repo-1', connectionId: mocks.connectionId }],
      worktreesByRepo: {
        'repo-1': [{ id: 'wt-1', repoId: 'repo-1' }]
      }
    })
  }
}))

beforeEach(() => {
  vi.clearAllMocks()
  mocks.browserAvailability = { state: 'enabled', provider: 'local-client' }
  mocks.environmentId = null
  mocks.connectionId = null
  mocks.layoutByWorktree = {}
})

describe('openFileInBrowserTab', () => {
  it('opens a local file URL in the Orca browser with the filename as title', () => {
    openFileInBrowserTab({
      filePath: '/tmp/example file.html',
      worktreeId: 'wt-1'
    })

    expect(mocks.createBrowserTab).toHaveBeenCalledWith('wt-1', 'file:///tmp/example%20file.html', {
      title: 'example file.html',
      activate: true
    })
    expect(mocks.openHtmlDocPreview).not.toHaveBeenCalled()
  })

  it('renders a paired-runtime file as a local doc preview instead of a runtime browser tab', () => {
    mocks.environmentId = 'runtime-1'
    mocks.browserAvailability = { state: 'enabled', provider: 'paired-runtime' }

    const plan = openFileInBrowserTab({
      filePath: '/srv/repo/docs/example.html',
      worktreeId: 'wt-1'
    })

    expect(plan).toEqual({ status: 'doc-preview' })
    expect(mocks.openHtmlDocPreview).toHaveBeenCalledWith(
      {
        filePath: '/srv/repo/docs/example.html',
        relativePath: 'docs/example.html',
        worktreeId: 'wt-1',
        language: 'html',
        runtimeEnvironmentId: 'runtime-1'
      },
      { targetGroupId: undefined }
    )
    expect(mocks.createBrowserTab).not.toHaveBeenCalled()
  })

  it('renders an SSH file as a local doc preview', () => {
    mocks.connectionId = 'ssh-1'

    const plan = openFileInBrowserTab({
      filePath: '/home/alice/report.html',
      worktreeId: 'wt-1'
    })

    expect(plan).toEqual({ status: 'doc-preview' })
    expect(mocks.openHtmlDocPreview).toHaveBeenCalledOnce()
    expect(mocks.createBrowserTab).not.toHaveBeenCalled()
  })

  it('previews a paired runtime whose managed browser is unavailable', () => {
    mocks.environmentId = 'runtime-1'
    mocks.browserAvailability = { state: 'hidden', reason: 'streaming unavailable' }

    openFilePreviewToSide({
      language: 'html',
      filePath: '/srv/repo/example.html',
      worktreeId: 'wt-1',
      sourceGroupId: 'group-1'
    })

    expect(mocks.toastError).not.toHaveBeenCalled()
    expect(mocks.openHtmlDocPreview).toHaveBeenCalledOnce()
  })

  // Why the unfocused split: the preview opens in the background, and a host snapshot reads an
  // activated empty group as a terminal pane.
  it('creates paired-runtime side previews in an unfocused right-hand split', () => {
    mocks.environmentId = 'runtime-1'
    mocks.browserAvailability = { state: 'enabled', provider: 'paired-runtime' }

    openFilePreviewToSide({
      language: 'html',
      filePath: '/srv/repo/example.html',
      worktreeId: 'wt-1',
      sourceGroupId: 'group-1'
    })

    expect(mocks.createEmptySplitGroup).toHaveBeenCalledWith('wt-1', 'group-1', 'right', {
      activate: false
    })
    expect(mocks.openHtmlDocPreview).toHaveBeenCalledWith(expect.anything(), {
      targetGroupId: 'group-2'
    })
    expect(mocks.createBrowserTab).not.toHaveBeenCalled()
  })

  it('creates local side previews in an activated right-hand split', () => {
    openFilePreviewToSide({
      language: 'html',
      filePath: '/tmp/example.html',
      worktreeId: 'wt-1',
      sourceGroupId: 'group-1'
    })

    expect(mocks.createEmptySplitGroup).toHaveBeenCalledWith('wt-1', 'group-1', 'right')
    expect(mocks.createBrowserTab).toHaveBeenCalledWith('wt-1', 'file:///tmp/example.html', {
      title: 'example.html',
      targetGroupId: 'group-2',
      activate: true
    })
  })

  it('rejects a local workspace whose managed browser is unavailable before creating a split', () => {
    mocks.browserAvailability = { state: 'hidden', reason: 'browser unavailable' }

    openFilePreviewToSide({
      language: 'html',
      filePath: '/tmp/example.html',
      worktreeId: 'wt-1',
      sourceGroupId: 'group-1'
    })

    expect(mocks.toastError).toHaveBeenCalledWith('browser unavailable')
    expect(mocks.createEmptySplitGroup).not.toHaveBeenCalled()
    expect(mocks.createBrowserTab).not.toHaveBeenCalled()
    expect(mocks.openHtmlDocPreview).not.toHaveBeenCalled()
  })

  // Why: the host's files.read is worktree-scoped, so this path would otherwise 404 inside the
  // preview with nothing naming the boundary the user hit.
  it('names the worktree boundary for a paired document outside the workspace', () => {
    mocks.environmentId = 'runtime-1'
    mocks.browserAvailability = { state: 'enabled', provider: 'paired-runtime' }

    openFilePreviewToSide({
      language: 'html',
      filePath: '/tmp/agent-scratch/report.html',
      worktreeId: 'wt-1',
      sourceGroupId: 'group-1'
    })

    expect(mocks.toastError).toHaveBeenCalledWith(
      "Files outside the workspace can't be previewed on a paired server yet."
    )
    expect(mocks.createEmptySplitGroup).not.toHaveBeenCalled()
    expect(mocks.openHtmlDocPreview).not.toHaveBeenCalled()
  })

  it('keeps previewing an SSH document outside the worktree root', () => {
    mocks.connectionId = 'ssh-1'

    const plan = openFileInBrowserTab({
      filePath: '/tmp/agent-scratch/report.html',
      worktreeId: 'wt-1'
    })

    expect(plan).toEqual({ status: 'doc-preview' })
    expect(mocks.openHtmlDocPreview).toHaveBeenCalledOnce()
    expect(mocks.toastError).not.toHaveBeenCalled()
  })

  it('ignores languages that have no preview surface', () => {
    openFilePreviewToSide({
      language: 'typescript',
      filePath: '/tmp/example.ts',
      worktreeId: 'wt-1',
      sourceGroupId: 'group-1'
    })

    expect(mocks.createEmptySplitGroup).not.toHaveBeenCalled()
    expect(mocks.openHtmlDocPreview).not.toHaveBeenCalled()
  })
})

describe('canShowWorkspaceFileBrowserAction', () => {
  it('permits paired runtimes regardless of managed-browser capability', () => {
    mocks.environmentId = 'runtime-1'
    mocks.browserAvailability = { state: 'hidden', reason: 'streaming unavailable' }
    expect(
      canShowWorkspaceFileBrowserAction(browserActionState(), 'wt-1', '/repo/report.html')
    ).toBe(true)

    mocks.browserAvailability = { state: 'enabled', provider: 'paired-runtime' }
    expect(
      canShowWorkspaceFileBrowserAction(browserActionState(), 'wt-1', '/repo/report.html')
    ).toBe(true)
  })

  // Why: hiding it would leave the limitation unexplained; activating it is what surfaces the
  // worktree-boundary message.
  it('keeps the action visible for a paired document outside the worktree', () => {
    mocks.environmentId = 'runtime-1'

    expect(
      canShowWorkspaceFileBrowserAction(browserActionState(), 'wt-1', '/tmp/outside/report.html')
    ).toBe(true)
  })

  it('permits both local and SSH files', () => {
    expect(
      canShowWorkspaceFileBrowserAction(browserActionState(), 'wt-1', '/repo/report.html')
    ).toBe(true)
    expect(
      canShowWorkspaceFileBrowserAction(browserActionState('ssh-1'), 'wt-1', '/repo/report.html')
    ).toBe(true)
  })

  it('hides the action while a file has no resolved owner', () => {
    const workspaceId = folderWorkspaceKey('folder-1')
    const state = {
      folderWorkspaces: [
        {
          id: 'folder-1',
          projectGroupId: 'group-1',
          folderPath: '/workspace'
        }
      ],
      projectGroups: [{ id: 'group-1', parentGroupId: null }],
      repos: [
        {
          id: 'repo-local',
          path: '/workspace/local',
          projectGroupId: 'group-1'
        },
        {
          id: 'repo-ssh',
          path: '/workspace/remote',
          projectGroupId: 'group-1',
          connectionId: 'ssh-1'
        }
      ],
      worktreesByRepo: {}
    } as never

    expect(
      canShowWorkspaceFileBrowserAction(state, workspaceId, '/workspace/local/report.html')
    ).toBe(true)
    expect(
      canShowWorkspaceFileBrowserAction(state, workspaceId, '/workspace/remote/report.html')
    ).toBe(true)
    expect(
      canShowWorkspaceFileBrowserAction(state, workspaceId, '/workspace/unknown/report.html')
    ).toBe(false)
  })
})

describe('getWorkspaceFileBrowserOpenTarget', () => {
  it('returns a reusable browser navigation target for local files', () => {
    expect(
      getWorkspaceFileBrowserOpenTarget({
        filePath: 'C:\\repo\\demo page.html',
        worktreeId: 'wt-1'
      })
    ).toEqual({
      status: 'ready',
      url: 'file:///C:/repo/demo%20page.html',
      title: 'demo page.html'
    })
  })

  it('still refuses remote files, which have no local file URL', () => {
    mocks.connectionId = 'ssh-1'

    expect(
      getWorkspaceFileBrowserOpenTarget({
        filePath: '/home/alice/report.html',
        worktreeId: 'wt-1'
      })
    ).toEqual({
      status: 'unsupported',
      reason: 'remote-worktree',
      message: REMOTE_FILE_BROWSER_UNSUPPORTED_MESSAGE
    })
  })
})
