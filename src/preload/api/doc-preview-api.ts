export type DocPreviewGrantOwner =
  | { kind: 'ssh'; connectionId: string }
  | {
      kind: 'runtime'
      environmentId: string
      worktreeSelector: string
      worktreeRoot: string
    }

export type DocPreviewGrantRequest = {
  owner: DocPreviewGrantOwner
  root: string
  entryRelativePath: string
}

export type DocPreviewApi = {
  docPreview: {
    mintGrant: (request: DocPreviewGrantRequest) => Promise<{ grantId: string; url: string }>
    revokeGrant: (grantId: string) => Promise<boolean>
    /** External link the preview guest tried to open; the renderer turns it into a browser tab. */
    onExternalLink: (callback: (payload: { url: string }) => void) => () => void
  }
}
