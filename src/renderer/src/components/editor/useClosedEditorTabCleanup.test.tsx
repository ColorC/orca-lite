// @vitest-environment happy-dom
//
// Closing the preview tab is the only thing that revokes its grant, so this is the wiring that
// decides whether a closed preview stays a live read authority on the workspace.
import { renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { OpenFile } from '@/store/slices/editor'

const mocks = vi.hoisted(() => ({ releaseDocPreviewGrant: vi.fn() }))

vi.mock('@/lib/doc-preview-grants', () => ({
  releaseDocPreviewGrant: mocks.releaseDocPreviewGrant
}))
vi.mock('monaco-editor', () => ({
  editor: { getModel: () => null },
  Uri: { parse: (value: string) => value }
}))
vi.mock('./diff-monaco-model-disposal', () => ({
  disposeUnattachedMonacoModelsByPathPrefix: () => undefined,
  getDiffViewerMonacoModelPathPrefixes: () => ({
    originalModelPathPrefix: 'original',
    modifiedModelPathPrefix: 'modified'
  })
}))

import { useClosedEditorTabCleanup } from './useClosedEditorTabCleanup'

function openFile(overrides: Partial<OpenFile> & Pick<OpenFile, 'id' | 'mode'>): OpenFile {
  return {
    filePath: '/repo/docs/report.html',
    relativePath: 'docs/report.html',
    worktreeId: 'wt-1',
    language: 'html',
    isDirty: false,
    ...overrides
  } as OpenFile
}

const preview = openFile({ id: 'preview-1', mode: 'html-preview' })
const editTab = openFile({
  id: 'edit-1',
  mode: 'edit',
  filePath: '/repo/src/app.ts',
  relativePath: 'src/app.ts',
  language: 'typescript'
})

beforeEach(() => {
  vi.clearAllMocks()
})

describe('useClosedEditorTabCleanup', () => {
  it('revokes the grant of a preview tab that was closed', () => {
    const { rerender } = renderHook(
      ({ files }: { files: OpenFile[] }) => useClosedEditorTabCleanup(files),
      {
        initialProps: { files: [preview, editTab] }
      }
    )

    rerender({ files: [editTab] })

    expect(mocks.releaseDocPreviewGrant).toHaveBeenCalledWith('preview-1')
  })

  it('keeps the grant while the preview tab is still open', () => {
    const { rerender } = renderHook(
      ({ files }: { files: OpenFile[] }) => useClosedEditorTabCleanup(files),
      {
        initialProps: { files: [preview, editTab] }
      }
    )

    rerender({ files: [preview] })

    expect(mocks.releaseDocPreviewGrant).not.toHaveBeenCalled()
  })

  // Why: the grant id is the preview tab's id, so a release fired for the edit tab's close would
  // revoke a live preview's authority out from under it. Closing both must still release once.
  it('releases only the preview grant when an edit tab closes alongside it', () => {
    const { rerender } = renderHook(
      ({ files }: { files: OpenFile[] }) => useClosedEditorTabCleanup(files),
      {
        initialProps: { files: [preview, editTab] }
      }
    )

    rerender({ files: [preview] })
    rerender({ files: [] })

    expect(mocks.releaseDocPreviewGrant).toHaveBeenCalledTimes(1)
    expect(mocks.releaseDocPreviewGrant).toHaveBeenCalledWith('preview-1')
  })
})
