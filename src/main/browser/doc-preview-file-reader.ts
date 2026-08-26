import { extname } from 'node:path'
import type {
  RuntimeFilePreviewResult,
  RuntimeFileReadResult
} from '../../shared/runtime-file-contracts'
import { callRuntimeEnvironment } from '../ipc/runtime-environment-transport-routing'
import { FileReadCapExceededError } from '../ssh/ssh-filesystem-stream-reader'
import { getCanonicalUserDataPath } from '../persistence'
import { requireSshFilesystemProvider } from '../providers/ssh-filesystem-dispatch'
import {
  resolveDocPreviewTargetPath,
  toRuntimeWorktreeRelativePath,
  type DocPreviewGrant
} from './doc-preview-grant-registry'

const DOC_PREVIEW_READ_TIMEOUT_MS = 15_000

/** An empty binary body means the host would not serve those bytes — an old server answering a
 *  format it has no preview for, most often. */
const UNSUPPORTED_BINARY_PREVIEW_MESSAGE =
  'This asset needs a newer Orca server to render in a preview.'

/** `files.read` clamps text at the host's cap and reports it; serving the clamped bytes would
 *  render a silently half-finished document. */
const TRUNCATED_PREVIEW_MESSAGE = 'This document is too large for the server to send in full.'

/** The paired host rejects an over-cap asset outright instead of clamping it. */
const RUNTIME_TOO_LARGE_ERROR = 'file_too_large'

/** Both owners refuse an over-cap file; only their error shapes differ. */
function isTooLargeReadError(error: unknown): boolean {
  return (
    error instanceof FileReadCapExceededError ||
    (error instanceof Error && error.message === RUNTIME_TOO_LARGE_ERROR)
  )
}

export type DocPreviewReadOutcome =
  | { ok: true; bytes: Buffer; contentType: string }
  | { ok: false; status: number; message: string }

const DOC_PREVIEW_CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.csv': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.pdf': 'application/pdf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf'
}

export function docPreviewContentType(relativePath: string): string {
  return (
    DOC_PREVIEW_CONTENT_TYPES[extname(relativePath).toLowerCase()] ?? 'application/octet-stream'
  )
}

type PreviewFileBytes = { content: string; isBinary: boolean; truncated?: boolean }

function toBytes(result: PreviewFileBytes): Buffer | null {
  if (!result.isBinary) {
    return Buffer.from(result.content, 'utf8')
  }
  // Why: a binary result with no content is the "cannot serve this" signal on every owner kind.
  return result.content ? Buffer.from(result.content, 'base64') : null
}

function toOutcome(source: PreviewFileBytes, contentType: string): DocPreviewReadOutcome {
  if (source.truncated) {
    return { ok: false, status: 413, message: TRUNCATED_PREVIEW_MESSAGE }
  }
  const bytes = toBytes(source)
  return bytes
    ? { ok: true, bytes, contentType }
    : { ok: false, status: 415, message: UNSUPPORTED_BINARY_PREVIEW_MESSAGE }
}

async function readRuntimeDocPreviewFile(
  environmentId: string,
  worktreeSelector: string,
  relativePath: string
): Promise<PreviewFileBytes> {
  const userDataPath = getCanonicalUserDataPath()
  const response = await callRuntimeEnvironment(
    userDataPath,
    environmentId,
    'files.read',
    { worktree: worktreeSelector, relativePath },
    DOC_PREVIEW_READ_TIMEOUT_MS
  )
  if (response.ok) {
    const result = response.result as RuntimeFileReadResult
    return { content: result.content, isBinary: false, truncated: result.truncated === true }
  }
  // Why: files.read rejects binaries with a typed error; the base64 preview RPC serves
  // images and fonts the same way it does for markdown previews. Match the exact
  // message so an unrelated failure can't spoof the fallback.
  if (response.error.message !== 'binary_file') {
    throw new Error(response.error.message)
  }
  const previewResponse = await callRuntimeEnvironment(
    userDataPath,
    environmentId,
    'files.readPreview',
    { worktree: worktreeSelector, relativePath },
    DOC_PREVIEW_READ_TIMEOUT_MS
  )
  if (!previewResponse.ok) {
    throw new Error(previewResponse.error.message)
  }
  const preview = previewResponse.result as RuntimeFilePreviewResult
  // Why: readPreview never clamps — it rejects an over-cap asset — so an empty binary body here
  // is the host declining the format, which toOutcome reports as unsupported.
  return { content: preview.content, isBinary: preview.isBinary }
}

/** Reads one in-grant path over the same channel the editor uses for that owner. */
export async function readDocPreviewFile(
  grant: DocPreviewGrant,
  relativePath: string
): Promise<DocPreviewReadOutcome> {
  const absolutePath = resolveDocPreviewTargetPath(grant, relativePath)
  if (!absolutePath) {
    return { ok: false, status: 404, message: 'Not found' }
  }
  const contentType = docPreviewContentType(relativePath)
  try {
    if (grant.owner.kind === 'ssh') {
      const provider = requireSshFilesystemProvider(grant.owner.connectionId)
      // Why: the SSH reader rejects an over-cap file outright, so its result is never partial.
      return toOutcome(await provider.readFile(absolutePath), contentType)
    }
    const worktreeRelativePath = toRuntimeWorktreeRelativePath(
      grant.owner.worktreeRoot,
      absolutePath
    )
    if (!worktreeRelativePath) {
      // Why: files.read is worktree-scoped, so a doc outside the worktree has no client-side channel.
      return { ok: false, status: 404, message: 'Not found' }
    }
    return toOutcome(
      await readRuntimeDocPreviewFile(
        grant.owner.environmentId,
        grant.owner.worktreeSelector,
        worktreeRelativePath
      ),
      contentType
    )
  } catch (error) {
    return isTooLargeReadError(error)
      ? { ok: false, status: 413, message: TRUNCATED_PREVIEW_MESSAGE }
      : {
          ok: false,
          status: 404,
          message: error instanceof Error ? error.message : 'Not found'
        }
  }
}
