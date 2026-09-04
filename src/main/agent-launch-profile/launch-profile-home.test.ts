import { homedir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CLAUDE_SECONDARY_HOME_PROFILE_ID,
  CODEX_SECONDARY_HOME_PROFILE_ID
} from '../../shared/agent-launch-profile/agent-launch-profile'

const wslMocks = vi.hoisted(() => ({
  getDefaultWslDistro: vi.fn<() => string | null>(() => null),
  getWslHome: vi.fn<(distro: string) => string | null>(() => null)
}))

vi.mock('../wsl', () => ({
  getDefaultWslDistro: wslMocks.getDefaultWslDistro,
  getWslHome: wslMocks.getWslHome
}))

import {
  applyLaunchProfileHomeMarkers,
  launchProfileHostHomeOrNull,
  SECONDARY_HOME_PROFILES
} from './launch-profile-home'

describe('launch profile home markers', () => {
  beforeEach(() => {
    wslMocks.getDefaultWslDistro.mockReset().mockReturnValue(null)
    wslMocks.getWslHome.mockReset().mockReturnValue(null)
  })

  it('covers exactly the built-in secondary-home profiles', () => {
    expect(SECONDARY_HOME_PROFILES.map((profile) => profile.id)).toEqual([
      CODEX_SECONDARY_HOME_PROFILE_ID,
      CLAUDE_SECONDARY_HOME_PROFILE_ID
    ])
  })

  it('leaves an env without markers untouched', () => {
    const env = { CODEX_HOME: '/managed/home', ORCA_CODEX_HOME: '/managed/home' }
    applyLaunchProfileHomeMarkers({ env, hostEnv: {} })
    expect(env).toEqual({ CODEX_HOME: '/managed/home', ORCA_CODEX_HOME: '/managed/home' })
  })

  it('replaces a pre-set managed Codex home with the secondary home and mirrors it', () => {
    const env = {
      CODEX_HOME: '/managed/default-codex-home',
      ORCA_CODEX_HOME: '/managed/default-codex-home',
      ORCA_CODEX_HOME_PROFILE: CODEX_SECONDARY_HOME_PROFILE_ID
    }
    applyLaunchProfileHomeMarkers({ env, hostEnv: {}, hostHome: '/home/dev' })
    expect(env).toEqual({
      CODEX_HOME: join('/home/dev', '.codex-2'),
      ORCA_CODEX_HOME: join('/home/dev', '.codex-2')
    })
  })

  it('resolves the Claude secondary home without a mirror', () => {
    const env = { ORCA_CLAUDE_CONFIG_DIR_PROFILE: CLAUDE_SECONDARY_HOME_PROFILE_ID }
    applyLaunchProfileHomeMarkers({ env, hostEnv: {} })
    expect(env).toEqual({ CLAUDE_CONFIG_DIR: join(homedir(), '.claude-2') })
  })

  it('honors an absolute host override and rejects a relative one', () => {
    const env: Record<string, string> = {
      ORCA_CODEX_HOME_PROFILE: CODEX_SECONDARY_HOME_PROFILE_ID
    }
    applyLaunchProfileHomeMarkers({
      env,
      hostEnv: { ORCA_CODEX_SECONDARY_HOME: join(homedir(), 'codex-work') }
    })
    expect(env.CODEX_HOME).toBe(join(homedir(), 'codex-work'))
    expect(() =>
      applyLaunchProfileHomeMarkers({
        env: { ORCA_CODEX_HOME_PROFILE: CODEX_SECONDARY_HOME_PROFILE_ID },
        hostEnv: { ORCA_CODEX_SECONDARY_HOME: 'relative/dir' }
      })
    ).toThrow(/absolute path/)
  })

  it('ignores a marker whose value is not the profile id', () => {
    const env = { ORCA_CODEX_HOME_PROFILE: 'someone-else' }
    applyLaunchProfileHomeMarkers({ env, hostEnv: {} })
    expect(env).toEqual({ ORCA_CODEX_HOME_PROFILE: 'someone-else' })
  })

  it('resolves inside the WSL distro home for a WSL launch', () => {
    wslMocks.getWslHome.mockImplementation((distro) =>
      distro === 'Ubuntu' ? '\\\\wsl.localhost\\Ubuntu\\home\\dev' : null
    )
    const env: Record<string, string> = {
      ORCA_CODEX_HOME_PROFILE: CODEX_SECONDARY_HOME_PROFILE_ID
    }
    applyLaunchProfileHomeMarkers({ env, isWslLaunch: true, wslDistro: 'Ubuntu' })
    expect(env.CODEX_HOME).toBe(join('\\\\wsl.localhost\\Ubuntu\\home\\dev', '.codex-2'))
    expect(env.ORCA_CODEX_HOME).toBe(env.CODEX_HOME)
    expect(() =>
      applyLaunchProfileHomeMarkers({
        env: { ORCA_CODEX_HOME_PROFILE: CODEX_SECONDARY_HOME_PROFILE_ID },
        isWslLaunch: true,
        wslDistro: 'Missing'
      })
    ).toThrow(/WSL home/)
  })

  it('offers a non-throwing lookup for scanners', () => {
    expect(launchProfileHostHomeOrNull(CLAUDE_SECONDARY_HOME_PROFILE_ID, { hostHome: '/h' })).toBe(
      join('/h', '.claude-2')
    )
    expect(
      launchProfileHostHomeOrNull(CODEX_SECONDARY_HOME_PROFILE_ID, {
        hostEnv: { ORCA_CODEX_SECONDARY_HOME: 'relative' }
      })
    ).toBeNull()
    expect(launchProfileHostHomeOrNull('codex-work')).toBeNull()
  })
})
