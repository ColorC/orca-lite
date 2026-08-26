import type { EditorGet, EditorSet } from '../types/editor-set-get'
import type { EditorSlice } from '../types/editor-slice'
import type { OpenFile } from '../types/open-file'
import { buildEditorActiveResult } from '../tabs/editor-open-target-group'
import { openWorkspaceEditorItem } from '../tabs/workspace-editor-item'

/** Stable per document so reopening the same file reuses its preview tab. */
export function htmlDocPreviewFileId(worktreeId: string, filePath: string): string {
  return `html-preview::${worktreeId}::${filePath}`
}

export function createHtmlDocPreviewAction(
  set: EditorSet,
  get: EditorGet
): Pick<EditorSlice, 'openHtmlDocPreview'> {
  return {
    openHtmlDocPreview: (file, options) => {
      const id = htmlDocPreviewFileId(file.worktreeId, file.filePath)
      set((s) => {
        const activeResult = buildEditorActiveResult(s, file.worktreeId, id)
        if (s.openFiles.some((openFile) => openFile.id === id)) {
          return activeResult
        }
        const newFile: OpenFile = {
          id,
          filePath: file.filePath,
          relativePath: file.relativePath,
          worktreeId: file.worktreeId,
          language: file.language,
          isDirty: false,
          runtimeEnvironmentId: file.runtimeEnvironmentId,
          externalSshTargetId: file.externalSshTargetId,
          readOnly: true,
          mode: 'html-preview'
        }
        return { openFiles: [...s.openFiles, newFile], ...activeResult }
      })
      void openWorkspaceEditorItem(
        get(),
        id,
        file.worktreeId,
        `${file.relativePath} (preview)`,
        'editor',
        false,
        options?.targetGroupId
      )
    }
  }
}
