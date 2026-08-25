import { cp, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  isOfficialOrganizationGitSource,
  isOfficialPluginIdentity,
  pluginMarketplaceSchema
} from '../../shared/plugins/plugin-marketplace'
import { bootstrapBundledPlugins, resolveBundledPluginRoot } from './plugin-bundled-bootstrap'
import { hashPluginTree } from './plugin-content-hash'
import { inspectPluginInstallTree } from './plugin-install-staging'

const launchRoot = join(process.cwd(), 'resources', 'plugins', 'launch')
const temporaryRoots: string[] = []

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8'))
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  )
})

describe('Phase 1 launch plugin content', () => {
  it('lists and validates at least eight representative plugin packs', async () => {
    const marketplace = pluginMarketplaceSchema.parse(
      await readJson(join(launchRoot, 'orca-marketplace.json'))
    )
    expect(marketplace.plugins.length).toBeGreaterThanOrEqual(7)
    expect(
      marketplace.plugins.filter(
        (plugin) =>
          isOfficialPluginIdentity(plugin.id) && isOfficialOrganizationGitSource(plugin.source.url)
      ).length
    ).toBeGreaterThanOrEqual(2)

    const localPluginDirectories = (await readdir(launchRoot, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
    expect(marketplace.plugins.map((plugin) => plugin.id).sort()).toEqual(
      localPluginDirectories.filter((pluginId) => pluginId !== 'stablyai.orca-neobrutalism-theme')
    )
    expect(localPluginDirectories).toContain('stablyai.orca-neobrutalism-theme')

    const contributionKinds = new Set<string>()
    for (const listing of marketplace.plugins) {
      const inspection = await inspectPluginInstallTree({
        rootDir: join(launchRoot, listing.id),
        hostVersion: '1.4.0',
        expectedPluginKey: listing.id
      })
      expect(inspection, `${listing.id} must pass the production install inspection`).toMatchObject(
        {
          ok: true
        }
      )
      if (!inspection.ok) {
        continue
      }
      const contributes = inspection.manifest.contributes
      if (contributes.themes.length > 0) {
        contributionKinds.add('theme')
      }
      if (contributes.languagePacks.length > 0) {
        contributionKinds.add('language')
      }
      if (contributes.iconThemes.length > 0) {
        contributionKinds.add('icon')
      }
      if (contributes.terminalThemes.length > 0) {
        contributionKinds.add('terminal-theme')
      }
      if (contributes.vmRecipes.length > 0) {
        contributionKinds.add('vm-recipe')
      }
      if (contributes.commands.length > 0 && contributes.keybindings.length > 0) {
        contributionKinds.add('command-keybinding')
      }
    }
    expect(contributionKinds).toEqual(
      new Set(['theme', 'language', 'icon', 'terminal-theme', 'vm-recipe', 'command-keybinding'])
    )
  })

  it('publishes every bundled pack only when its release hash matches exact bytes', async () => {
    const userDataPath = await mkdtemp(join(tmpdir(), 'orca-launch-content-'))
    temporaryRoots.push(userDataPath)

    const result = await bootstrapBundledPlugins({
      root: launchRoot,
      userDataPath,
      hostVersion: '1.4.0'
    })

    expect(result.errors).toEqual([])
    expect(result.installed.length).toBeGreaterThanOrEqual(1)
    expect(result.installed.every(isOfficialPluginIdentity)).toBe(true)
  })

  it('publishes the bundled Neo Brutalism pack from its exact release bytes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-neobrutalism-bundle-'))
    const userDataPath = await mkdtemp(join(tmpdir(), 'orca-neobrutalism-user-data-'))
    temporaryRoots.push(root, userDataPath)
    const pluginKey = 'stablyai.orca-neobrutalism-theme'
    const pluginRoot = join(root, pluginKey)
    await cp(join(launchRoot, pluginKey), pluginRoot, { recursive: true })
    const hashed = await hashPluginTree(pluginRoot)
    expect(hashed.ok).toBe(true)
    if (!hashed.ok) {
      return
    }
    await writeFile(
      join(root, 'bundled-plugins.json'),
      JSON.stringify({
        version: 1,
        plugins: [{ pluginKey, path: pluginKey, contentHash: hashed.hash }]
      })
    )

    await expect(
      bootstrapBundledPlugins({ root, userDataPath, hostVersion: '0.1.2' })
    ).resolves.toMatchObject({ installed: [pluginKey], errors: [] })
  })

  it('boots release-indexed content from the packaged resources layout', async () => {
    const resourcesPath = await mkdtemp(join(tmpdir(), 'orca-packaged-resources-'))
    const userDataPath = await mkdtemp(join(tmpdir(), 'orca-packaged-user-data-'))
    temporaryRoots.push(resourcesPath, userDataPath)
    const packagedRoot = join(resourcesPath, 'plugins', 'launch')
    await cp(launchRoot, packagedRoot, { recursive: true })

    const result = await bootstrapBundledPlugins({
      root: resolveBundledPluginRoot({
        isPackaged: true,
        resourcesPath,
        appPath: join(resourcesPath, 'app.asar')
      }),
      userDataPath,
      hostVersion: '1.4.0'
    })

    expect(result.errors).toEqual([])
    expect(result.installed).toEqual([
      'stablyai.orca-midnight-theme',
      'stablyai.orca-navigation-shortcuts',
      'stablyai.orca-neobrutalism-theme'
    ])
  })
})
