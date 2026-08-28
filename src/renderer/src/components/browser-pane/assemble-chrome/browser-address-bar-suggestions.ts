import {
  buildSearchUrl,
  DEFAULT_SEARCH_ENGINE,
  looksLikeSearchQuery,
  normalizeBrowserNavigationUrl,
  SEARCH_ENGINE_LABELS,
  type SearchEngine
} from '../../../../../shared/browser-url'
import type { BrowserHistoryEntry } from '../../../../../shared/browser-workspace-types'
import { matchBrowserHistory, prepareBrowserHistoryEntries } from '@/lib/browser-history-match'
import { isClipboardTextByteLengthOverLimit } from '../../../../../shared/clipboard-text'
import { translate } from '@/i18n/i18n'

export const MAX_BROWSER_ADDRESS_BAR_SUGGESTIONS = 8
export const BROWSER_ADDRESS_BAR_QUERY_MAX_BYTES = 2 * 1024

export type BrowserAddressBarSuggestion = {
  url: string
  title: string
  subtitle: string
  lastVisitedAt: number
  visitCount: number
  isSearch: boolean
}

export function isBrowserAddressBarQueryTooLarge(
  query: string,
  maxBytes = BROWSER_ADDRESS_BAR_QUERY_MAX_BYTES
): boolean {
  return isClipboardTextByteLengthOverLimit(query, maxBytes)
}

export function buildBrowserAddressBarSuggestions({
  browserUrlHistory,
  kagiSessionLink,
  searchEngine = DEFAULT_SEARCH_ENGINE,
  value
}: {
  browserUrlHistory: readonly BrowserHistoryEntry[]
  kagiSessionLink?: string | null
  searchEngine?: SearchEngine
  value: string
}): BrowserAddressBarSuggestion[] {
  if (isBrowserAddressBarQueryTooLarge(value)) {
    return []
  }
  const trimmed = value.trim()
  if (trimmed === '' || trimmed === 'about:blank' || trimmed.startsWith('data:')) {
    if (browserUrlHistory.length === 0) {
      return []
    }
    return [...browserUrlHistory]
      .sort((a, b) => b.lastVisitedAt - a.lastVisitedAt)
      .slice(0, MAX_BROWSER_ADDRESS_BAR_SUGGESTIONS)
      .map((entry) => ({ ...entry, subtitle: entry.url, isSearch: false }))
  }
  // Why url-tail is kept here: the address bar is a navigation surface, so a
  // path-only recall is still a destination — it just never outranks a real one.
  const historySuggestions: BrowserAddressBarSuggestion[] = matchBrowserHistory({
    prepared: prepareBrowserHistoryEntries(browserUrlHistory),
    query: trimmed,
    limit: MAX_BROWSER_ADDRESS_BAR_SUGGESTIONS - 1
  }).map((match) => ({ ...match.entry, subtitle: match.entry.url, isSearch: false }))

  const isQuery = looksLikeSearchQuery(trimmed)
  let topAction: BrowserAddressBarSuggestion | null
  if (isQuery) {
    topAction = {
      url: buildSearchUrl(trimmed, searchEngine, { kagiSessionLink }),
      title: trimmed,
      subtitle: translate(
        'auto.components.browser.pane.browser.address.bar.suggestions.87fcdd0da9',
        '{{value0}} Search',
        { value0: SEARCH_ENGINE_LABELS[searchEngine] }
      ),
      lastVisitedAt: 0,
      visitCount: 0,
      isSearch: true
    }
  } else {
    const normalizedUrl = normalizeBrowserNavigationUrl(trimmed, searchEngine, {
      kagiSessionLink
    })
    // Why: rejected schemes must use the submit path's validation error;
    // a synthetic row would pass the raw string straight to webview.src.
    topAction = normalizedUrl
      ? {
          url: normalizedUrl,
          title: trimmed,
          subtitle: '',
          lastVisitedAt: 0,
          visitCount: 0,
          isSearch: false
        }
      : null
  }

  if (!topAction) {
    return historySuggestions.slice(0, MAX_BROWSER_ADDRESS_BAR_SUGGESTIONS)
  }

  // Why: the history row gives Enter the same target while showing real page metadata.
  const duplicateIdx = historySuggestions.findIndex((h) => h.url === topAction.url)
  if (duplicateIdx !== -1) {
    return historySuggestions.slice(0, MAX_BROWSER_ADDRESS_BAR_SUGGESTIONS)
  }

  return [topAction, ...historySuggestions].slice(0, MAX_BROWSER_ADDRESS_BAR_SUGGESTIONS)
}
