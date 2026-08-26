import {
  DOC_PREVIEW_LOAD_FAILURE_CHANNEL,
  type DocPreviewFailure,
  type DocPreviewFailureReason
} from '../../shared/doc-preview-scheme'

type DocPreviewFailureSink = { send: (channel: string, payload: DocPreviewFailure) => void }

let failureSink: DocPreviewFailureSink | null = null

export function setDocPreviewFailureSink(sink: DocPreviewFailureSink | null): void {
  failureSink = sink
}

export function docPreviewFailureReason(status: number): DocPreviewFailureReason {
  if (status === 413) {
    return 'too-large'
  }
  if (status === 415) {
    return 'unsupported-binary'
  }
  return 'unreadable'
}

/**
 * The preview shell cannot read the guest's HTTP status, and a 4xx body renders as
 * if it were the document. Pushing the reason lets the shell replace that with a
 * localized notice for the failure the user actually hit.
 */
export function publishDocPreviewFailure(
  grantId: string,
  relativePath: string,
  status: number
): void {
  failureSink?.send(DOC_PREVIEW_LOAD_FAILURE_CHANNEL, {
    grantId,
    relativePath,
    reason: docPreviewFailureReason(status)
  })
}
