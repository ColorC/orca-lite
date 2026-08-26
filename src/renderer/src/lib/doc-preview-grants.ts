import type { DocPreviewGrantRequest } from '../../../preload/api/doc-preview-api'
import { basename, dirname } from '@/lib/path'
import { getConnectionIdForFileFromState } from '@/lib/connection-owner-resolution'
import { getRuntimeEnvironmentIdForWorktree } from '@/lib/worktree-runtime-owner'
import { toRuntimeWorktreeSelector } from '@/runtime/runtime-worktree-selector'
import type { AppState } from '@/store/types'

export type DocPreviewGrantHandle = { grantId: string; url: string }

/**
 * Grants are keyed by preview tab id, never by effect mount: React StrictMode
 * double-invokes mount effects in dev, and a mount-scoped grant would be revoked
 * out from under the surviving webview. Release is driven by tab close instead.
 */
const grantsByPreviewId = new Map<string, Promise<DocPreviewGrantHandle>>()

export function buildDocPreviewGrantRequest(
  state: AppState,
  worktreeId: string,
  filePath: string
): DocPreviewGrantRequest | null {
  const root = dirname(filePath)
  const entryRelativePath = basename(filePath)
  if (!root || !entryRelativePath) {
    return null
  }
  const connectionId = getConnectionIdForFileFromState(state, worktreeId, filePath)
  if (connectionId) {
    return { owner: { kind: 'ssh', connectionId }, root, entryRelativePath }
  }
  const environmentId = getRuntimeEnvironmentIdForWorktree(state, worktreeId)
  const worktreeRoot = state.getKnownWorktreeById(worktreeId)?.path
  if (!environmentId || !worktreeRoot) {
    return null
  }
  return {
    owner: {
      kind: 'runtime',
      environmentId,
      worktreeSelector: toRuntimeWorktreeSelector(worktreeId),
      worktreeRoot
    },
    root,
    entryRelativePath
  }
}

export function ensureDocPreviewGrant(
  previewId: string,
  request: DocPreviewGrantRequest
): Promise<DocPreviewGrantHandle> {
  const existing = grantsByPreviewId.get(previewId)
  if (existing) {
    return existing
  }
  const pending = window.api.docPreview.mintGrant(request).catch((error: unknown) => {
    grantsByPreviewId.delete(previewId)
    throw error
  })
  grantsByPreviewId.set(previewId, pending)
  return pending
}

export function releaseDocPreviewGrant(previewId: string): void {
  const pending = grantsByPreviewId.get(previewId)
  if (!pending) {
    return
  }
  grantsByPreviewId.delete(previewId)
  void pending.then((handle) => window.api.docPreview.revokeGrant(handle.grantId)).catch(() => {})
}
