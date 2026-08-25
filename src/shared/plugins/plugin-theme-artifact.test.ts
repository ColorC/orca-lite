import { describe, expect, it } from 'vitest'
import { parsePluginAppThemeArtifact, PLUGIN_APP_THEME_TOKENS } from './plugin-theme-artifact'

describe('plugin app theme artifacts', () => {
  it('accepts color, region, geometry, state, and motion tokens', () => {
    expect(
      parsePluginAppThemeArtifact(
        JSON.stringify({
          schemaVersion: 2,
          base: 'dark',
          tokens: {
            '--background': '#101010',
            '--right-sidebar': 'rgb(20 20 20 / 90%)',
            '--appearance-panel-radius': '0px',
            '--appearance-control-hover-offset': '-1px',
            '--appearance-shadow-control': '3px 3px 0 0 #000000',
            '--appearance-state-selected': '#304050',
            '--appearance-state-selected-foreground': '#ffffff',
            '--motion-enter': '260ms',
            '--motion-ease-out': 'cubic-bezier(0.2, 1.4, 0.4, 1)'
          }
        })
      )
    ).toMatchObject({
      ok: true,
      theme: {
        schemaVersion: 2,
        base: 'dark',
        tokens: {
          '--appearance-panel-radius': '0px',
          '--appearance-control-hover-offset': '-1px',
          '--appearance-shadow-control': '3px 3px 0 0 #000000',
          '--appearance-state-selected-foreground': '#ffffff',
          '--motion-enter': '260ms'
        }
      }
    })
  })

  it('keeps trust-surface tokens private', () => {
    expect(PLUGIN_APP_THEME_TOKENS).not.toContain('--orca-security-background')
    expect(
      parsePluginAppThemeArtifact(
        JSON.stringify({ base: 'dark', tokens: { '--orca-security-background': '#000' } })
      ).ok
    ).toBe(false)
  })

  it('requires schema version 2 for geometry and motion', () => {
    expect(
      parsePluginAppThemeArtifact(
        JSON.stringify({ base: 'dark', tokens: { '--appearance-control-radius': '0px' } })
      )
    ).toMatchObject({ ok: false, error: expect.stringContaining('schemaVersion 2') })
  })

  it('rejects negative geometry outside interaction offsets', () => {
    expect(
      parsePluginAppThemeArtifact(
        JSON.stringify({ schemaVersion: 2, base: 'dark', tokens: { '--radius': '-1px' } })
      ).ok
    ).toBe(false)
  })

  it.each([
    'url(https://attacker.invalid/beacon)',
    'var(--foreground)',
    '#fff; background: #000',
    '#fff}'
  ])('rejects unsafe CSS token value %s', (value) => {
    expect(
      parsePluginAppThemeArtifact(
        JSON.stringify({ base: 'light', tokens: { '--background': value } })
      ).ok
    ).toBe(false)
  })
})
