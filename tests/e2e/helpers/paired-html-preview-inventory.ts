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

export async function readDocPreviewGuestUrl(page: Page): Promise<string | null> {
  return page.evaluate(
    () => document.querySelector('webview[src^="orca-preview://"]')?.getAttribute('src') ?? null
  )
}
