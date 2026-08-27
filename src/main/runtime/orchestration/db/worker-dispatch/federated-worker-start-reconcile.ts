import type { WorkerDispatchRow } from '../../types'
import { OrchestrationError } from '../../orchestration-error'
import type { OrchestrationDb } from '../orchestration-db'
import { reconcileTaskAfterDispatchInterruption } from '../dispatch-context/task-dispatch-reconciliation'
import { transitionLifecycleWithDb } from '../lifecycle-transition'

export function reconcileFederatedWorkerStart(
  this: OrchestrationDb,
  params: {
    dispatchId: string
    state: 'ready' | 'failed' | 'stopped' | 'start_unknown'
    stage: string
    lastError?: string | null
    worktreeId?: string | null
    terminalHandle?: string | null
    setupState?: string
    effects?: unknown[]
    residualResources?: unknown[]
  }
): WorkerDispatchRow {
  this.db.exec('BEGIN IMMEDIATE')
  try {
    const dispatch = this.getDispatchContextById(params.dispatchId)
    const worker = this.getWorkerDispatch(params.dispatchId)
    if (!dispatch || !worker) {
      throw new OrchestrationError(
        'dispatch_not_found',
        `Federated Dispatch ${params.dispatchId} was not found.`
      )
    }
    if (!['starting', 'start_unknown'].includes(worker.state)) {
      this.db.exec('COMMIT')
      return worker
    }

    if (params.state === 'ready') {
      transitionLifecycleWithDb(this.db, {
        entity: 'worker',
        id: params.dispatchId,
        from: worker.state,
        to: 'ready',
        projection: {
          stage: params.stage,
          worktree_id: params.worktreeId ?? worker.worktree_id,
          agent_terminal_handle: params.terminalHandle ?? worker.agent_terminal_handle,
          setup_state: params.setupState ?? worker.setup_state,
          effects: params.effects ? JSON.stringify(params.effects) : worker.effects,
          residual_resources: params.residualResources
            ? JSON.stringify(params.residualResources)
            : worker.residual_resources,
          last_error: null,
          updated_at: new Date().toISOString()
        },
        receipt: { kind: 'federated_worker_ready' }
      })
      if (dispatch.status === 'pending') {
        transitionLifecycleWithDb(this.db, {
          entity: 'dispatch',
          id: params.dispatchId,
          from: 'pending',
          to: 'dispatched',
          receipt: { kind: 'federated_dispatch_ready' }
        })
      }
      const task = this.getTask(dispatch.task_id)
      if (task?.status === 'blocked') {
        transitionLifecycleWithDb(this.db, {
          entity: 'task',
          id: dispatch.task_id,
          from: 'blocked',
          to: 'dispatched',
          projection: { completed_at: null },
          receipt: { kind: 'federated_task_ready' }
        })
      }
    } else if (params.state === 'start_unknown') {
      transitionLifecycleWithDb(this.db, {
        entity: 'worker',
        id: params.dispatchId,
        from: worker.state,
        to: worker.state,
        projection: {
          stage: params.stage,
          last_error: params.lastError ?? worker.last_error,
          updated_at: new Date().toISOString()
        },
        receipt: { kind: 'federated_worker_start_unknown' }
      })
    } else {
      const reason = params.lastError ?? `The worker server reported ${params.state}.`
      transitionLifecycleWithDb(this.db, {
        entity: 'worker',
        id: params.dispatchId,
        from: worker.state,
        to: params.state,
        projection: {
          stage: params.stage,
          last_error: reason,
          updated_at: new Date().toISOString()
        },
        receipt: { kind: `federated_worker_${params.state}`, details: { reason } }
      })
      if (['pending', 'dispatched'].includes(dispatch.status)) {
        transitionLifecycleWithDb(this.db, {
          entity: 'dispatch',
          id: params.dispatchId,
          from: dispatch.status,
          to: 'failed',
          projection: {
            last_failure: reason,
            completed_at: new Date().toISOString(),
            capability_revoked_at: dispatch.capability_revoked_at ?? new Date().toISOString()
          },
          receipt: { kind: 'federated_dispatch_failed', details: { reason } }
        })
      }
      reconcileTaskAfterDispatchInterruption(this, dispatch.task_id, params.dispatchId)
      const task = this.getTask(dispatch.task_id)
      if (
        task &&
        ['blocked', 'dispatched'].includes(task.status) &&
        !this.db
          .prepare(
            "SELECT 1 FROM dispatch_contexts WHERE task_id = ? AND status IN ('pending', 'dispatched')"
          )
          .get(dispatch.task_id)
      ) {
        transitionLifecycleWithDb(this.db, {
          entity: 'task',
          id: dispatch.task_id,
          from: task.status,
          to: 'failed',
          projection: { completed_at: new Date().toISOString() },
          receipt: { kind: 'federated_task_failed' }
        })
      }
      this.closeQuestionsForDispatch(params.dispatchId)
    }
    this.db.exec('COMMIT')
    return this.getWorkerDispatch(params.dispatchId) as WorkerDispatchRow
  } catch (error) {
    this.db.exec('ROLLBACK')
    throw error
  }
}

export type FederatedWorkerStartReconcileMethods = {
  reconcileFederatedWorkerStart: typeof reconcileFederatedWorkerStart
}

export function attachFederatedWorkerStartReconcile(ctor: { prototype: object }): void {
  Object.assign(ctor.prototype, {
    reconcileFederatedWorkerStart
  })
}
