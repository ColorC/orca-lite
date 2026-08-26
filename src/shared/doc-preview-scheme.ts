/**
 * Wire shape for the local document-preview scheme. The main process answers
 * `orca-preview://<grantId>/<relative-path>` by reading the owning workspace's
 * disk over the same channels the editor uses, so remote HTML docs render in a
 * local webview instead of being routed through the remote-browsing machinery.
 */
export const DOC_PREVIEW_SCHEME = 'orca-preview'

/** Why: non-persistent and its own partition — preview bytes never share storage with user browsing or workspace browser profiles. */
export const DOC_PREVIEW_PARTITION = 'orca-doc-preview'

export const DOC_PREVIEW_MINT_GRANT_CHANNEL = 'docPreview:mintGrant'
export const DOC_PREVIEW_REVOKE_GRANT_CHANNEL = 'docPreview:revokeGrant'
export const DOC_PREVIEW_EXTERNAL_LINK_CHANNEL = 'docPreview:externalLink'
export const DOC_PREVIEW_LOAD_FAILURE_CHANNEL = 'docPreview:loadFailure'

/** Why: an unreadable document still answers with a real HTTP status, so the guest paints the
 *  handler's plain-text body instead of failing to load. The shell needs the reason out-of-band. */
export type DocPreviewFailureReason = 'too-large' | 'unsupported-asset' | 'unreadable'

export type DocPreviewFailure = {
  grantId: string
  relativePath: string
  reason: DocPreviewFailureReason
}

export const DOC_PREVIEW_GRANT_ID_PATTERN = /^[0-9a-f]{32}$/

export function isDocPreviewGrantId(value: string): boolean {
  return DOC_PREVIEW_GRANT_ID_PATTERN.test(value)
}

/** Encodes each segment separately so `/` keeps its separator meaning and `#`/`?` cannot split the path. */
export function buildDocPreviewUrl(grantId: string, relativePath: string): string {
  const segments = relativePath
    .replace(/\\/g, '/')
    .split('/')
    .filter((segment) => segment.length > 0)
    .map((segment) => encodeURIComponent(segment))
  return `${DOC_PREVIEW_SCHEME}://${grantId}/${segments.join('/')}`
}

export type DocPreviewUrlTarget = {
  grantId: string
  /** Slash-joined, percent-decoded path segments; never leading-slashed. */
  relativePath: string
}

export function parseDocPreviewUrl(rawUrl: string): DocPreviewUrlTarget | null {
  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  } catch {
    return null
  }
  if (parsed.protocol !== `${DOC_PREVIEW_SCHEME}:`) {
    return null
  }
  const grantId = parsed.hostname
  if (!isDocPreviewGrantId(grantId)) {
    return null
  }
  const segments: string[] = []
  for (const rawSegment of parsed.pathname.split('/')) {
    if (rawSegment.length === 0) {
      continue
    }
    let segment: string
    try {
      segment = decodeURIComponent(rawSegment)
    } catch {
      return null
    }
    segments.push(segment)
  }
  return { grantId, relativePath: segments.join('/') }
}
