import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import {
  BUILT_IN_AGENT_LAUNCH_PROFILES,
  agentLaunchProfileHomeMarkerEnv,
  type AgentLaunchProfile,
  type AgentLaunchProfileHome
} from '../../shared/agent-launch-profile/agent-launch-profile'
import { getDefaultWslDistro, getWslHome, parseWslPath } from '../wsl'
import { addWslEnvKeys } from '../wsl-env'

// Why: shell-ready wrappers restore CODEX_HOME from ORCA_CODEX_HOME after profile scripts, so a
// relocated Codex home must set both. Claude Code reads CLAUDE_CONFIG_DIR directly.
const MIRROR_ENV_VARS: Readonly<Record<string, readonly string[]>> = {
  CODEX_HOME: ['ORCA_CODEX_HOME']
}

/** Only built-in profiles relocate a home; custom profiles carry args/env and no marker. */
export const SECONDARY_HOME_PROFILES: readonly (AgentLaunchProfile & {
  home: AgentLaunchProfileHome
})[] = BUILT_IN_AGENT_LAUNCH_PROFILES.filter(
  (profile): profile is AgentLaunchProfile & { home: AgentLaunchProfileHome } =>
    profile.home !== undefined
)

export type LaunchProfileHomeHostContext = {
  hostEnv?: NodeJS.ProcessEnv
  hostHome?: string
}

/** Absolute home for a secondary-home profile on the machine that runs the PTY. */
export function resolveLaunchProfileHostHome(
  home: AgentLaunchProfileHome,
  context: LaunchProfileHomeHostContext = {}
): string {
  const configured = (context.hostEnv ?? process.env)[home.overrideEnv]?.trim()
  if (configured) {
    if (!isAbsolute(configured)) {
      throw new Error(`${home.overrideEnv} must be an absolute path on the execution host.`)
    }
    return configured
  }
  return join(context.hostHome ?? homedir(), home.dirName)
}

function resolveLaunchProfileWslHome(
  profile: AgentLaunchProfile & { home: AgentLaunchProfileHome },
  distro: string | null | undefined
): string {
  const target = distro?.trim() || getDefaultWslDistro()
  const wslHome = target ? getWslHome(target) : null
  if (!wslHome) {
    throw new Error(`${profile.label} could not resolve the selected WSL home directory.`)
  }
  return join(wslHome, profile.home.dirName)
}

/**
 * Turns every secondary-home marker a launch carries into a real home directory.
 *
 * The launch only ships a marker; only the execution host knows the real path. A WSL launch
 * gets the distro home as a UNC path, which the caller's existing WSL translation rewrites to
 * a Linux path and exports through WSLENV.
 */
export function applyLaunchProfileHomeMarkers(args: {
  env: Record<string, string>
  isWslLaunch?: boolean
  wslDistro?: string | null
  hostEnv?: NodeJS.ProcessEnv
  hostHome?: string
}): void {
  for (const profile of SECONDARY_HOME_PROFILES) {
    const markerEnv = agentLaunchProfileHomeMarkerEnv(profile.home.envVar)
    if (args.env[markerEnv] !== profile.id) {
      continue
    }
    // Why: main may already have injected the selected managed home; the explicit profile wins.
    delete args.env[markerEnv]
    const profileHome = args.isWslLaunch
      ? resolveLaunchProfileWslHome(profile, args.wslDistro)
      : resolveLaunchProfileHostHome(profile.home, args)
    args.env[profile.home.envVar] = profileHome
    for (const mirror of MIRROR_ENV_VARS[profile.home.envVar] ?? []) {
      args.env[mirror] = profileHome
    }
  }
}

/**
 * Rewrites a resolved WSL home (a `\\wsl.localhost\...` UNC path) to the Linux path the distro
 * shell needs and exports it through WSLENV. The daemon lane does this inside its own WSL
 * translation; the in-process lane resolves markers after that translation ran, so it calls this.
 */
export function exportLaunchProfileHomesForWsl(env: Record<string, string>): void {
  for (const profile of SECONDARY_HOME_PROFILES) {
    const value = env[profile.home.envVar]
    const wslInfo = value ? parseWslPath(value) : null
    if (!wslInfo) {
      continue
    }
    env[profile.home.envVar] = wslInfo.linuxPath
    for (const mirror of MIRROR_ENV_VARS[profile.home.envVar] ?? []) {
      env[mirror] = wslInfo.linuxPath
    }
    addWslEnvKeys(env, [profile.home.envVar, ...(MIRROR_ENV_VARS[profile.home.envVar] ?? [])])
  }
}

/** Same resolution for read-only scanners, which must not fail a scan over one bad override. */
export function launchProfileHostHomeOrNull(
  profileId: string,
  context: LaunchProfileHomeHostContext = {}
): string | null {
  const profile = SECONDARY_HOME_PROFILES.find((candidate) => candidate.id === profileId)
  if (!profile) {
    return null
  }
  try {
    return resolveLaunchProfileHostHome(profile.home, context)
  } catch {
    return null
  }
}
