import { getConnectionId } from '@/lib/connection-context'
import {
  isRemoteRuntimeFileOperation,
  type RuntimeFileOperationArgs
} from '@/runtime/runtime-file-client'
import { settingsForRuntimeOwner } from '@/runtime/runtime-rpc-client'
import { useAppStore } from '@/store'

/** Which host owns a workspace file, resolved the same way for every surface that opens one. */
export function buildWorkspaceFileContext(
  worktreeId: string,
  worktreePath: string,
  runtimeEnvironmentId?: string | null
): RuntimeFileOperationArgs {
  const settings = useAppStore.getState().settings
  return {
    settings: settingsForRuntimeOwner(settings, runtimeEnvironmentId),
    worktreeId: worktreeId || null,
    worktreePath,
    connectionId: getConnectionId(worktreeId || null) ?? undefined
  }
}

/**
 * Whether the client's OS can launch this path at all. False for anything an SSH connection or a
 * runtime environment owns — those have to be downloaded before the OS has a file to open.
 */
export function canClientOsOpenWorkspaceFile(
  fileContext: RuntimeFileOperationArgs,
  filePath: string
): boolean {
  return !fileContext.connectionId && !isRemoteRuntimeFileOperation(fileContext, filePath)
}
