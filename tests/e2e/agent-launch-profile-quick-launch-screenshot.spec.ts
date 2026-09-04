import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from './helpers/orca-app'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'

// Captures the before/after screenshots for the launch-profile quick-launch submenu. Not a
// conformance test: it only runs when ORCA_LAUNCH_PROFILE_SHOTS names an output directory.

const outputDir = process.env.ORCA_LAUNCH_PROFILE_SHOTS

test.skip(!outputDir, 'set ORCA_LAUNCH_PROFILE_SHOTS=<dir> to capture screenshots')

test('quick-launch submenu before and after launch profiles @headful', async ({ orcaPage }) => {
  mkdirSync(outputDir!, { recursive: true })
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  await ensureTerminalVisible(orcaPage)
  // Why: the aria-label is localized; the e2e profile follows the OS locale.
  const newTab = orcaPage.getByRole('button', { name: /^(New tab|新标签页)$/ }).first()

  await orcaPage.evaluate(async () => {
    await window.__store?.getState().updateSettings({ agentLaunchProfiles: [] })
  })
  await newTab.click({ force: true })
  const codexRow = orcaPage.getByRole('menuitem', { name: /^Codex$/ }).first()
  await expect(codexRow).toBeVisible({ timeout: 30_000 })
  await codexRow.hover()
  await orcaPage.screenshot({
    path: path.join(outputDir!, 'quick-launch-before.png'),
    animations: 'disabled'
  })
  await orcaPage.keyboard.press('Escape')

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
  const codexSub = orcaPage.getByRole('menuitem', { name: /^Codex$/ }).first()
  await expect(codexSub).toBeVisible({ timeout: 30_000 })
  await codexSub.hover()
  await expect(orcaPage.getByRole('menuitem', { name: 'Codex · secondary home' })).toBeVisible({
    timeout: 10_000
  })
  await orcaPage.screenshot({
    path: path.join(outputDir!, 'quick-launch-after.png'),
    animations: 'disabled'
  })
})
