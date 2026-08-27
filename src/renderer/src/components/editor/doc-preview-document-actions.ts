import { getConnectionIdForFileFromState } from '@/lib/connection-owner-resolution'
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
  const fileContext = buildWorkspaceFileContextForFile(
    document.worktreeId,
    worktreeRoot ?? '',
    document.filePath,
    document.runtimeEnvironmentId
  )
  // Why the extra conditions rather than the shared predicate alone: it reads an unresolved owner
  // and an unknown workspace root as "local", and both are states a preview really reaches. Only a
  // document proven to live on this machine goes to the OS; everything else downloads first.
  const ownedByThisMachine = connectionId === null && worktreeRoot !== null
  if (ownedByThisMachine && canClientOsOpenWorkspaceFile(fileContext, document.filePath)) {
    void window.api.shell.openFilePath(document.filePath)
    return
  }
  void downloadAndOpenRemoteTerminalFile(fileContext, document.filePath)
}
