import type { Page } from '@stablyai/playwright-test'

/**
 * Census for the paired HTML preview journey. Since STA-5557 the preview is a client-local
 * document tab served over `orca-preview://`, so the oracle is inverted: the preview must
 * materialize as an editor-family tab while neither the client nor the host gains a browser.
 */
export type PairedHtmlPreviewInventory = {
  hostResponseOk: boolean
  hostResponseError: string | null
  /** Every browser tab the host knows about, not just the fixture's. */
  hostBrowserTabCount: number
  hostFixtureBrowserTabIds: string[]
  /** Client-side browser workspaces; the old preview path grew this by one. */
  clientBrowserWorkspaceCount: number
  /** Why every workspace and not just this one: a routed-out link opens in whichever workspace is
   *  active, so a per-worktree count could miss a tab that really was created. */
  clientBrowserWorkspaceCountAllWorktrees: number
  clientFixtureBrowserWorkspaceIds: string[]
  previewTabs: { groupId: string; id: string }[]
  previewOpenFileModes: string[]
}

export async function readPairedHtmlPreviewInventory(
  page: Page,
  args: {
    environmentId: string
    fixtureName: string
    previewFileId: string
    worktreeId: string
  }
): Promise<PairedHtmlPreviewInventory> {
  return page.evaluate(async ({ environmentId, fixtureName, previewFileId, worktreeId }) => {
    const response = await window.api.runtimeEnvironments.call({
      selector: environmentId,
      method: 'session.tabs.list',
      params: { worktree: `id:${worktreeId}` },
      timeoutMs: 15_000
    })
    const state = window.__store?.getState()
    // Why: the RPC result crosses the preload boundary as `unknown`; name the one shape read here.
    const hostTabs = response.ok
      ? (response.result as { tabs: { id: string; type: string; url: string }[] }).tabs
      : []
    const hostBrowserTabs = hostTabs.filter((tab) => tab.type === 'browser')
    const clientBrowserWorkspaces = state?.browserTabsByWorktree[worktreeId] ?? []
    return {
      hostResponseOk: response.ok,
      hostResponseError: response.ok ? null : JSON.stringify(response.error),
      hostBrowserTabCount: hostBrowserTabs.length,
      hostFixtureBrowserTabIds: hostBrowserTabs
        .filter((tab) => tab.url.endsWith(`/${fixtureName}`))
        .map((tab) => tab.id),
      clientBrowserWorkspaceCount: clientBrowserWorkspaces.length,
      clientBrowserWorkspaceCountAllWorktrees: Object.values(
        state?.browserTabsByWorktree ?? {}
      ).reduce((total, tabs) => total + tabs.length, 0),
      clientFixtureBrowserWorkspaceIds: clientBrowserWorkspaces
        .filter((tab) => tab.url.endsWith(`/${fixtureName}`))
        .map((tab) => tab.id),
      previewTabs: (state?.unifiedTabsByWorktree[worktreeId] ?? [])
        .filter((tab) => tab.contentType === 'editor' && tab.entityId === previewFileId)
        .map((tab) => ({ groupId: tab.groupId, id: tab.id })),
      previewOpenFileModes: (state?.openFiles ?? [])
        .filter((file) => file.id === previewFileId)
        .map((file) => file.mode ?? 'edit')
    }
  }, args)
}

/**
 * Reads the rendered document out of the preview guest. The guest is a real `<webview>` on its
 * own partition, so Playwright cannot reach into it directly — the embedder evaluates for us.
 */
export async function readDocPreviewRenderedText(
  page: Page,
  selector: string
): Promise<string | null> {
  return page.evaluate(async (targetSelector) => {
    const guest = document.querySelector('webview[src^="orca-preview://"]') as {
      executeJavaScript?: (code: string) => Promise<unknown>
    } | null
    if (!guest?.executeJavaScript) {
      return null
    }
    try {
      const text = await guest.executeJavaScript(
        `document.querySelector(${JSON.stringify(targetSelector)})?.textContent ?? null`
      )
      return typeof text === 'string' ? text : null
    } catch {
      // Why: the guest rejects until it is attached and dom-ready; the caller polls.
      return null
    }
  }, selector)
}

/**
 * Viewport point of an element inside the preview guest. Playwright cannot target a node in a
 * webview, so the guest reports the rect and the embedder adds the webview's own offset — a real
 * mouse press there is the only click Chromium treats as a user gesture.
 *
 * Returns null until the guest's own hit test at that point resolves to the element, so a caller
 * polling on it cannot click a rect that layout is still moving.
 */
export async function readDocPreviewElementCenter(
  page: Page,
  selector: string
): Promise<{ x: number; y: number } | null> {
  return page.evaluate(async (targetSelector) => {
    const guest = document.querySelector('webview[src^="orca-preview://"]') as
      | (HTMLElement & { executeJavaScript?: (code: string) => Promise<unknown> })
      | null
    if (!guest?.executeJavaScript) {
      return null
    }
    try {
      const rect = (await guest.executeJavaScript(
        `(() => { const el = document.querySelector(${JSON.stringify(targetSelector)});
          if (!el) { return null }
          const r = el.getBoundingClientRect();
          const x = r.left + r.width / 2;
          const y = r.top + r.height / 2;
          return el.contains(document.elementFromPoint(x, y)) ? { x, y } : null })()`
      )) as { x: number; y: number } | null
      if (!rect) {
        return null
      }
      const hostRect = guest.getBoundingClientRect()
      if (hostRect.width === 0 || hostRect.height === 0) {
        return null
      }
      return { x: hostRect.left + rect.x, y: hostRect.top + rect.y }
    } catch {
      return null
    }
  }, selector)
}

type RoutedPreviewLink = { url: string; opened: boolean }

/**
 * Records every external link the preview routes into a browser tab. The click that triggers this
 * crosses into a guest process, so without the record a missing tab cannot distinguish a press
 * Chromium swallowed from a tab the workspace refused to create.
 */
export async function armPairedHtmlPreviewLinkRouting(page: Page): Promise<void> {
  await page.evaluate(() => {
    const store = window.__store
    if (!store) {
      throw new Error('paired client exposed no store to observe link routing')
    }
    const routed: RoutedPreviewLink[] = []
    ;(window as unknown as { __routedPreviewLinks: RoutedPreviewLink[] }).__routedPreviewLinks =
      routed
    const original = store.getState().openBrowserProfileTabInActiveWorkspace
    store.setState({
      openBrowserProfileTabInActiveWorkspace: async (url: string, profileId: string | null) => {
        const opened = await original(url, profileId)
        routed.push({ url, opened })
        return opened
      }
    } as never)
  })
}

export async function readPairedHtmlPreviewLinkRouting(page: Page): Promise<RoutedPreviewLink[]> {
  return page.evaluate(
    () =>
      (window as unknown as { __routedPreviewLinks?: RoutedPreviewLink[] }).__routedPreviewLinks ??
      []
  )
}

export async function readDocPreviewGuestUrl(page: Page): Promise<string | null> {
  return page.evaluate(
    () => document.querySelector('webview[src^="orca-preview://"]')?.getAttribute('src') ?? null
  )
}
