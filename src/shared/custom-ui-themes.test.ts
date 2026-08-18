import { describe, expect, it } from 'vitest'
import {
  MAX_CUSTOM_UI_THEMES,
  MAX_CUSTOM_UI_THEME_INPUT_CHARS,
  normalizeCustomUiThemes,
  parseCustomUiTheme,
  resolveCustomUiThemeVars,
  type CustomUiTheme
} from './custom-ui-themes'

function theme(overrides: Partial<CustomUiTheme> = {}): CustomUiTheme {
  return {
    id: 'catppuccin-latte',
    name: 'Catppuccin Latte',
    source: 'css',
    light: { background: '#eff1f5', foreground: '#4c4f69' },
    dark: { background: '#1e1e2e', foreground: '#cdd6f4' },
    importedAt: '2026-08-18T00:00:00.000Z',
    ...overrides
  }
}

describe('parseCustomUiTheme — CSS sheets', () => {
  it('reads :root and .dark into separate modes', () => {
    const result = parseCustomUiTheme(`
      @import "tailwindcss";
      :root { --background: #eff1f5; --foreground: #4c4f69; }
      .dark { --background: #1e1e2e; --foreground: #cdd6f4; }
    `)

    expect(result).toMatchObject({
      ok: true,
      source: 'css',
      light: { background: '#eff1f5', foreground: '#4c4f69' },
      dark: { background: '#1e1e2e', foreground: '#cdd6f4' }
    })
  })

  it('accepts a selector list and modern color functions', () => {
    const result = parseCustomUiTheme(
      ':root, .light { --primary: oklch(0.55 0.12 250 / 80%); --ring: hsl(220 20% 50%); }'
    )

    expect(result).toMatchObject({
      ok: true,
      light: { primary: 'oklch(0.55 0.12 250 / 80%)', ring: 'hsl(220 20% 50%)' }
    })
  })

  it('applies a light-only sheet without inventing dark values', () => {
    const result = parseCustomUiTheme(':root { --background: #eff1f5; }')

    expect(result).toMatchObject({ ok: true, dark: {} })
  })
})

describe('parseCustomUiTheme — JSON palettes', () => {
  it('reads the Tweakcn cssVars shape and merges shared theme tokens', () => {
    const result = parseCustomUiTheme(
      JSON.stringify({
        cssVars: {
          theme: { radius: '0.5rem' },
          light: { background: '#eff1f5' },
          dark: { background: '#1e1e2e' }
        }
      })
    )

    expect(result).toMatchObject({
      ok: true,
      source: 'json',
      light: { background: '#eff1f5', radius: '0.5rem' },
      dark: { background: '#1e1e2e', radius: '0.5rem' }
    })
  })

  it('reads a plain top-level light/dark registry', () => {
    const result = parseCustomUiTheme(
      JSON.stringify({ light: { background: '#fff' }, dark: { background: '#000' } })
    )

    expect(result).toMatchObject({ ok: true, light: { background: '#fff' } })
  })

  it('reports unparsable JSON instead of falling through to the CSS reader', () => {
    expect(parseCustomUiTheme('{ not json')).toEqual({ ok: false, reason: 'unparsable' })
  })
})

describe('parseCustomUiTheme — untrusted input', () => {
  it('drops url() so a pasted theme cannot call out to the network', () => {
    const result = parseCustomUiTheme(
      ':root { --background: url(https://evil.example/x.png); --foreground: #4c4f69; }'
    )

    expect(result).toMatchObject({ ok: true, light: { foreground: '#4c4f69' } })
    expect((result as { light: Record<string, string> }).light.background).toBeUndefined()
  })

  it.each([
    ['var() indirection', ':root { --foreground: var(--secret); }', 'foreground'],
    ['brace break-out', ':root { --border: #fff} .evil {display:none; }', 'border']
  ])('drops %s', (_label, css, token) => {
    const result = parseCustomUiTheme(css) as { ok: boolean; light?: Record<string, string> }
    expect(result.light?.[token]).toBeUndefined()
  })

  it('takes only custom properties, not ordinary declarations sharing the block', () => {
    const result = parseCustomUiTheme(':root { --background: #fff; color: red; }')

    expect(result).toMatchObject({ ok: true, light: { background: '#fff' } })
    expect(Object.keys((result as { light: Record<string, string> }).light)).toEqual(['background'])
  })

  it('refuses to theme the plugin trust surface', () => {
    const result = parseCustomUiTheme(
      ':root { --orca-security-background: #000; --background: #eff1f5; }'
    )

    expect(result).toMatchObject({ ok: true, light: { background: '#eff1f5' } })
    expect(Object.keys((result as { light: Record<string, string> }).light)).toEqual(['background'])
  })

  it('ignores tokens outside the themable set', () => {
    const result = parseCustomUiTheme(
      ':root { --git-decoration-added: #ff0000; --background: #eff1f5; }'
    )

    expect(Object.keys((result as { light: Record<string, string> }).light)).toEqual(['background'])
  })

  it.each([
    ['empty', '   ', 'empty'],
    ['no recognizable tokens', ':root { --totally-unknown: #fff; }', 'no-tokens'],
    [
      'oversized',
      `:root{--background:#fff;}${'/*x*/'.repeat(MAX_CUSTOM_UI_THEME_INPUT_CHARS)}`,
      'too-large'
    ]
  ])('rejects %s input', (_label, input, reason) => {
    expect(parseCustomUiTheme(input)).toEqual({ ok: false, reason })
  })
})

describe('resolveCustomUiThemeVars', () => {
  it('derives the app tokens a shadcn palette never carries', () => {
    const vars = resolveCustomUiThemeVars(
      theme({ light: { sidebar: '#e6e9ef', card: '#eff1f5', background: '#dce0e8' } }),
      'light'
    )

    // Without these the worktree rail, editor pane, and settings page stay unthemed.
    expect(vars['--worktree-sidebar']).toBe('#e6e9ef')
    expect(vars['--editor-surface']).toBe('#eff1f5')
    expect(vars['--settings-panel']).toBe('#eff1f5')
    expect(vars['--settings-canvas']).toBe('#dce0e8')
  })

  it('lets an explicit value win over the derivation', () => {
    const vars = resolveCustomUiThemeVars(
      theme({ light: { sidebar: '#e6e9ef', 'sidebar-border': '#ccd0da' } }),
      'light'
    )

    expect(vars['--worktree-sidebar-border']).toBe('#ccd0da')
  })

  it('selects the mode being rendered', () => {
    expect(resolveCustomUiThemeVars(theme(), 'dark')['--background']).toBe('#1e1e2e')
    expect(resolveCustomUiThemeVars(theme(), 'light')['--background']).toBe('#eff1f5')
  })
})

describe('normalizeCustomUiThemes', () => {
  it('returns an empty list for anything that is not an array', () => {
    for (const value of [null, undefined, {}, 'x', 3]) {
      expect(normalizeCustomUiThemes(value)).toEqual([])
    }
  })

  it('re-sanitizes stored values rather than trusting the blob on disk', () => {
    const [stored] = normalizeCustomUiThemes([
      { id: 'x', name: 'X', light: { background: '#fff', 'orca-security-card': '#000' }, dark: {} }
    ])

    expect(stored.light).toEqual({ background: '#fff' })
  })

  it('drops entries with no id, no usable tokens, or a duplicate id', () => {
    expect(
      normalizeCustomUiThemes([
        { id: '', light: { background: '#fff' } },
        { id: 'y', light: {}, dark: {} },
        { id: 'z', light: { background: '#fff' } },
        { id: 'z', light: { background: '#000' } }
      ]).map((t) => t.id)
    ).toEqual(['z'])
  })

  it('caps the stored list', () => {
    const many = Array.from({ length: MAX_CUSTOM_UI_THEMES + 10 }, (_, i) => ({
      id: `t${i}`,
      light: { background: '#fff' }
    }))

    expect(normalizeCustomUiThemes(many)).toHaveLength(MAX_CUSTOM_UI_THEMES)
  })
})
