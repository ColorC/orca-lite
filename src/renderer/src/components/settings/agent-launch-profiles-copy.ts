import { translate } from '@/i18n/i18n'
import { searchKeywords } from './settings-search-keywords'

const AGENT_LAUNCH_PROFILES_TITLE_KEY = 'auto.components.settings.agent-launch-profiles-copy.title'
const AGENT_LAUNCH_PROFILES_DESCRIPTION_KEY =
  'auto.components.settings.agent-launch-profiles-copy.description'

export function getAgentLaunchProfilesTitle(): string {
  return translate(AGENT_LAUNCH_PROFILES_TITLE_KEY, 'Agent launch profiles')
}

export function getAgentLaunchProfilesDescription(): string {
  return translate(
    AGENT_LAUNCH_PROFILES_DESCRIPTION_KEY,
    'Offer a second credential home or a provider profile when launching Codex or Claude, in the tab bar, the New Workspace composer and Orca Mobile. Off by default; the CLI and paired clients can pass a profile either way.'
  )
}

export function getAgentLaunchProfilesSearchKeywords(): string[] {
  return searchKeywords([
    { key: 'auto.components.settings.agents.search.launchProfile', fallback: 'launch profile' },
    { key: 'auto.components.settings.agents.search.secondAccount', fallback: 'second account' },
    { key: 'auto.components.settings.agents.search.provider', fallback: 'provider' },
    {
      key: 'auto.components.settings.agents.search.f412abbba5',
      fallback: 'claude',
      englishOnly: true
    },
    {
      key: 'auto.components.settings.agents.search.5ded38b843',
      fallback: 'codex',
      englishOnly: true
    }
  ])
}
