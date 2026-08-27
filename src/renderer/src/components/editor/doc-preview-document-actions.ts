import { getConnectionIdForFileFromState } from '@/lib/connection-owner-resolution'
import { getRuntimeEnvironmentIdForWorktree } from '@/lib/worktree-runtime-owner'
import { detectLanguage } from '@/lib/language-detect'
import {
  buildWorkspaceFileContextForFile,
  canClientOsOpenWorkspaceFile
} from '@/lib/workspace-file-host-routing'
import { useAppStore } from '@/store'
import { downloadAndOpenRemoteTerminalFile } from '@/components/terminal-pane/terminal-remote-file-download-open'

export type DocPreviewDocument = {
  filePath: string
  relativePath: string
  worktreeId: string
  runtimeEnvironmentId: string | null
  externalSshTargetId: string | null
}

/**
 * Open the previewed document as an ordinary source tab. A second tab, not a mode switch: the
 * preview keeps its own id, so the reader can leave the rendered page where it was.
 */
export function openDocPreviewSource(document: DocPreviewDocument): void {
  useAppStore.getState().openFile({
    filePath: document.filePath,
    relativePath: document.relativePath,
    worktreeId: document.worktreeId,
    // Why not the preview tab's language: it is pinned to 'html' for the preview itself, and the
    // source tab needs the editor's own detection to pick a highlighter.
    language: detectLanguage(document.filePath),
    runtimeEnvironmentId: document.runtimeEnvironmentId,
    ...(document.externalSshTargetId ? { externalSshTargetId: document.externalSshTargetId } : {}),
    mode: 'edit'
  })
}

/**
 * Hand the document to the reader's own machine. A preview is almost always remote, and the OS
 * cannot launch a path it has no copy of — so a remote document is downloaded first, exactly as
 * the terminal's "Download & open with default app" does.
 */
export function openDocPreviewExternally(document: DocPreviewDocument): void {
  const state = useAppStore.getState()
  const worktreeRoot = state.getKnownWorktreeById(document.worktreeId)?.path ?? null
  // Why the per-file resolver: this is the same document the grant authorized, and that grant was
  // minted against the file's own owner. A folder workspace spanning hosts answers `undefined`
  // workspace-wide, which downstream reads as local — the OS would then be handed a remote
  // absolute path and either do nothing or open an unrelated file of the same name.
  const connectionId = getConnectionIdForFileFromState(
    state,
    document.worktreeId,
    document.filePath
  )
  // Why re-resolve the runtime owner rather than trust the tab's field: the grant this preview
  // renders through was minted against the worktree's owner at render time, and a tab opened or
  // restored before that owner was known still carries null — which reads as local.
  const runtimeEnvironmentId =
    getRuntimeEnvironmentIdForWorktree(state, document.worktreeId) ?? document.runtimeEnvironmentId
  const fileContext = buildWorkspaceFileContextForFile(
    document.worktreeId,
    worktreeRoot ?? '',
    document.filePath,
    runtimeEnvironmentId
  )
  // Why these conditions rather than the shared predicate alone: it reads an unresolved owner, an
  // unknown workspace root, and a runtime-owned path that sits outside that root as "local", and a
  // preview really reaches all three. Only a document proven to live on this machine goes to the
  // OS; everything else downloads first, where a failure is at least visible.
  const ownedByThisMachine =
    connectionId === null && runtimeEnvironmentId === null && worktreeRoot !== null
  if (ownedByThisMachine && canClientOsOpenWorkspaceFile(fileContext, document.filePath)) {
    void window.api.shell.openFilePath(document.filePath)
    return
  }
  void downloadAndOpenRemoteTerminalFile(fileContext, document.filePath)
}
