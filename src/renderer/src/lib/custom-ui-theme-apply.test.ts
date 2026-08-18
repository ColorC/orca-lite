// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest'
import { applyCustomUiTheme, findCustomUiTheme } from './custom-ui-theme-apply'
import type { CustomUiTheme } from '../../../shared/custom-ui-themes'

function theme(overrides: Partial<CustomUiTheme> = {}): CustomUiTheme {
  return {
    id: 'latte',
    name: 'Latte',
    source: 'css',
    light: { background: '#eff1f5', sidebar: '#e6e9ef' },
    dark: { background: '#1e1e2e' },
    importedAt: '',
    ...overrides
  }
}

describe('applyCustomUiTheme', () => {
  let root: HTMLElement

  beforeEach(() => {
    root = document.createElement('div')
  })

  it('paints the mode being rendered, including derived tokens', () => {
    applyCustomUiTheme(theme(), 'light', root)

    expect(root.style.getPropertyValue('--background')).toBe('#eff1f5')
    expect(root.style.getPropertyValue('--worktree-sidebar')).toBe('#e6e9ef')
    expect(root.getAttribute('data-custom-ui-theme')).toBe('latte')
  })

  it('removes exactly what it set when switching themes', () => {
    applyCustomUiTheme(theme(), 'light', root)
    applyCustomUiTheme(
      theme({ id: 'other', light: { foreground: '#000' }, dark: {} }),
      'light',
      root
    )

    // The first theme's sidebar must not linger under the second.
    expect(root.style.getPropertyValue('--worktree-sidebar')).toBe('')
    expect(root.style.getPropertyValue('--foreground')).toBe('#000')
    expect(root.getAttribute('data-custom-ui-theme')).toBe('other')
  })

  it('restores the built-in palette when passed null', () => {
    applyCustomUiTheme(theme(), 'light', root)
    applyCustomUiTheme(null, 'light', root)

    expect(root.getAttribute('style')).toBeFalsy()
    expect(root.hasAttribute('data-custom-ui-theme')).toBe(false)
  })

  it('leaves a mode the theme does not define on the built-in palette', () => {
    applyCustomUiTheme(theme({ dark: {} }), 'dark', root)

    expect(root.hasAttribute('data-custom-ui-theme')).toBe(false)
    expect(root.style.getPropertyValue('--background')).toBe('')
  })
})

describe('findCustomUiTheme', () => {
  it('returns null for an empty or unknown id', () => {
    expect(findCustomUiTheme([theme()], undefined)).toBeNull()
    expect(findCustomUiTheme([theme()], '')).toBeNull()
    expect(findCustomUiTheme([theme()], 'missing')).toBeNull()
    expect(findCustomUiTheme(undefined, 'latte')).toBeNull()
  })

  it('finds by id', () => {
    expect(findCustomUiTheme([theme()], 'latte')?.name).toBe('Latte')
  })
})
