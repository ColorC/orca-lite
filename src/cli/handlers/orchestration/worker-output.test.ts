import { describe, expect, it } from 'vitest'
import type { OrchestrationWorkerReadResult } from '../../../shared/orchestration-worker-output'
import { formatWorkerRead } from './worker-output'

describe('worker-read plain formatting', () => {
  it('renders transcript provenance, incomplete coverage, warnings, and opaque cursor guidance', () => {
    expect(
      formatWorkerRead(
        workerReadResult({
          source: 'transcript',
          sourceIdentity: 'private-source-identity',
          provider: 'codex',
          transcript: {
            messages: [
              {
                id: 'message_1',
                role: 'assistant',
                blocks: [{ type: 'text', text: 'latest output' }],
                timestamp: null,
                source: 'transcript'
              }
            ],
            nextCursor: 'owr1_transcript',
            limited: true,
            returnedMessageCount: 1
          },
          cursor: 'owr1_transcript',
          fallbackReason: null,
          sourceExact: true,
          contentComplete: false,
          clipping: ['message_limit_or_scan_window'],
          warnings: ['Older transcript records are not pageable through this cursor.']
        })
      )
    ).toBe(
      'Source: transcript (provider=codex)\n' +
        'Source exact: true\n' +
        'Content complete: false\n' +
        'Clipping: message_limit_or_scan_window\n' +
        'Continuation cursor (opaque; pass unchanged to --cursor): owr1_transcript\n' +
        'Warning: Older transcript records are not pageable through this cursor.\n\n' +
        '[assistant] latest output'
    )
  })

  it('labels terminal fallback evidence and every warning', () => {
    expect(
      formatWorkerRead(
        workerReadResult({
          source: 'terminal',
          sourceIdentity: 'private-source-identity',
          terminal: {
            handle: 'term_worker',
            status: 'running',
            tail: ['bounded terminal evidence'],
            truncated: true,
            nextCursor: '20'
          },
          cursor: 'owr1_terminal',
          fallbackReason: 'session_not_reported',
          sourceExact: false,
          contentComplete: false,
          clipping: ['terminal_buffer', 'terminal_fallback'],
          warnings: ['A secret was redacted.', 'One line was malformed.']
        })
      )
    ).toBe(
      'Source: terminal\n' +
        'Source exact: false\n' +
        'Fallback reason: session_not_reported\n' +
        'Content complete: false\n' +
        'Clipping: terminal_buffer, terminal_fallback\n' +
        'Continuation cursor (opaque; pass unchanged to --cursor): owr1_terminal\n' +
        'Warning: A secret was redacted.\n' +
        'Warning: One line was malformed.\n\n' +
        'bounded terminal evidence'
    )
  })

  it('truthfully labels an exact empty transcript without reading terminal evidence', () => {
    expect(
      formatWorkerRead(
        workerReadResult({
          source: 'transcript',
          sourceIdentity: 'private-source-identity',
          provider: 'codex',
          transcript: {
            messages: [],
            nextCursor: 'owr1_empty',
            limited: false,
            returnedMessageCount: 0
          },
          cursor: 'owr1_empty',
          fallbackReason: null,
          sourceExact: true,
          contentComplete: true,
          warnings: []
        })
      )
    ).toBe(
      'Source: transcript (provider=codex)\n' +
        'Source exact: true\n' +
        'Content complete: true\n' +
        'Continuation cursor (opaque; pass unchanged to --cursor): owr1_empty\n\n' +
        'No transcript messages returned. This exact transcript read did not request terminal evidence.'
    )
  })
})

function workerReadResult(
  value: WorkerReadResultWithoutContext<OrchestrationWorkerReadResult>
): OrchestrationWorkerReadResult {
  return {
    dispatchId: 'dispatch_1',
    status: { worker: 'ready', terminal: 'running' },
    ...value
  } as OrchestrationWorkerReadResult
}

type WorkerReadResultWithoutContext<T> = T extends unknown
  ? Omit<T, 'dispatchId' | 'status'>
  : never
