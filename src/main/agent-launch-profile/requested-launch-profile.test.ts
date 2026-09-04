import { describe, expect, it } from 'vitest'
import {
  AGENT_SESSION_LAUNCH_PROFILE_AGENT_MISMATCH,
  AGENT_SESSION_LAUNCH_PROFILE_REMOTE_UNSUPPORTED,
  AGENT_SESSION_LAUNCH_PROFILE_UNKNOWN,
  resolveRequestedAgentLaunchProfile
} from './requested-launch-profile'

const settings = {
  agentLaunchProfiles: [{ id: 'codex-work', agent: 'codex' as const, args: '-c a=b' }]
}

describe('resolveRequestedAgentLaunchProfile', () => {
  it('returns null for a plain launch', () => {
    expect(
      resolveRequestedAgentLaunchProfile({
        agent: 'codex',
        launchProfileId: undefined,
        settings,
        isRemote: false
      })
    ).toBeNull()
  })

  it('resolves built-in and custom profiles for the matching agent', () => {
    expect(
      resolveRequestedAgentLaunchProfile({
        agent: 'codex',
        launchProfileId: 'codex-secondary-home',
        settings,
        isRemote: false
      })?.home?.envVar
    ).toBe('CODEX_HOME')
    expect(
      resolveRequestedAgentLaunchProfile({
        agent: 'codex',
        launchProfileId: 'codex-work',
        settings,
        isRemote: false
      })?.args
    ).toBe('-c a=b')
  })

  it('names the failure so clients can tell unknown from mismatch', () => {
    expect(() =>
      resolveRequestedAgentLaunchProfile({
        agent: 'codex',
        launchProfileId: 'missing',
        settings,
        isRemote: false
      })
    ).toThrow(AGENT_SESSION_LAUNCH_PROFILE_UNKNOWN)
    expect(() =>
      resolveRequestedAgentLaunchProfile({
        agent: 'claude',
        launchProfileId: 'codex-work',
        settings,
        isRemote: false
      })
    ).toThrow(AGENT_SESSION_LAUNCH_PROFILE_AGENT_MISMATCH)
  })

  it('refuses a secondary home on a remote execution host but allows args-only profiles', () => {
    expect(() =>
      resolveRequestedAgentLaunchProfile({
        agent: 'claude',
        launchProfileId: 'claude-secondary-home',
        settings,
        isRemote: true
      })
    ).toThrow(AGENT_SESSION_LAUNCH_PROFILE_REMOTE_UNSUPPORTED)
    expect(
      resolveRequestedAgentLaunchProfile({
        agent: 'codex',
        launchProfileId: 'codex-work',
        settings,
        isRemote: true
      })?.id
    ).toBe('codex-work')
  })
})
