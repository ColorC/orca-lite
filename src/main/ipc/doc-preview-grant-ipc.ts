import { ipcMain } from 'electron'
import {
  buildDocPreviewUrl,
  DOC_PREVIEW_MINT_GRANT_CHANNEL,
  DOC_PREVIEW_REVOKE_GRANT_CHANNEL
} from '../../shared/doc-preview-scheme'
import {
  mintDocPreviewGrant,
  revokeDocPreviewGrant,
  type DocPreviewOwner
} from '../browser/doc-preview-grant-registry'

export type DocPreviewGrantRequest = {
  owner: DocPreviewOwner
  /** Containing directory of the opened document, on the owning host. */
  root: string
  /** Opened document, relative to `root`. */
  entryRelativePath: string
}

export type DocPreviewGrantResult = { grantId: string; url: string }

function isValidGrantRequest(request: DocPreviewGrantRequest): boolean {
  if (!request.root.trim() || !request.entryRelativePath.trim()) {
    return false
  }
  if (request.owner.kind === 'ssh') {
    return Boolean(request.owner.connectionId.trim())
  }
  return Boolean(
    request.owner.environmentId.trim() &&
    request.owner.worktreeSelector.trim() &&
    request.owner.worktreeRoot.trim()
  )
}

/**
 * Minting never widens what the renderer can already read: an SSH grant reads
 * through the same provider as `fs:readFile`, and a runtime grant through the
 * same worktree-scoped `files.read` RPC the renderer can call directly.
 */
export function registerDocPreviewGrantHandlers(): void {
  ipcMain.handle(
    DOC_PREVIEW_MINT_GRANT_CHANNEL,
    (_event, request: DocPreviewGrantRequest): DocPreviewGrantResult => {
      if (!isValidGrantRequest(request)) {
        throw new Error('Invalid document preview grant request')
      }
      const grant = mintDocPreviewGrant({
        owner: request.owner,
        root: request.root,
        entryRelativePath: request.entryRelativePath
      })
      return {
        grantId: grant.id,
        url: buildDocPreviewUrl(grant.id, grant.entryRelativePath)
      }
    }
  )

  ipcMain.handle(DOC_PREVIEW_REVOKE_GRANT_CHANNEL, (_event, grantId: string): boolean =>
    revokeDocPreviewGrant(grantId)
  )
}
