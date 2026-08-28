import { describe, expect, it, vi } from 'vitest'
import type * as AgentStatusModule from '../lib/agent-status'
import { buildMobileSessionTabSnapshots } from './sync-runtime-graph'
import { createTestStore, makeWorktree } from '../store/slices/store-test-helpers'

vi.mock('@/lib/doc-preview-grants', () => ({
  releaseDocPreviewGrant: vi.fn(),
  ensureDocPreviewGrant: vi.fn(),
  buildDocPreviewGrantRequest: vi.fn()
}))
vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }))
vi.mock('@/lib/agent-status', async (importOriginal) => {
  const actual = await importOriginal<typeof AgentStatusModule>()
  return { ...actual, detectAgentStatusFromTitle: vi.fn().mockReturnValue(null) }
})

const WORKTREE_ID = 'repo1::/path/wt1'
const DOC_LOCATION = {
  kind: 'workspace-doc' as const,
  worktreeId: WORKTREE_ID,
  filePath: '/home/alice/wt1/report/index.html'
}

function createStoreWithWorktree(): ReturnType<typeof createTestStore> {
  const store = createTestStore()
  store.setState({
    repos: [{ id: 'repo1', path: '/repo1', displayName: 'Repo 1', badgeColor: '#000', addedAt: 0 }],
    worktreesByRepo: {
      repo1: [makeWorktree({ id: WORKTREE_ID, repoId: 'repo1', path: '/path/wt1' })]
    },
    activeWorktreeId: WORKTREE_ID
  })
  return store
}

function publishedBrowserWorkspaceIds(store: ReturnType<typeof createTestStore>): string[] {
  const snapshot = buildMobileSessionTabSnapshots(store.getState()).find(
    (entry) => entry.worktree === WORKTREE_ID
  )
  return (snapshot?.tabs ?? [])
    .filter((tab) => tab.type === 'browser')
    .map((tab) => (tab as { browserWorkspaceId?: string }).browserWorkspaceId ?? '')
}

// The publish boundary is a predicate over docLocation, so a conversion must flip it in the same
// store commit that flips the page — no intermediate state may publish a document or hold back a
// web page. Driven through the real store actions, not a hand-built state, so the mirror path the
// conversion writes is the one the publisher reads.
describe('mobile publish across an address-bar conversion', () => {
  it('starts publishing a doc tab the moment it converts to web, and stops on the way back', () => {
    const store = createStoreWithWorktree()
    // Presence precondition: an ordinary URL tab publishes throughout, so an empty answer would
    // fail rather than pass by the publisher being broken for browser tabs entirely.
    const urlTab = store.getState().createBrowserTab(WORKTREE_ID, 'https://example.com/')
    const docTab = store.getState().createBrowserTab(WORKTREE_ID, '', {
      docLocation: DOC_LOCATION,
      title: 'index.html',
      browserRuntimeEnvironmentId: null
    })
    const docPageId = store.getState().browserPagesByWorkspace[docTab.id]?.[0]?.id ?? ''

    expect(publishedBrowserWorkspaceIds(store)).toEqual([urlTab.id])

    const webPage = store.getState().convertBrowserPage(docPageId, {
      kind: 'web',
      url: 'https://converted.example/'
    })
    expect(webPage).not.toBeNull()
    expect(publishedBrowserWorkspaceIds(store).sort()).toEqual([urlTab.id, docTab.id].sort())

    const docPage = store.getState().convertBrowserPage(webPage?.id ?? '', {
      kind: 'workspace-doc',
      docLocation: DOC_LOCATION
    })
    expect(docPage).not.toBeNull()
    expect(publishedBrowserWorkspaceIds(store)).toEqual([urlTab.id])
  })
})
