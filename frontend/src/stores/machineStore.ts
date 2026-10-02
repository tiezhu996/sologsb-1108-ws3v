import { defineStore } from 'pinia'
import { db } from '../utils/db'
import {
  ingestCallbacks,
  reconcilePendingReadings,
  resolveBaselineConflict,
  type IngestResult
} from '../utils/machineIngest'
import type { MachineReading } from '../types/machine-reading'
import type { RecipeBaselineConflict } from '../types/baseline-conflict'
import type { DevCorrection } from '../types/dev-correction'

export const useMachineStore = defineStore('machine', {
  state: () => ({
    readings: [] as MachineReading[],
    conflicts: [] as RecipeBaselineConflict[],
    corrections: [] as DevCorrection[],
    loading: false
  }),
  getters: {
    pendingConflicts: (state) => state.conflicts.filter((item) => item.status === 'pending'),
    blockedBatchNos(): string[] {
      return [...new Set(this.pendingConflicts.map((item) => item.solutionBatchNo))]
    },
    pendingCorrections: (state) => state.corrections.filter((item) => item.status === 'pending'),
    voidCorrections: (state) => state.corrections.filter((item) => item.status === 'void'),
    appliedCorrections: (state) => state.corrections.filter((item) => item.status === 'applied'),
    unmatchedReadings: (state) => state.readings.filter(
      (item) => item.reconcileState === 'unmatched' || item.reconcileState === 'batch-mismatch'
    )
  },
  actions: {
    async load(): Promise<void> {
      this.loading = true
      try {
        const [readings, conflicts, corrections] = await Promise.all([
          db.readings.orderBy('id').reverse().toArray(),
          db.baselineConflicts.orderBy('id').reverse().toArray(),
          db.corrections.orderBy('id').reverse().toArray()
        ])
        this.readings = readings
        this.conflicts = conflicts
        this.corrections = corrections
      } finally {
        this.loading = false
      }
    },
    async ingest(raw: unknown): Promise<IngestResult> {
      const result = await ingestCallbacks(raw)
      await this.load()
      return result
    },
    async reconcilePending(): Promise<number> {
      const changed = await reconcilePendingReadings()
      await this.load()
      return changed
    },
    async resolveConflict(id: number, side: 'machine' | 'local'): Promise<void> {
      await resolveBaselineConflict(id, side)
      await this.load()
    },
    pendingCorrectionFor(developerId?: number | null, recipeId?: number): DevCorrection | undefined {
      if (developerId === undefined || developerId === null) return undefined
      return this.corrections.find(
        (item) => item.status === 'pending' && item.developerId === developerId && item.recipeId === recipeId
      )
    }
  }
})
