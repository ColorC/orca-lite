import { protocol, session } from 'electron'
import {
  DOC_PREVIEW_PARTITION,
  DOC_PREVIEW_SCHEME,
  parseDocPreviewUrl
} from '../../shared/doc-preview-scheme'
import { readDocPreviewFile } from './doc-preview-file-reader'
import { publishDocPreviewFailure } from './doc-preview-failure-notice'
import { getDocPreviewGrant } from './doc-preview-grant-registry'

/** Must run before `app.whenReady()`; Electron freezes the privileged scheme table at ready. */
export function registerDocPreviewSchemePrivileges(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: DOC_PREVIEW_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        stream: true
      }
    }
  ])
}

let docPreviewSession: Electron.Session | null = null

/** Non-persistent session, so preview bytes never land in a browsing profile's storage. */
export function getDocPreviewSession(): Electron.Session {
  docPreviewSession ??= session.fromPartition(DOC_PREVIEW_PARTITION)
  return docPreviewSession
}

/** Pure identity check: every guest attach consults it, and none should materialize a session. */
export function isDocPreviewSession(candidate: Electron.Session): boolean {
  return docPreviewSession !== null && candidate === docPreviewSession
}

function notFound(message: string): Response {
  return new Response(message, {
    status: 404,
    headers: { 'Content-Type': 'text/plain; charset=utf-8' }
  })
}

export async function handleDocPreviewRequest(request: Request): Promise<Response> {
  const target = parseDocPreviewUrl(request.url)
  if (!target) {
    return notFound('Not found')
  }
  const grant = getDocPreviewGrant(target.grantId)
  if (!grant) {
    // Why: a revoked or unknown grant is indistinguishable from a missing file by design.
    return notFound('Not found')
  }
  const relativePath = target.relativePath || grant.entryRelativePath
  const outcome = await readDocPreviewFile(grant, relativePath)
  if (!outcome.ok) {
    publishDocPreviewFailure(target.grantId, relativePath, outcome.status)
    return new Response(outcome.message, {
      status: outcome.status,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' }
    })
  }
  return new Response(new Uint8Array(outcome.bytes), {
    status: 200,
    headers: {
      'Content-Type': outcome.contentType,
      // Why: reload must re-read the workspace disk, so nothing may be cached.
      'Cache-Control': 'no-store'
    }
  })
}

export function installDocPreviewProtocolHandler(): void {
  const previewSession = getDocPreviewSession()
  if (previewSession.protocol.isProtocolHandled(DOC_PREVIEW_SCHEME)) {
    return
  }
  previewSession.protocol.handle(DOC_PREVIEW_SCHEME, handleDocPreviewRequest)
}
