import React from 'react'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import {
  getAgentLaunchProfilesDescription,
  getAgentLaunchProfilesTitle
} from './agent-launch-profiles-copy'
import { SettingsSwitchRow } from './SettingsFormControls'

type AgentLaunchProfilesSettingProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void | Promise<void>
}

/** Off by default: the pickers add a submenu and a select most users never need. */
export function AgentLaunchProfilesSetting({
  settings,
  updateSettings
}: AgentLaunchProfilesSettingProps): React.JSX.Element {
  const enabled = settings.agentLaunchProfilesEnabled === true
  return (
    <section className="space-y-3">
      <SettingsSwitchRow
        label={getAgentLaunchProfilesTitle()}
        description={getAgentLaunchProfilesDescription()}
        checked={enabled}
        onChange={() => updateSettings({ agentLaunchProfilesEnabled: !enabled })}
        ariaLabel={getAgentLaunchProfilesTitle()}
      />
    </section>
  )
}
