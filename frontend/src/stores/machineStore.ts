import { defineStore } from 'pinia'
import { db, plain } from '../utils/db'
import { baselineMatches, buildAdviceFromReading } from '../utils/recalc'
import type { MachineReading, MachineReportPayload, ReconStatus } from '../types/machine-reading'
import type { BaselineConflict } from '../types/baseline-conflict'
import type { CorrectionAdvice } from '../types/correction-advice'

export interface IngestResult {
  reading: MachineReading
  duplicated: boolean
  reconStatus: ReconStatus
  conflictPending: boolean
  suspended: boolean
  invalidatedCount: number
  createdAdviceCount: number
}

function nowStamp(): string {
  const now = new Date()
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`
}

async function invalidatePendingAdvices(developerId: number, closedAt: string): Promise<number> {
  const pending = await db.advices
    .where('developerId').equals(developerId)
    .filter((advice) => advice.status === 'pending')
    .toArray()
  await Promise.all(pending.map((advice) => db.advices.update(advice.id ?? 0, plain({
    status: 'invalidated',
    closedAt
  }))))
  return pending.length
}

async function regenerateAdvices(
  developerId: number,
  extraRecipeIds: number[],
  reading: MachineReading,
  now: string
): Promise<{ invalidatedCount: number; createdAdviceCount: number }> {
  const invalidatedCount = await invalidatePendingAdvices(developerId, now)
  const all = await db.advices.where('developerId').equals(developerId).toArray()
  const latestByRecipe = new Map<number, CorrectionAdvice>()
  for (const advice of all) {
    const current = latestByRecipe.get(advice.recipeId)
    if (!current || (advice.id ?? 0) > (current.id ?? 0)) latestByRecipe.set(advice.recipeId, advice)
  }
  const recipeIds = new Set<number>(extraRecipeIds)
  for (const [recipeId, latest] of latestByRecipe) {
    if (latest.status === 'invalidated') recipeIds.add(recipeId)
  }
  let createdAdviceCount = 0
  for (const recipeId of recipeIds) {
    const recipe = await db.recipes.get(recipeId)
    if (!recipe) continue
    await db.advices.add(plain(buildAdviceFromReading(reading, recipe, now)))
    createdAdviceCount += 1
  }
  return { invalidatedCount, createdAdviceCount }
}

export const useMachineStore = defineStore('machine', {
  state: () => ({
    readings: [] as MachineReading[],
    conflicts: [] as BaselineConflict[],
    advices: [] as CorrectionAdvice[],
    loading: false
  }),
  getters: {
    pendingConflicts: (state) => state.conflicts.filter((conflict) => conflict.status === 'pending'),
    pendingConflictDeveloperIds(): Set<number> {
      return new Set(this.pendingConflicts.map((conflict) => conflict.developerId))
    },
    pendingAdvices: (state) => state.advices.filter((advice) => advice.status === 'pending'),
    latestReadingByDeveloper(): Map<number, MachineReading> {
      const map = new Map<number, MachineReading>()
      for (const reading of this.readings) {
        if (reading.developerId === undefined) continue
        const current = map.get(reading.developerId)
        if (!current || (reading.id ?? 0) > (current.id ?? 0)) map.set(reading.developerId, reading)
      }
      return map
    }
  },
  actions: {
    async load(): Promise<void> {
      this.loading = true
      try {
        const [readings, conflicts, advices] = await Promise.all([
          db.readings.orderBy('id').reverse().toArray(),
          db.conflicts.orderBy('id').reverse().toArray(),
          db.advices.orderBy('id').reverse().toArray()
        ])
        this.readings = readings
        this.conflicts = conflicts
        this.advices = advices
      } finally {
        this.loading = false
      }
    },
    async ingestReport(payload: MachineReportPayload): Promise<IngestResult> {
      const now = nowStamp()
      const result = await db.transaction(
        'rw',
        [db.readings, db.developers, db.runs, db.recipes, db.conflicts, db.advices],
        async (): Promise<IngestResult> => {
          const duplicated = await db.readings.where('reportId').equals(payload.reportId).first()
          if (duplicated) {
            return {
              reading: duplicated,
              duplicated: true,
              reconStatus: duplicated.reconStatus,
              conflictPending: false,
              suspended: false,
              invalidatedCount: 0,
              createdAdviceCount: 0
            }
          }

          const developer = await db.developers.where('batchNo').equals(payload.developerBatchNo).first()
          const run = await db.runs.where('batchNo').equals(payload.runBatchNo).first()
          const reconStatus: ReconStatus = !developer ? 'developer-missing' : !run ? 'run-missing' : 'matched'

          const reading: MachineReading = {
            ...payload,
            reconStatus,
            developerId: developer?.id,
            runId: run?.id,
            receivedAt: now,
            schemaRev: 3
          }
          const readingId = await db.readings.add(plain(reading))
          reading.id = readingId

          if (run?.id !== undefined) {
            await db.runs.update(run.id, plain({ readingSource: 'machine', readingId }))
          }

          let conflictPending = false
          if (developer?.id !== undefined && run) {
            const recipe = await db.recipes.get(run.recipeId)
            if (recipe && !baselineMatches(recipe, payload.machineBaselineTempC, payload.machineBaselineMinutes)) {
              const existing = await db.conflicts
                .where('developerId').equals(developer.id)
                .filter((conflict) => conflict.status === 'pending')
                .first()
              if (existing?.id !== undefined) {
                await db.conflicts.update(existing.id, plain({
                  machineTempC: payload.machineBaselineTempC,
                  machineMinutes: payload.machineBaselineMinutes,
                  readingId
                }))
              } else {
                await db.conflicts.add(plain({
                  developerId: developer.id,
                  recipeId: recipe.id ?? 0,
                  readingId,
                  localTempC: recipe.tempC,
                  localMinutes: recipe.devMinutes,
                  machineTempC: payload.machineBaselineTempC,
                  machineMinutes: payload.machineBaselineMinutes,
                  status: 'pending',
                  createdAt: now,
                  schemaRev: 3
                }))
              }
              conflictPending = true
            }
          }

          let suspended = false
          let invalidatedCount = 0
          let createdAdviceCount = 0
          if (developer?.id !== undefined) {
            const hasPendingConflict = conflictPending || await db.conflicts
              .where('developerId').equals(developer.id)
              .filter((conflict) => conflict.status === 'pending')
              .count() > 0
            if (hasPendingConflict) {
              invalidatedCount = await invalidatePendingAdvices(developer.id, now)
              suspended = true
            } else {
              const cascade = await regenerateAdvices(
                developer.id,
                run ? [run.recipeId] : [],
                reading,
                now
              )
              invalidatedCount = cascade.invalidatedCount
              createdAdviceCount = cascade.createdAdviceCount
            }
          }

          return { reading, duplicated: false, reconStatus, conflictPending, suspended, invalidatedCount, createdAdviceCount }
        }
      )
      await this.load()
      return result
    },
    async resolveConflict(conflictId: number, choice: 'local' | 'machine'): Promise<void> {
      const now = nowStamp()
      await db.transaction('rw', [db.conflicts, db.recipes, db.readings, db.advices], async () => {
        const conflict = await db.conflicts.get(conflictId)
        if (!conflict || conflict.status !== 'pending') return
        if (choice === 'machine') {
          await db.recipes.update(conflict.recipeId, plain({
            tempC: conflict.machineTempC,
            devMinutes: conflict.machineMinutes
          }))
        }
        await db.conflicts.update(conflictId, plain({
          status: choice === 'local' ? 'resolved-local' : 'resolved-machine',
          resolvedAt: now
        }))
        const latestReading = await db.readings
          .where('developerId').equals(conflict.developerId)
          .toArray()
          .then((list) => list.sort((a, b) => (b.id ?? 0) - (a.id ?? 0))[0])
        if (latestReading) {
          await regenerateAdvices(conflict.developerId, [conflict.recipeId], latestReading, now)
        }
      })
      await this.load()
    },
    async applyAdvice(adviceId: number): Promise<void> {
      const advice = await db.advices.get(adviceId)
      if (!advice || advice.status !== 'pending') return
      await db.advices.update(adviceId, plain({ status: 'applied', closedAt: nowStamp() }))
      await this.load()
    }
  }
})
