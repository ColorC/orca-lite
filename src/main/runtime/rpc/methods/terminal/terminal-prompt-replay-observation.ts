import type { OrcaRuntimeService } from '../../../orca-runtime'
import type { RuntimeTerminalSend } from '../../../../../shared/runtime-terminal-contracts'

const TERMINAL_PROMPT_REPLAY_REPLACEMENT_ERRORS = new Set([
  'terminal_handle_stale',
  'terminal_not_writable',
  'terminal_gone',
  'terminal_exited'
])

export async function observeReplayedTerminalPrompt(
  runtime: OrcaRuntimeService,
  handle: string,
  replayedSend: RuntimeTerminalSend | undefined,
  waitSubmitMs: number | undefined,
  signal: AbortSignal | undefined
): Promise<{ send: RuntimeTerminalSend } | null> {
  if (!replayedSend?.prompt || !waitSubmitMs || waitSubmitMs <= 0) {
    return null
  }
  try {
    const prompt = await runtime.observeTerminalAgentPrompt(
      handle,
      replayedSend.prompt,
      waitSubmitMs,
      signal
    )
    return { send: { ...replayedSend, prompt } }
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !TERMINAL_PROMPT_REPLAY_REPLACEMENT_ERRORS.has(error.message)
    ) {
      throw error
    }
    return {
      send: {
        ...replayedSend,
        prompt: { ...replayedSend.prompt, observation: 'incarnation_replaced' }
      }
    }
  }
}
