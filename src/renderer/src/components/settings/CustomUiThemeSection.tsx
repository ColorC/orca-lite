import type React from 'react'
import { useState } from 'react'
import { Trash2 } from 'lucide-react'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import {
  MAX_CUSTOM_UI_THEMES,
  parseCustomUiTheme,
  type CustomUiTheme
} from '../../../../shared/custom-ui-themes'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Textarea } from '../ui/textarea'
import { Label } from '../ui/label'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'

type CustomUiThemeSectionProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
}

function createThemeId(): string {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `ui-theme-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
  )
}

function parseFailureMessage(reason: string): string {
  switch (reason) {
    case 'empty':
      return translate('settings.appearance.customUiTheme.error.empty', 'Paste a theme first.')
    case 'too-large':
      return translate(
        'settings.appearance.customUiTheme.error.tooLarge',
        'That theme is too large.'
      )
    case 'unparsable':
      return translate(
        'settings.appearance.customUiTheme.error.unparsable',
        'That does not look like valid JSON.'
      )
    default:
      return translate(
        'settings.appearance.customUiTheme.error.noTokens',
        'No usable color variables found. Paste a shadcn/Tweakcn palette or a CSS :root block.'
      )
  }
}

export function CustomUiThemeSection({
  settings,
  updateSettings
}: CustomUiThemeSectionProps): React.JSX.Element {
  const themes = settings.customUiThemes ?? []
  const activeId = settings.activeCustomUiThemeId ?? ''
  const [name, setName] = useState('')
  const [source, setSource] = useState('')
  const [error, setError] = useState<string | null>(null)

  const atCapacity = themes.length >= MAX_CUSTOM_UI_THEMES

  function handleImport(): void {
    const parsed = parseCustomUiTheme(source)
    if (!parsed.ok) {
      setError(parseFailureMessage(parsed.reason))
      return
    }
    const theme: CustomUiTheme = {
      id: createThemeId(),
      name:
        name.trim() || translate('settings.appearance.customUiTheme.untitled', 'Imported theme'),
      source: parsed.source,
      light: parsed.light,
      dark: parsed.dark,
      importedAt: new Date().toISOString()
    }
    updateSettings({
      customUiThemes: [...themes, theme],
      activeCustomUiThemeId: theme.id,
      pluginAppTheme: null
    })
    setName('')
    setSource('')
    setError(null)
  }

  function handleDelete(id: string): void {
    updateSettings({
      customUiThemes: themes.filter((theme) => theme.id !== id),
      // Deleting the applied theme falls back to the built-in palette.
      ...(activeId === id ? { activeCustomUiThemeId: '' } : {})
    })
  }

  // The disclosure that hosts this section already renders the title.
  return (
    <section className="space-y-3">
      <div className="space-y-2">
        <div className="space-y-1">
          <Label htmlFor="custom-ui-theme-source">
            {translate('settings.appearance.customUiTheme.paste.label', 'Theme source')}
          </Label>
          <p className="text-xs text-muted-foreground">
            {translate(
              'settings.appearance.customUiTheme.paste.description',
              'Paste a shadcn/Tweakcn JSON palette or a CSS sheet with :root and .dark blocks.'
            )}
          </p>
        </div>
        <Textarea
          id="custom-ui-theme-source"
          value={source}
          onChange={(event) => {
            setSource(event.target.value)
            setError(null)
          }}
          rows={5}
          spellCheck={false}
          className="font-mono text-xs"
          placeholder=":root { --background: #eff1f5; ... }"
          aria-invalid={error !== null}
        />
        {error ? <p className="text-xs text-destructive">{error}</p> : null}
      </div>

      <div className="flex items-end gap-2">
        <div className="flex-1 space-y-1">
          <Label htmlFor="custom-ui-theme-name">
            {translate('settings.appearance.customUiTheme.name.label', 'Name')}
          </Label>
          <Input
            id="custom-ui-theme-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder={translate(
              'settings.appearance.customUiTheme.name.placeholder',
              'Catppuccin Latte'
            )}
          />
        </div>
        <Button onClick={handleImport} disabled={atCapacity || source.trim().length === 0}>
          {translate('settings.appearance.customUiTheme.import', 'Import')}
        </Button>
      </div>

      {atCapacity ? (
        <p className="text-xs text-muted-foreground">
          {translate(
            'settings.appearance.customUiTheme.atCapacity',
            'Theme limit reached. Delete one to import another.'
          )}
        </p>
      ) : null}

      {themes.length > 0 ? (
        <div className="space-y-1">
          <Label>
            {translate('settings.appearance.customUiTheme.imported', 'Imported themes')}
          </Label>
          <ul className="divide-y divide-border rounded-md border border-border">
            <li className="flex items-center justify-between gap-2 px-3 py-2">
              <button
                type="button"
                onClick={() => updateSettings({ activeCustomUiThemeId: '', pluginAppTheme: null })}
                className={cn(
                  'flex-1 truncate text-left text-[13px]',
                  activeId === '' ? 'font-medium text-foreground' : 'text-muted-foreground'
                )}
              >
                {translate('settings.appearance.customUiTheme.builtIn', 'Built-in palette')}
              </button>
            </li>
            {themes.map((theme) => (
              <li key={theme.id} className="flex items-center justify-between gap-2 px-3 py-2">
                <button
                  type="button"
                  onClick={() =>
                    updateSettings({ activeCustomUiThemeId: theme.id, pluginAppTheme: null })
                  }
                  className={cn(
                    'flex-1 truncate text-left text-[13px]',
                    activeId === theme.id ? 'font-medium text-foreground' : 'text-muted-foreground'
                  )}
                >
                  {theme.name}
                </button>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  onClick={() => handleDelete(theme.id)}
                  aria-label={translate('settings.appearance.customUiTheme.delete', 'Delete theme')}
                >
                  <Trash2 />
                </Button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  )
}
