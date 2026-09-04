import {
  findAgentLaunchProfile,
  resolveAgentLaunchProfiles,
  type AgentLaunchProfile
} from '../../shared/agent-launch-profile/agent-launch-profile'
import type { GlobalSettings } from '../../shared/global-settings-types'
import type { TuiAgent } from '../../shared/tui-agent'

export const AGENT_SESSION_LAUNCH_PROFILE_UNKNOWN = 'agent_session_launch_profile_unknown'
export const AGENT_SESSION_LAUNCH_PROFILE_AGENT_MISMATCH =
  'agent_session_launch_profile_agent_mismatch'
export const AGENT_SESSION_LAUNCH_PROFILE_REMOTE_UNSUPPORTED =
  'agent_session_launch_profile_remote_unsupported'

/**
 * Resolves a client-supplied profile id against this host's catalog. Named errors let a
 * client built for a newer catalog tell "unknown here" from "wrong agent" from "not on SSH".
 */
export function resolveRequestedAgentLaunchProfile(args: {
  agent: TuiAgent
  launchProfileId: string | null | undefined
  settings: Pick<GlobalSettings, 'agentLaunchProfiles'>
  isRemote: boolean
}): AgentLaunchProfile | null {
  if (!args.launchProfileId) {
    return null
  }
  const profiles = resolveAgentLaunchProfiles(args.settings.agentLaunchProfiles)
  const profile = findAgentLaunchProfile(profiles, args.agent, args.launchProfileId)
  if (!profile) {
    throw new Error(
      profiles.some((candidate) => candidate.id === args.launchProfileId)
        ? AGENT_SESSION_LAUNCH_PROFILE_AGENT_MISMATCH
        : AGENT_SESSION_LAUNCH_PROFILE_UNKNOWN
    )
  }
  // Why: a secondary home is resolved on the execution host, which for SSH is a machine this
  // runtime cannot inspect; refuse rather than launch on the wrong home.
  if (profile.home && args.isRemote) {
    throw new Error(AGENT_SESSION_LAUNCH_PROFILE_REMOTE_UNSUPPORTED)
  }
  return profile
}
