import { afterEach, describe, expect, it, vi } from 'vitest'

import { DOC_PREVIEW_LOAD_FAILURE_CHANNEL } from '../../shared/doc-preview-scheme'
import {
  docPreviewFailureReason,
  publishDocPreviewFailure,
  setDocPreviewFailureSink
} from './doc-preview-failure-notice'

afterEach(() => {
  setDocPreviewFailureSink(null)
})

describe('docPreviewFailureReason', () => {
  it('separates the too-large and unsupported-asset statuses from everything else', () => {
    expect(docPreviewFailureReason(413)).toBe('too-large')
    expect(docPreviewFailureReason(415)).toBe('unsupported-binary')
    expect(docPreviewFailureReason(404)).toBe('unreadable')
    expect(docPreviewFailureReason(500)).toBe('unreadable')
  })
})

describe('publishDocPreviewFailure', () => {
  it('sends the grant, path, and reason on the failure channel', () => {
    const send = vi.fn()
    setDocPreviewFailureSink({ send })

    publishDocPreviewFailure('a'.repeat(32), 'index.html', 413)

    expect(send).toHaveBeenCalledWith(DOC_PREVIEW_LOAD_FAILURE_CHANNEL, {
      grantId: 'a'.repeat(32),
      relativePath: 'index.html',
      reason: 'too-large'
    })
  })

  // Why: reads can outlive the window that asked for them; a missing sink must not throw inside
  // the protocol handler.
  it('is a no-op with no sink registered', () => {
    expect(() => publishDocPreviewFailure('b'.repeat(32), 'index.html', 404)).not.toThrow()
  })
})
