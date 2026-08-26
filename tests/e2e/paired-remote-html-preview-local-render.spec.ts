import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from './helpers/orca-app'
import { openFileExplorer } from './helpers/file-explorer'
import {
  createRuntimeDesktopPairingOffer,
  launchPairedElectronClient,
  type PairedElectronClient
} from './helpers/paired-electron-client'
import {
  armPairedHtmlPreviewLinkRouting,
  readDocPreviewElementCenter,
  readDocPreviewGuestUrl,
  readDocPreviewRenderedText,
  readPairedHtmlPreviewInventory,
  readPairedHtmlPreviewLinkRouting
} from './helpers/paired-html-preview-inventory'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'

const FIXTURE_NAME = 'paired-html-focus.html'
const FIXTURE_HEADING = 'paired html preview'
const EXTERNAL_LINK_URL = 'https://example.com/from-preview'

/**
 * Since STA-5557 a paired HTML preview renders locally from the workspace's disk over the
 * `orca-preview://` scheme instead of creating a browser page on the runtime. The oracle is
 * therefore inverted: the document must render in a client-local editor-family tab while
 * neither side gains a browser workspace.
 */
test('renders a paired HTML doc locally without creating any browser page', async ({
  orcaPage,
  testRepoPath
}, testInfo) => {
  test.setTimeout(240_000)
  writeFileSync(
    path.join(testRepoPath, FIXTURE_NAME),
    `<!doctype html><html><body><h1>${FIXTURE_HEADING}</h1>` +
      `<p><a id="external" href="${EXTERNAL_LINK_URL}" target="_blank" ` +
      `style="display:inline-block;padding:24px;font-size:24px">external link</a></p>` +
      `</body></html>\n`
  )
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  await ensureTerminalVisible(orcaPage)

  const offer = await createRuntimeDesktopPairingOffer(orcaPage)
  let client: PairedElectronClient | null = null
  try {
    client = await launchPairedElectronClient(offer, testInfo, 'Remote HTML preview')
    const page = client.page
    await expect
      .poll(
        () =>
          page.evaluate((repoPath) => {
            const state = window.__store?.getState()
            return state
              ? (state.allWorktrees().find((worktree) => worktree.path === repoPath)?.id ?? null)
              : null
          }, testRepoPath),
        { timeout: 60_000, message: 'paired client never received the host worktree' }
      )
      .not.toBeNull()
    const worktree = await page.evaluate((repoPath) => {
      const state = window.__store?.getState()
      const match = state?.allWorktrees().find((candidate) => candidate.path === repoPath)
      return match ? { id: match.id, path: match.path } : null
    }, testRepoPath)
    if (!worktree) {
      throw new Error('paired client worktree disappeared after discovery')
    }
    const worktreeId = worktree.id
    // Why: the grant and the tab identity are keyed by the path the client actually holds, which
    // is the host's worktree path — not this process's idea of the repo location.
    const previewFileId = `html-preview::${worktreeId}::${path.join(worktree.path, FIXTURE_NAME)}`
    const inventoryArgs = {
      environmentId: client.environmentId,
      fixtureName: FIXTURE_NAME,
      previewFileId,
      worktreeId
    }

    await page.evaluate(
      ({ environmentId, worktreeId }) => {
        window.__store?.getState().setActiveWorktree(worktreeId, `runtime:${environmentId}`)
      },
      { environmentId: client.environmentId, worktreeId }
    )
    await openFileExplorer(page)
    const fixtureRow = page.locator('[data-file-explorer-row]').filter({ hasText: FIXTURE_NAME })
    await expect(fixtureRow).toBeVisible({ timeout: 30_000 })
    await fixtureRow.click()
    const openPreviewToSide = page.getByRole('button', { name: 'Open Preview to the Side' })
    await expect(openPreviewToSide).toBeVisible({ timeout: 30_000 })
    const sourceEditor = await page.evaluate((targetWorktreeId) => {
      const state = window.__store?.getState()
      const groupId = state?.activeGroupIdByWorktree[targetWorktreeId]
      const group = (state?.groupsByWorktree[targetWorktreeId] ?? []).find(
        (candidate) => candidate.id === groupId
      )
      const tab = (state?.unifiedTabsByWorktree[targetWorktreeId] ?? []).find(
        (candidate) => candidate.id === group?.activeTabId && candidate.contentType === 'editor'
      )
      return groupId && tab ? { groupId, tabId: tab.id } : null
    }, worktreeId)
    if (!sourceEditor) {
      throw new Error('paired client editor had no source identity before side preview')
    }
    const sourceGroupId = sourceEditor.groupId

    await expect
      .poll(() => readPairedHtmlPreviewInventory(page, inventoryArgs), {
        timeout: 30_000,
        message: 'host tab baseline was never successfully observed'
      })
      .toMatchObject({ hostResponseError: null, hostResponseOk: true, previewTabs: [] })
    const baseline = await readPairedHtmlPreviewInventory(page, inventoryArgs)
    const browserBaseline = {
      clientBrowserWorkspaceCount: baseline.clientBrowserWorkspaceCount,
      hostBrowserTabCount: baseline.hostBrowserTabCount
    }

    await openPreviewToSide.click()

    await expect
      .poll(
        async () => (await readPairedHtmlPreviewInventory(page, inventoryArgs)).previewTabs.length,
        { timeout: 60_000, message: 'the client-local doc preview tab never materialized' }
      )
      .toBe(1)

    // Presence precondition for the absence assertions below: the document really rendered, so a
    // browser that failed to appear cannot be an artifact of the preview never happening at all.
    await expect
      .poll(() => readDocPreviewRenderedText(page, 'h1'), {
        timeout: 60_000,
        message: 'the preview guest never rendered the workspace document'
      })
      .toBe(FIXTURE_HEADING)
    expect(await readDocPreviewGuestUrl(page)).toMatch(/^orca-preview:\/\//)

    const afterPreview = await readPairedHtmlPreviewInventory(page, inventoryArgs)
    expect(afterPreview.previewOpenFileModes).toEqual(['html-preview'])
    expect(afterPreview.previewTabs[0]?.groupId).not.toBe(sourceGroupId)
    expect({
      clientBrowserWorkspaceCount: afterPreview.clientBrowserWorkspaceCount,
      hostBrowserTabCount: afterPreview.hostBrowserTabCount
    }).toEqual(browserBaseline)
    expect(afterPreview.clientFixtureBrowserWorkspaceIds).toEqual([])
    expect(afterPreview.hostFixtureBrowserTabIds).toEqual([])

    await expect(page.locator(`[data-tab-group-body-id="${sourceGroupId}"]`)).toBeVisible()
    await expect(
      page.locator(`[data-tab-group-body-id="${afterPreview.previewTabs[0]!.groupId}"]`)
    ).toBeVisible()
    await expect(page.locator(`[data-tab-id="${sourceEditor.tabId}"]`)).toBeVisible()

    // Creating the preview must not move focus: the user stays in the source editor and the
    // preview merely occupies its own split, which is where an explicit click sends them.
    await expect
      .poll(
        () =>
          page.evaluate(
            ({ previewGroupId, worktreeId: targetWorktreeId }) => {
              const state = window.__store?.getState()
              const groups = state?.groupsByWorktree[targetWorktreeId] ?? []
              const activeGroup = groups.find(
                (group) => group.id === state?.activeGroupIdByWorktree[targetWorktreeId]
              )
              return {
                activeGroupId: activeGroup?.id ?? null,
                activeTabId: activeGroup?.activeTabId ?? null,
                activeTabType: state?.activeTabTypeByWorktree[targetWorktreeId] ?? null,
                previewGroupActiveTabId:
                  groups.find((group) => group.id === previewGroupId)?.activeTabId ?? null
              }
            },
            { previewGroupId: afterPreview.previewTabs[0]!.groupId, worktreeId }
          ),
        { timeout: 30_000, message: 'preview placement never settled' }
      )
      .toEqual({
        activeGroupId: sourceGroupId,
        activeTabId: sourceEditor.tabId,
        activeTabType: 'editor',
        previewGroupActiveTabId: afterPreview.previewTabs[0]!.id
      })

    const terminalTabId = await page.evaluate((targetWorktreeId) => {
      const state = window.__store?.getState()
      return state?.tabsByWorktree[targetWorktreeId]?.[0]?.id ?? null
    }, worktreeId)
    if (!terminalTabId) {
      throw new Error('paired client lost its terminal tab')
    }
    await page.locator(`[data-tab-id="${terminalTabId}"]`).click()
    await expect
      .poll(
        () =>
          page.evaluate((targetWorktreeId) => {
            const state = window.__store?.getState()
            return state?.activeTabTypeByWorktree[targetWorktreeId] ?? null
          }, worktreeId),
        { message: 'terminal tab never became active before returning to the preview' }
      )
      .toBe('terminal')

    const previewTab = page.locator(`[data-tab-id="${afterPreview.previewTabs[0]!.id}"]`)
    await previewTab.click()
    await expect
      .poll(
        () =>
          page.evaluate(
            ({ previewTabId, worktreeId: targetWorktreeId }) => {
              const state = window.__store?.getState()
              const activeGroup = (state?.groupsByWorktree[targetWorktreeId] ?? []).find(
                (group) => group.id === state?.activeGroupIdByWorktree[targetWorktreeId]
              )
              return activeGroup?.activeTabId === previewTabId
            },
            { previewTabId: afterPreview.previewTabs[0]!.id, worktreeId }
          ),
        { timeout: 30_000, message: 'clicking the preview tab did not reactivate it' }
      )
      .toBe(true)
    expect(await readDocPreviewRenderedText(page, 'h1')).toBe(FIXTURE_HEADING)

    await previewTab.hover()
    await previewTab.getByRole('button', { name: /^Close tab/ }).click()
    await expect
      .poll(
        async () => {
          const closed = await readPairedHtmlPreviewInventory(page, inventoryArgs)
          return {
            clientBrowserWorkspaceCount: closed.clientBrowserWorkspaceCount,
            hostBrowserTabCount: closed.hostBrowserTabCount,
            previewOpenFiles: closed.previewOpenFileModes.length,
            previewTabs: closed.previewTabs.length,
            sourceGroupPresent: await page.evaluate(
              ({ groupId, worktreeId: targetWorktreeId }) =>
                (window.__store?.getState()?.groupsByWorktree[targetWorktreeId] ?? []).some(
                  (group) => group.id === groupId
                ),
              { groupId: sourceGroupId, worktreeId }
            )
          }
        },
        { timeout: 30_000, message: 'closing the preview did not converge' }
      )
      .toEqual({
        ...browserBaseline,
        previewOpenFiles: 0,
        previewTabs: 0,
        sourceGroupPresent: true
      })
    await expect(previewTab).toHaveCount(0)
    await expect(page.locator(`[data-tab-id="${terminalTabId}"]`)).toBeVisible()
    // Why: the last activation was the preview, so the editor has to be selected again before its
    // pane mounts — the point is that closing the preview left a working editor behind.
    await page.locator(`[data-tab-id="${sourceEditor.tabId}"]`).click()
    await expect(
      page.locator(`[data-tab-group-body-id="${sourceGroupId}"] .monaco-editor`)
    ).toBeVisible({ timeout: 30_000 })

    // Why this runs last: it is the one step that is supposed to create a browser tab, so it
    // cannot share a run phase with the no-browser oracle above. A target="_blank" click is only
    // routed out if the guest carries allowpopups, and only a real mouse press is a user gesture
    // Chromium will honour — a scripted click inside the guest is swallowed by the popup blocker.
    await expect(openPreviewToSide).toBeVisible({ timeout: 30_000 })
    await openPreviewToSide.click()
    await expect
      .poll(() => readDocPreviewRenderedText(page, 'h1'), {
        timeout: 60_000,
        message: 'the reopened preview never rendered before the external link click'
      })
      .toBe(FIXTURE_HEADING)
    // Why poll rather than read once: the helper only answers once the guest's own hit test lands
    // on the link, so the press cannot chase a rect that layout is still settling.
    await expect
      .poll(() => readDocPreviewElementCenter(page, '#external'), {
        timeout: 30_000,
        message: 'the external link never settled at a clickable point in the preview guest'
      })
      .not.toBeNull()
    // Why record the routing call: the click crosses into a guest process, so a bare "no tab
    // appeared" cannot say whether the press was swallowed before the handler or the tab was
    // refused after it. The recorded calls make the failure name itself.
    await armPairedHtmlPreviewLinkRouting(page)
    // Why the heading click first: the press that routes the link has to carry user activation in
    // the guest, and the guest only has it once it holds focus.
    const headingPoint = await readDocPreviewElementCenter(page, 'h1')
    if (headingPoint) {
      await page.mouse.click(headingPoint.x, headingPoint.y)
    }
    const linkBaseline = await readPairedHtmlPreviewInventory(page, inventoryArgs)
    await expect
      .poll(
        async () => {
          const routedCalls = await readPairedHtmlPreviewLinkRouting(page)
          // Why only while nothing has routed: a retry after a successful route would open a
          // second tab and turn this oracle into a counter of presses.
          if (routedCalls.length === 0) {
            const point = await readDocPreviewElementCenter(page, '#external')
            if (point) {
              await page.mouse.click(point.x, point.y)
            }
          }
          const opened = await readPairedHtmlPreviewInventory(page, inventoryArgs)
          return {
            routedCalls: await readPairedHtmlPreviewLinkRouting(page),
            previewTabs: opened.previewTabs.length,
            openedTab:
              opened.clientBrowserWorkspaceCountAllWorktrees + opened.hostBrowserTabCount >
              linkBaseline.clientBrowserWorkspaceCountAllWorktrees +
                linkBaseline.hostBrowserTabCount
          }
        },
        {
          timeout: 60_000,
          intervals: [2_000],
          message: 'a target=_blank click in the preview never opened an Orca browser tab'
        }
      )
      .toMatchObject({
        openedTab: true,
        // Why assert the preview survived: the link leaves the preview for a browser tab; it must
        // not navigate or close the document the user is reading.
        previewTabs: 1,
        routedCalls: [{ url: EXTERNAL_LINK_URL, opened: true }]
      })
  } finally {
    await client?.dispose()
  }
})
