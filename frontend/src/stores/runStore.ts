import { defineStore } from 'pinia'
import { db, plain } from '../utils/db'
import { reconcilePendingReadings } from '../utils/machineIngest'
import type { DevRun, RunVerification } from '../types/dev-run'
import type { CorrectionBasis } from '../types/dev-correction'

export interface NewRunInput {
  batchNo: string
  recipeId: number
  actualTempC: number
  actualMinutes: number
  tankType: DevRun['tankType']
  runDate: string
  result: string
  developerId?: number | null
  /** 手工录入默认手工校验；与读数对账后可改为仪器 */
  verifiedBy?: RunVerification
  readingId?: number | null
  /** 采纳的 pending 建议：保存即采纳并冻结判定依据 */
  applyCorrectionId?: number | null
}

export const useRunStore = defineStore('run', {
  state: () => ({
    runs: [] as DevRun[],
    loading: false
  }),
  getters: {
    recentRuns: (state) => [...state.runs]
      .sort((a, b) => b.runDate.localeCompare(a.runDate))
      .slice(0, 6)
  },
  actions: {
    async load(): Promise<void> {
      this.loading = true
      try {
        this.runs = await db.runs.orderBy('id').reverse().toArray()
      } finally {
        this.loading = false
      }
    },
    async addRun(payload: NewRunInput): Promise<number> {
      let basisSnapshot: CorrectionBasis | null = null
      if (payload.applyCorrectionId !== undefined && payload.applyCorrectionId !== null) {
        const correction = await db.corrections.get(payload.applyCorrectionId)
        // 只有 pending 建议可被采纳；已经失效的建议不可再用
        if (correction && correction.status === 'pending') {
          basisSnapshot = correction.basis
        }
      }

      const next: Omit<DevRun, 'id'> = {
        batchNo: payload.batchNo,
        recipeId: payload.recipeId,
        actualTempC: payload.actualTempC,
        actualMinutes: payload.actualMinutes,
        tankType: payload.tankType,
        runDate: payload.runDate,
        result: payload.result,
        developerId: payload.developerId ?? null,
        verifiedBy: basisSnapshot ? 'instrument' : payload.verifiedBy ?? 'manual',
        readingId: payload.readingId ?? null,
        basisSnapshot,
        schemaRev: 3
      }
      const id = await db.runs.add(plain(next))

      if (basisSnapshot && payload.applyCorrectionId !== undefined && payload.applyCorrectionId !== null) {
        // 建议被采纳：标记 applied 并冻结依据，之后活性更新也不再改动它
        await db.corrections.update(payload.applyCorrectionId, plain({
          status: 'applied',
          appliedRunId: id,
          appliedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        }))
      }

      const developerId = payload.developerId ?? null
      if (developerId !== null) {
        const developer = await db.developers.get(developerId)
        if (developer && developer.id !== undefined && developer.state !== '报废') {
          await db.developers.update(developer.id, plain({ usedRolls: developer.usedRolls + 1 }))
        }
      }

      // 新实冲可能让先到达但未对上账的读数完成对账
      await reconcilePendingReadings()
      await this.load()
      return id
    },
    async writeBackNote(runId: number, recipeId: number): Promise<void> {
      const run = await db.runs.get(runId)
      if (!run) return
      const note = `${run.runDate} 实冲 ${run.actualTempC}°C / ${run.actualMinutes} 分钟：${run.result}`
      await db.recipes.update(recipeId, plain({ note }))
    }
  }
})
