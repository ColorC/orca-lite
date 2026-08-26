import { randomBytes } from 'node:crypto'
import { posix, win32 } from 'node:path'
import { isWindowsAbsolutePathLike } from '../../shared/cross-platform-path'

/**
 * A preview grant is the only authority that turns an `orca-preview://` request
 * into bytes: it names the host that owns the file and the single directory
 * subtree requests may resolve inside. No grant, no bytes.
 */
export type DocPreviewOwner =
  | { kind: 'ssh'; connectionId: string }
  | {
      kind: 'runtime'
      environmentId: string
      /** Selector the runtime resolves `files.read` against. */
      worktreeSelector: string
      /** Worktree root on the runtime host; `files.read` only accepts paths inside it. */
      worktreeRoot: string
    }

export type DocPreviewGrant = {
  id: string
  owner: DocPreviewOwner
  /** Containing directory of the opened document, on the owning host. */
  root: string
  /** Path of the opened document relative to `root`. */
  entryRelativePath: string
}

const grantsById = new Map<string, DocPreviewGrant>()

function pathFlavorFor(root: string): typeof posix | typeof win32 {
  return isWindowsAbsolutePathLike(root) ? win32 : posix
}

function normalizeRootPath(root: string): string {
  const flavor = pathFlavorFor(root)
  const normalized =
    flavor === win32 ? flavor.normalize(root.replace(/\//g, '\\')) : flavor.normalize(root)
  // Why: a trailing separator would make the containment prefix check accept a sibling directory.
  return normalized.length > 1 && normalized.endsWith(flavor.sep)
    ? normalized.slice(0, -1)
    : normalized
}

export function mintDocPreviewGrant(params: {
  owner: DocPreviewOwner
  root: string
  entryRelativePath: string
}): DocPreviewGrant {
  const grant: DocPreviewGrant = {
    id: randomBytes(16).toString('hex'),
    owner: params.owner,
    root: normalizeRootPath(params.root),
    entryRelativePath: params.entryRelativePath.replace(/\\/g, '/')
  }
  grantsById.set(grant.id, grant)
  return grant
}

export function getDocPreviewGrant(grantId: string): DocPreviewGrant | null {
  return grantsById.get(grantId) ?? null
}

export function revokeDocPreviewGrant(grantId: string): boolean {
  return grantsById.delete(grantId)
}

export function revokeAllDocPreviewGrants(): void {
  grantsById.clear()
}

function hasUnsafeSegment(segments: string[]): boolean {
  return segments.some(
    (segment) =>
      segment.length === 0 ||
      segment === '.' ||
      segment === '..' ||
      segment.includes('\0') ||
      segment.includes('\\')
  )
}

/**
 * Resolves a request path to an absolute path on the owning host, or null when
 * it would escape the grant's root. Path flavor follows the root (the owning
 * host may be Windows while this client is not), never `process.platform`.
 */
export function resolveDocPreviewTargetPath(
  grant: DocPreviewGrant,
  relativePath: string
): string | null {
  const segments = relativePath.split('/').filter((segment, index, all) => {
    // Why: keep empty segments visible to the safety check except a single trailing one from `dir/`.
    return !(segment === '' && index === all.length - 1)
  })
  if (segments.length === 0 || hasUnsafeSegment(segments)) {
    return null
  }
  const flavor = pathFlavorFor(grant.root)
  const resolved = flavor.normalize(flavor.join(grant.root, ...segments))
  const rootPrefix = grant.root.endsWith(flavor.sep) ? grant.root : `${grant.root}${flavor.sep}`
  if (!resolved.startsWith(rootPrefix)) {
    return null
  }
  return resolved
}

/**
 * Path a runtime `files.read` can address, i.e. relative to the worktree root.
 * Returns null when the grant root sits outside the worktree — the runtime file
 * RPCs are worktree-scoped, so those documents are unreadable client-side.
 */
export function toRuntimeWorktreeRelativePath(
  worktreeRoot: string,
  absolutePath: string
): string | null {
  const flavor = pathFlavorFor(worktreeRoot)
  const normalizedRoot = normalizeRootPath(worktreeRoot)
  const relative = flavor.relative(normalizedRoot, absolutePath)
  if (!relative || relative === '..' || relative.startsWith(`..${flavor.sep}`)) {
    return null
  }
  if (flavor === win32 && /^[a-zA-Z]:/.test(relative)) {
    return null
  }
  return relative.replace(/\\/g, '/')
}
