import {
  hasModeVars,
  resolveCustomUiThemeVars,
  type CustomUiTheme,
  type CustomUiThemeMode
} from '../../../shared/custom-ui-themes'

/** Which properties the last apply set, so the next one can undo exactly those.
 *  Kept on the element rather than in module state: popout and pet windows each
 *  have their own document, and a stale module list would clear the wrong root. */
const APPLIED_PROPS_ATTR = 'data-custom-ui-theme-props'
const ACTIVE_THEME_ATTR = 'data-custom-ui-theme'

function clearApplied(root: HTMLElement): void {
  const applied = root.getAttribute(APPLIED_PROPS_ATTR)
  if (applied) {
    for (const prop of applied.split(' ')) {
      root.style.removeProperty(prop)
    }
  }
  root.removeAttribute(APPLIED_PROPS_ATTR)
  root.removeAttribute(ACTIVE_THEME_ATTR)
}

/** Paints an imported theme as inline custom properties on the root, which win
 *  over `main.css` without touching the stylesheet. Passing null restores the
 *  built-in palette. Idempotent: re-applying replaces the previous set. */
export function applyCustomUiTheme(
  theme: CustomUiTheme | null,
  mode: CustomUiThemeMode,
  root: HTMLElement = document.documentElement
): void {
  clearApplied(root)
  // A theme that only defines one mode leaves the other on the built-in palette
  // rather than showing colors meant for the opposite mode.
  if (!theme || !hasModeVars(theme, mode)) {
    return
  }

  const vars = resolveCustomUiThemeVars(theme, mode)
  const props = Object.keys(vars)
  if (props.length === 0) {
    return
  }
  for (const prop of props) {
    root.style.setProperty(prop, vars[prop])
  }
  root.setAttribute(APPLIED_PROPS_ATTR, props.join(' '))
  root.setAttribute(ACTIVE_THEME_ATTR, theme.id)
}

export function findCustomUiTheme(
  themes: readonly CustomUiTheme[] | undefined,
  id: string | undefined
): CustomUiTheme | null {
  if (!id) {
    return null
  }
  return themes?.find((theme) => theme.id === id) ?? null
}
