import { useEffect } from 'react'
import { buildAppFontFamily } from '@/lib/app-font-family'
import { applyCustomUiTheme, findCustomUiTheme } from '../lib/custom-ui-theme-apply'
import {
  applyDocumentTheme,
  applyPluginAppTheme,
  resolveDocumentTheme
} from '../lib/document-theme'
import { scheduleRuntimeGraphSync } from '../runtime/sync-runtime-graph'
import { useAppStore } from '../store'
import { usePluginIconThemeStore, usePluginIconThemes } from '../store/plugin-icon-themes'
import { usePluginTerminalThemes } from '../store/plugin-terminal-themes'
import { usePluginThemes } from '../store/plugin-themes'

/** Applies the settings-driven theme and app font to the document root. */
export function useDocumentAppearance(): void {
  const activeCustomUiThemeId = useAppStore((s) => s.settings?.activeCustomUiThemeId)
  const customUiThemes = useAppStore((s) => s.settings?.customUiThemes)
  const pluginAppTheme = useAppStore((s) => s.settings?.pluginAppTheme)
  const pluginIconTheme = useAppStore((s) => s.settings?.pluginIconTheme)
  const theme = useAppStore((s) => s.settings?.theme)
  const appFontFamily = useAppStore((s) => s.settings?.appFontFamily)
  const pluginThemes = usePluginThemes()
  usePluginIconThemes()
  const pluginTerminalThemes = usePluginTerminalThemes()
  const setActivePluginIconTheme = usePluginIconThemeStore((state) => state.setActiveId)
  const activePluginTheme =
    pluginThemes.find((pluginTheme) => pluginTheme.id === pluginAppTheme) ?? null

  useEffect(() => {
    setActivePluginIconTheme(pluginIconTheme ?? null)
  }, [pluginIconTheme, setActivePluginIconTheme])

  useEffect(() => {
    // Plugin palettes do not mutate settings, so hidden terminals need an explicit refresh.
    scheduleRuntimeGraphSync()
  }, [pluginTerminalThemes])

  useEffect(() => {
    if (!theme) {
      return
    }

    const active = findCustomUiTheme(customUiThemes, activeCustomUiThemeId)
    const applyActiveCustomTheme = (): void => {
      applyCustomUiTheme(active, resolveDocumentTheme(theme) ? 'dark' : 'light')
    }
    applyActiveCustomTheme()
    if (theme !== 'system') {
      return
    }
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    mq.addEventListener('change', applyActiveCustomTheme)
    return () => mq.removeEventListener('change', applyActiveCustomTheme)
  }, [activeCustomUiThemeId, customUiThemes, theme])

  useEffect(() => {
    if (!theme) {
      return
    }

    applyPluginAppTheme(activePluginTheme)
    const themePreference = activePluginTheme?.base ?? theme
    if (themePreference === 'dark') {
      applyDocumentTheme('dark')
      return undefined
    } else if (themePreference === 'light') {
      applyDocumentTheme('light')
      return undefined
    }
    // system
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    applyDocumentTheme('system')
    const handler = (): void => {
      applyDocumentTheme('system')
      // System theme changes don't mutate the store, so mobile terminal colors need an explicit graph republish.
      scheduleRuntimeGraphSync()
    }
    mq.addEventListener('change', handler)
    return () => mq.removeEventListener('change', handler)
  }, [activePluginTheme, theme])

  useEffect(() => {
    document.documentElement.style.setProperty(
      '--app-font-family',
      buildAppFontFamily(appFontFamily)
    )
  }, [appFontFamily])
}
