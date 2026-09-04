import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from './helpers/orca-app'
import { configureGoldenStubAgent, getGoldenStubAgentLaunchEnv } from './helpers/golden-stub-agent'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'

// Captures the before/after screenshots for the launch-profile quick-launch submenu. Not a
// conformance test: it only runs when ORCA_LAUNCH_PROFILE_SHOTS names an output directory.

const outputDir = process.env.ORCA_LAUNCH_PROFILE_SHOTS
// Why: the "before" capture runs against the base branch, which has no launch-profile settings.
const baselineOnly = process.env.ORCA_LAUNCH_PROFILE_SHOTS_BASELINE === '1'
// Why: crop to the tab bar and menu so the proof stays legible at PR width.
const menuClip = { x: 290, y: 0, width: 800, height: 450 }

// Why: the e2e PATH is isolated; the golden stub fixture puts a detectable `codex` on it.
test.use({ launchEnv: getGoldenStubAgentLaunchEnv() })

test.skip(!outputDir, 'set ORCA_LAUNCH_PROFILE_SHOTS=<dir> to capture screenshots')

test('quick-launch submenu before and after launch profiles @headful', async ({ orcaPage }) => {
  mkdirSync(outputDir!, { recursive: true })
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  await ensureTerminalVisible(orcaPage)
  await configureGoldenStubAgent(orcaPage, { agent: 'codex' })
  // Why: detection ran before the stub override existed and is cached per context; re-detect, and
  // seed the store when the isolated PATH still yields nothing (this is a screenshot, not a probe).
  await orcaPage.evaluate(async () => {
    const store = window.__store!
    await store.getState().updateSettings({ uiLanguage: 'en' })
    await store.getState().refreshDetectedAgents(store.getState().activeWorktreeId ?? undefined)
    if ((store.getState().detectedAgentIds ?? []).length === 0) {
      const byContext = Object.fromEntries(
        Object.keys(store.getState().localDetectedAgentIdsByContext).map((key) => [
          key,
          ['codex', 'claude']
        ])
      )
      store.setState({
        detectedAgentIds: ['codex', 'claude'],
        localDetectedAgentIdsByContext: byContext
      })
    }
  })
  // Why: the e2e profile can surface the recoverable-UI-error dialog on startup (reproduces on
  // untouched main); while it is open the rest of the page is inert to role queries.
  const dismissError = orcaPage.getByRole('button', { name: /^(don't send|不发送)$/i }).first()
  if (await dismissError.isVisible({ timeout: 5_000 }).catch(() => false)) {
    await dismissError.click()
  }
  // Why: the aria-label is localized; the e2e profile follows the OS locale.
  const newTab = orcaPage.getByRole('button', { name: /^(New tab|新标签页)$/ }).first()
  const codexItem = (): ReturnType<typeof orcaPage.getByRole> =>
    orcaPage.getByRole('menuitem', { name: /^Codex(?:\s|$)/i }).first()

  if (!baselineOnly) {
    await orcaPage.evaluate(async () => {
      await window.__store?.getState().updateSettings({ agentLaunchProfiles: [] })
    })
  }
  await newTab.click({ force: true })
  await expect(codexItem()).toBeVisible({ timeout: 30_000 })
  await codexItem().hover()
  await orcaPage.screenshot({
    path: path.join(outputDir!, 'quick-launch-before.png'),
    animations: 'disabled',
    clip: menuClip
  })
  if (baselineOnly) {
    return
  }
  // Why: the first Escape only closes the hovered submenu; the root menu needs its own.
  for (let attempt = 0; attempt < 3 && (await codexItem().isVisible()); attempt += 1) {
    await orcaPage.keyboard.press('Escape')
  }
  await expect(codexItem()).toBeHidden({ timeout: 10_000 })

  await orcaPage.evaluate(async () => {
    await window.__store?.getState().updateSettings({
      agentLaunchProfiles: [
        {
          id: 'codex-work-proxy',
          agent: 'codex',
          label: 'Codex · work proxy',
          args: '-c model_provider="work"'
        }
      ]
    })
  })
  await newTab.click({ force: true })
  await expect(codexItem()).toBeVisible({ timeout: 30_000 })
  await codexItem().hover()
  await expect(orcaPage.getByRole('menuitem', { name: 'Codex · secondary home' })).toBeVisible({
    timeout: 10_000
  })
  await orcaPage.screenshot({
    path: path.join(outputDir!, 'quick-launch-after.png'),
    animations: 'disabled',
    clip: menuClip
  })
})
