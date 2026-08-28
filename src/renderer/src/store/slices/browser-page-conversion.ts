import type {
  BrowserPage,
  BrowserPageConversionOrigin,
  BrowserPageDocLocation,
  BrowserWorkspace
} from '../../../../shared/browser-workspace-types'
import { browserPageDocLocationsEqual } from '../../../../shared/browser-page-doc-location'
import { buildBrowserPage, findPage, findWorkspace, mirrorWorkspaceFromActivePage } from './browser-page-records'

/**
 * What the address bar asked a page to become. A `web` target's runtime owner is the caller's
 * decision (a converted page in a remote worktree stays client-hosted, like the doc page it
 * replaces); a `workspace-doc` target is always client-local, because the grant is minted here.
 */
export type BrowserPageConversionTarget =
  | { kind: 'web'; url: string; browserRuntimeEnvironmentId?: string | null }
  | { kind: 'workspace-doc'; docLocation: BrowserPageDocLocation }

export type BrowserPageConversionPlan = {
  oldPage: BrowserPage
  newPage: BrowserPage
  workspace: BrowserWorkspace
  nextPages: BrowserPage[]
  nextWorkspace: BrowserWorkspace
}

/**
 * A conversion never mutates a page across the doc/web boundary — it replaces the page, under a
 * fresh id, inside the surviving workspace row. The fresh id is what keeps the two main-process
 * registry halves disjoint by construction: the old id dies with its half (grant revoke, guest
 * teardown), the new id registers cleanly in the other, and no ordering between those two
 * asynchronous teardowns is ever load-bearing.
 */
export function planBrowserPageConversion(
  state: {
    browserTabsByWorktree: Record<string, BrowserWorkspace[]>
    browserPagesByWorkspace: Record<string, BrowserPage[]>
  },
  pageId: string,
  target: BrowserPageConversionTarget,
  options?: {
    /** false for Back's return leg: arriving back consumes the provenance rather than growing a
     *  ping-pong chain — after returning, Back means the guest's own history again. */
    recordProvenance?: boolean
  }
): BrowserPageConversionPlan | null {
  const oldPage = findPage(state.browserPagesByWorkspace, pageId)
  if (!oldPage) {
    return null
  }
  const workspace = findWorkspace(state.browserTabsByWorktree, oldPage.workspaceId)
  if (!workspace) {
    return null
  }
  if (target.kind === 'web' && !oldPage.docLocation) {
    // Why refused: a web page taking a new URL is navigation, and it must ride the navigation
    // doors (loading state, history, guest reuse) — conversion would silently drop all of them.
    return null
  }
  if (
    target.kind === 'workspace-doc' &&
    browserPageDocLocationsEqual(oldPage.docLocation ?? null, target.docLocation)
  ) {
    return null
  }

  const convertedFrom: BrowserPageConversionOrigin | null =
    options?.recordProvenance === false
      ? null
      : oldPage.docLocation
        ? { kind: 'workspace-doc', docLocation: oldPage.docLocation }
        : // Why the stored url and not the guest's: the store url passed every fence on its way in,
          // so provenance can be persisted without opening a new door.
          { kind: 'url', url: oldPage.url }

  const newPage: BrowserPage = {
    ...(target.kind === 'workspace-doc'
      ? buildBrowserPage(
          workspace.id,
          oldPage.worktreeId,
          '',
          undefined,
          // Why explicitly client-local: the document is read through a grant this desktop mints,
          // so the page never belongs to a remote runtime even when the worktree does.
          null,
          undefined,
          target.docLocation
        )
      : buildBrowserPage(
          workspace.id,
          oldPage.worktreeId,
          target.url,
          undefined,
          // Why the old page's ownership and never the inferred default: an omitted id infers the
          // worktree's runtime and renders a streamed pane with no remote handle behind it. The
          // page being converted lived on this desktop, so its replacement does too.
          target.browserRuntimeEnvironmentId !== undefined
            ? target.browserRuntimeEnvironmentId
            : (oldPage.browserRuntimeEnvironmentId ?? null)
        )),
    ...(convertedFrom ? { convertedFrom } : {})
  }

  const currentPages = state.browserPagesByWorkspace[workspace.id] ?? []
  const nextPages = currentPages.map((page) => (page.id === pageId ? newPage : page))
  const nextWorkspace = mirrorWorkspaceFromActivePage(
    {
      ...workspace,
      activePageId: workspace.activePageId === pageId ? newPage.id : workspace.activePageId,
      pageIds: nextPages.map((page) => page.id)
    },
    nextPages
  )

  return { oldPage, newPage, workspace, nextPages, nextWorkspace }
}
