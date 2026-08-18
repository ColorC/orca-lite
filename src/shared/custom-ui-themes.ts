/** Imported app themes: shadcn/Tweakcn JSON palettes or Tailwind v4 CSS variable
 *  sheets, applied over `main.css` at runtime. Values arrive as user-pasted text
 *  from the open internet, so every entry point re-normalizes rather than trusting
 *  a caller upstream. */

export type CustomUiThemeSource = 'json' | 'css'
export type CustomUiThemeMode = 'light' | 'dark'

export type CustomUiThemeVars = Record<string, string>

export type CustomUiTheme = {
  id: string
  name: string
  source: CustomUiThemeSource
  light: CustomUiThemeVars
  dark: CustomUiThemeVars
  importedAt: string
}

export const MAX_CUSTOM_UI_THEMES = 50
export const MAX_CUSTOM_UI_THEME_INPUT_CHARS = 200_000
const MAX_NAME_CHARS = 60
const MAX_VALUE_CHARS = 120

/** Tokens a theme may set. Deliberately the shadcn/Tweakcn surface only — see
 *  DERIVED_TOKENS for how the app's own tokens follow along. */
export const THEMABLE_TOKENS = [
  'background',
  'foreground',
  'card',
  'card-foreground',
  'popover',
  'popover-foreground',
  'primary',
  'primary-foreground',
  'secondary',
  'secondary-foreground',
  'muted',
  'muted-foreground',
  'accent',
  'accent-foreground',
  'destructive',
  'destructive-foreground',
  'border',
  'input',
  'ring',
  'chart-1',
  'chart-2',
  'chart-3',
  'chart-4',
  'chart-5',
  'sidebar',
  'sidebar-foreground',
  'sidebar-primary',
  'sidebar-primary-foreground',
  'sidebar-accent',
  'sidebar-accent-foreground',
  'sidebar-border',
  'sidebar-ring',
  'radius'
] as const

const THEMABLE_TOKEN_SET: ReadonlySet<string> = new Set<string>(THEMABLE_TOKENS)

/** App-specific tokens a shadcn palette never carries. Without these the sidebar,
 *  tab strip, and editor pane keep the stock colors and read as unthemed patches. */
export const DERIVED_TOKENS: Readonly<Record<string, readonly string[]>> = {
  background: ['settings-canvas'],
  card: ['editor-surface', 'settings-panel'],
  border: ['settings-panel-border'],
  sidebar: ['worktree-sidebar'],
  'sidebar-foreground': ['worktree-sidebar-foreground'],
  'sidebar-accent': ['worktree-sidebar-accent'],
  'sidebar-accent-foreground': ['worktree-sidebar-accent-foreground'],
  'sidebar-border': ['worktree-sidebar-border'],
  'sidebar-ring': ['worktree-sidebar-ring']
}

/** `--orca-security-*` is never themable: plugin-marketplace trust surfaces must
 *  keep host-owned contrast so a pack cannot disguise a consent decision. */
const FORBIDDEN_TOKEN_PREFIX = 'orca-security'

/** `url()` would let a pasted theme phone home; the rest can break out of the
 *  declaration we inject it into. */
const FORBIDDEN_VALUE_RE = /url\s*\(|var\s*\(|@import|expression\s*\(|javascript:|[;{}<>\\]/i
const ALLOWED_VALUE_RE = /^[#a-z0-9\s.,%()/-]+$/i

function normalizeTokenName(raw: string): string | null {
  const name = raw.trim().replace(/^--/, '').toLowerCase()
  if (!name || name.startsWith(FORBIDDEN_TOKEN_PREFIX)) {
    return null
  }
  return THEMABLE_TOKEN_SET.has(name) ? name : null
}

function normalizeTokenValue(raw: unknown): string | null {
  if (typeof raw !== 'string') {
    return null
  }
  const value = raw.trim()
  if (!value || value.length > MAX_VALUE_CHARS) {
    return null
  }
  if (FORBIDDEN_VALUE_RE.test(value) || !ALLOWED_VALUE_RE.test(value)) {
    return null
  }
  return value
}

function collectVars(entries: Iterable<[string, unknown]>): CustomUiThemeVars {
  const vars: CustomUiThemeVars = {}
  for (const [rawName, rawValue] of entries) {
    const name = normalizeTokenName(rawName)
    const value = normalizeTokenValue(rawValue)
    if (name && value) {
      vars[name] = value
    }
  }
  return vars
}

function parseCssBlock(css: string, selector: string): CustomUiThemeVars {
  // Tolerates `:root`, `:root, .light`, `.dark`, `@layer base { :root { … } }`.
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const block = new RegExp(`${escaped}[^{]*\\{([^}]*)\\}`, 'i').exec(css)
  if (!block) {
    return {}
  }
  const declarations = block[1].matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/gi)
  return collectVars(Array.from(declarations, (m) => [m[1], m[2]] as [string, unknown]))
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

/** Tweakcn nests under `cssVars`, plain shadcn registries use top-level keys, and
 *  `theme` holds values shared by both modes. */
function parseJsonPalette(raw: string): { light: CustomUiThemeVars; dark: CustomUiThemeVars } {
  const parsed = asRecord(JSON.parse(raw))
  const root = asRecord(parsed.cssVars ?? parsed)
  const shared = collectVars(Object.entries(asRecord(root.theme)))
  return {
    light: { ...shared, ...collectVars(Object.entries(asRecord(root.light ?? root.root))) },
    dark: { ...shared, ...collectVars(Object.entries(asRecord(root.dark))) }
  }
}

export type CustomUiThemeParseResult =
  | { ok: true; light: CustomUiThemeVars; dark: CustomUiThemeVars; source: CustomUiThemeSource }
  | { ok: false; reason: 'empty' | 'too-large' | 'unparsable' | 'no-tokens' }

export function parseCustomUiTheme(input: string): CustomUiThemeParseResult {
  const text = input.trim()
  if (!text) {
    return { ok: false, reason: 'empty' }
  }
  if (text.length > MAX_CUSTOM_UI_THEME_INPUT_CHARS) {
    return { ok: false, reason: 'too-large' }
  }

  const looksJson = text.startsWith('{') || text.startsWith('[')
  let light: CustomUiThemeVars
  let dark: CustomUiThemeVars
  let source: CustomUiThemeSource

  if (looksJson) {
    try {
      ;({ light, dark } = parseJsonPalette(text))
    } catch {
      return { ok: false, reason: 'unparsable' }
    }
    source = 'json'
  } else {
    light = { ...parseCssBlock(text, ':root'), ...parseCssBlock(text, '.light') }
    dark = parseCssBlock(text, '.dark')
    source = 'css'
  }

  if (Object.keys(light).length === 0 && Object.keys(dark).length === 0) {
    return { ok: false, reason: 'no-tokens' }
  }
  // A theme that only defines one mode still applies to that mode; the other
  // falls back to the built-in palette rather than inheriting mismatched colors.
  return { ok: true, light, dark, source }
}

function normalizeName(raw: unknown, fallback: string): string {
  const name = typeof raw === 'string' ? raw.trim().replace(/\s+/g, ' ') : ''
  return (name || fallback).slice(0, MAX_NAME_CHARS)
}

function normalizeTheme(value: unknown): CustomUiTheme | null {
  const record = asRecord(value)
  const id = typeof record.id === 'string' ? record.id.trim().slice(0, 64) : ''
  if (!id) {
    return null
  }
  const light = collectVars(Object.entries(asRecord(record.light)))
  const dark = collectVars(Object.entries(asRecord(record.dark)))
  if (Object.keys(light).length === 0 && Object.keys(dark).length === 0) {
    return null
  }
  return {
    id,
    name: normalizeName(record.name, id),
    source: record.source === 'json' ? 'json' : 'css',
    light,
    dark,
    importedAt: typeof record.importedAt === 'string' ? record.importedAt : ''
  }
}

/** Every persistence, IPC, and store boundary runs this — the stored blob is as
 *  untrusted as the paste that created it. */
export function normalizeCustomUiThemes(value: unknown): CustomUiTheme[] {
  if (!Array.isArray(value)) {
    return []
  }
  const seen = new Set<string>()
  const themes: CustomUiTheme[] = []
  for (const entry of value) {
    const theme = normalizeTheme(entry)
    if (!theme || seen.has(theme.id)) {
      continue
    }
    seen.add(theme.id)
    themes.push(theme)
    if (themes.length >= MAX_CUSTOM_UI_THEMES) {
      break
    }
  }
  return themes
}

/** Expands a theme into the CSS custom properties to set, including the app's own
 *  tokens derived from their shadcn counterparts. */
export function resolveCustomUiThemeVars(
  theme: CustomUiTheme,
  mode: CustomUiThemeMode
): CustomUiThemeVars {
  const source = mode === 'dark' ? theme.dark : theme.light
  const resolved: CustomUiThemeVars = {}
  for (const [name, value] of Object.entries(source)) {
    resolved[`--${name}`] = value
    for (const derived of DERIVED_TOKENS[name] ?? []) {
      // An explicit value for the derived token always wins over the derivation.
      if (!(derived in source)) {
        resolved[`--${derived}`] = value
      }
    }
  }
  return resolved
}

export function hasModeVars(theme: CustomUiTheme, mode: CustomUiThemeMode): boolean {
  return Object.keys(mode === 'dark' ? theme.dark : theme.light).length > 0
}
