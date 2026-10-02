import { db } from './db'
import {
  extractRawItems,
  normalizeCallback,
  peekCallbackId,
  InvalidCallbackError
} from './machineAdapter'
import {
  activityFactor,
  makeBasisKey,
  recipeCodeOf,
  sameBaseline,
  suggestMinutesForActivity
} from './advice'
import type { DevRecipe } from '../types/dev-recipe'
import type { DevCorrection, CorrectionBasis } from '../types/dev-correction'
import type { MachineCallbackPayload, MachineReading } from '../types/machine-reading'
import type { RecipeBaselineConflict } from '../types/baseline-conflict'

/**
 * 冲洗机回传摄入服务。
 * 事务边界内完成：幂等去重 → 台账对账 → 活性事实更新 →
 * 配方基准冲突并列留档 → 未完成建议失效并重算。
 */

export interface IngestItemOutcome {
  callbackId: string
  duplicated: boolean
  readingId: number
  reconcileState: MachineReading['reconcileState']
  activityApplied: boolean
  conflictCreated: boolean
  conflictId?: number
}

export interface IngestResult {
  accepted: number
  duplicated: number
  items: IngestItemOutcome[]
}

function nowIso(): string {
  return new Date().toISOString()
}

function buildBasis(
  recipe: DevRecipe,
  activity: number,
  readingId: number,
  baselineOverride?: { tempC: number; devMinutes: number },
  conflictResolved = false
): CorrectionBasis {
  const baselineTempC = baselineOverride?.tempC ?? recipe.tempC
  const baselineMinutes = baselineOverride?.devMinutes ?? recipe.devMinutes
  const partial = {
    recipeCode: recipeCodeOf(recipe),
    baselineTempC,
    baselineMinutes,
    activity,
    readingId,
    conflictResolved
  }
  return { ...partial, basisKey: makeBasisKey(partial) }
}

/** 该工作液批号是否存在未人工选定的配方基准冲突（存在则冻结，不参与新建议） */
async function findOpenConflict(
  developerId: number,
  solutionBatchNo: string,
  tx: typeof db,
  recipeId?: number
): Promise<RecipeBaselineConflict | undefined> {
  const collection = tx.baselineConflicts
    .where('developerId').equals(developerId)
    .filter((conflict) => conflict.status === 'pending' && conflict.solutionBatchNo === solutionBatchNo)
  if (recipeId !== undefined) {
    return collection.filter((conflict) => conflict.recipeId === recipeId).first()
  }
  return collection.first()
}

/** 活性更新：未完成（pending）建议立即失效；已 applied 的保持原样 */
async function voidPendingForDeveloper(
  developerId: number,
  readingId: number,
  tx: typeof db
): Promise<number> {
  const pending = await tx.corrections
    .where('developerId').equals(developerId)
    .filter((item) => item.status === 'pending')
    .toArray()
  const stamp = nowIso()
  await Promise.all(pending.map((item) => tx.corrections.update(item.id as number, {
    status: 'void',
    voidedByReadingId: readingId,
    voidedAt: stamp,
    updatedAt: stamp
  })))
  return pending.length
}

/**
 * 依据当前活性事实，为本机所有使用该工作液的配方重算 pending 建议。
 * 建议仅来自本机配方与工作液事实；基准冲突未选定的工作液跳过。
 * 同依据（basisKey）不重复生成。
 */
export async function regenerateCorrections(
  developerId: number,
  activity: number,
  readingId: number,
  tx: typeof db = db
): Promise<number> {
  const developer = await tx.developers.get(developerId)
  if (!developer) return 0
  // 人工选定前，整批工作液冻结：任何配方都不生成新建议
  const openConflict = await findOpenConflict(developerId, developer.batchNo, tx)
  if (openConflict) return 0
  const recipes = await tx.recipes.where('developerId').equals(developerId).toArray()
  const existing = await tx.corrections
    .where('developerId').equals(developerId)
    .filter((item) => item.status === 'pending')
    .toArray()
  let created = 0
  const stamp = nowIso()
  for (const recipe of recipes) {
    const resolvedConflict = await tx.baselineConflicts
      .where('developerId').equals(developerId)
      .filter((item) => item.status === 'resolved'
        && item.recipeId === recipe.id
        && item.solutionBatchNo === developer.batchNo)
      .first()
    const basis = buildBasis(
      recipe,
      activity,
      readingId,
      resolvedConflict?.resolvedBaseline,
      Boolean(resolvedConflict)
    )
    if (existing.some((item) => item.basis.basisKey === basis.basisKey)) continue
    const correction: DevCorrection = {
      developerId,
      solutionBatchNo: developer.batchNo,
      recipeId: recipe.id as number,
      status: 'pending',
      suggestedMinutes: suggestMinutesForActivity(basis.baselineMinutes, activity),
      activityFactor: activityFactor(activity),
      basis,
      createdAt: stamp,
      updatedAt: stamp,
      schemaRev: 3
    }
    await tx.corrections.add(correction)
    created += 1
  }
  return created
}

/** 读数与实冲记录对上账：把实冲标为仪器校验并关联读数（不改动任何实测值） */
async function attachReadingToRun(
  runId: number,
  readingId: number,
  tx: typeof db
): Promise<void> {
  const run = await tx.runs.get(runId)
  if (!run) return
  // 已完成的实冲记录与当时判定依据照旧：不覆盖已有读数关联与依据快照
  await tx.runs.update(runId, {
    verifiedBy: 'instrument',
    readingId: run.readingId ?? readingId
  })
}

/** 读数对账：与本地工作液批号、实冲批次核对 */
async function reconcileReading(
  payload: MachineCallbackPayload,
  tx: typeof db
): Promise<Pick<MachineReading, 'developerId' | 'runId' | 'reconcileState'>> {
  const developer = await tx.developers.where('batchNo').equals(payload.solutionBatchNo).first()
  const run = await tx.runs.where('batchNo').equals(payload.runBatchNo).first()

  if (!developer || !run) {
    return { developerId: developer?.id, runId: run?.id, reconcileState: 'unmatched' }
  }
  if (run.developerId !== developer.id) {
    return { developerId: developer.id, runId: run.id, reconcileState: 'batch-mismatch' }
  }
  return { developerId: developer.id, runId: run.id, reconcileState: 'matched' }
}

/** 若读数带有配方基准，与本机配方对照，不一致则并列保留两版待人工选定 */
async function detectBaselineConflict(
  reading: MachineReading,
  tx: typeof db
): Promise<number | undefined> {
  const { developerId, runId } = reading
  if (!reading.recipeBaseline || developerId === undefined || runId === undefined) return undefined
  const run = await tx.runs.get(runId)
  if (!run) return undefined
  const recipe = await tx.recipes.get(run.recipeId)
  if (!recipe) return undefined

  const localBaseline = {
    recipeCode: recipeCodeOf(recipe),
    tempC: recipe.tempC,
    devMinutes: recipe.devMinutes
  }
  if (sameBaseline(reading.recipeBaseline, localBaseline)) return undefined

  // 同工作液+同配方已有待选定冲突：保留原冲突，不重复堆叠
  const existing = await tx.baselineConflicts
    .where('developerId').equals(developerId)
    .filter((item) => item.status === 'pending'
      && item.recipeId === recipe.id
      && item.solutionBatchNo === reading.solutionBatchNo)
    .first()
  if (existing) return existing.id

  const record: RecipeBaselineConflict = {
    readingId: reading.id as number,
    callbackId: reading.callbackId,
    solutionBatchNo: reading.solutionBatchNo,
    developerId,
    runBatchNo: reading.runBatchNo,
    recipeId: recipe.id as number,
    machineBaseline: reading.recipeBaseline,
    localBaseline,
    status: 'pending',
    createdAt: nowIso(),
    schemaRev: 3
  }
  return tx.baselineConflicts.add(record)
}

/**
 * 判断读数是否推动活性更新：
 * - 必须对得上正确的本地工作液（batch-mismatch / unmatched 不采纳）
 * - 测量时间须晚于当前已采用的活性事实；重试与迟到的旧读数只留事实
 */
async function shouldApplyActivity(
  solutionBatchNo: string,
  measuredAt: string,
  reconcileState: MachineReading['reconcileState'],
  tx: typeof db
): Promise<boolean> {
  if (reconcileState !== 'matched') return false
  const latest = await tx.readings
    .where('solutionBatchNo').equals(solutionBatchNo)
    .filter((item) => item.activityApplied)
    .first()
  return !latest || measuredAt > latest.measuredAt
}

/** 返回已存在读数的幂等结果（重试/乱码重发都安全） */
async function duplicatedOutcome(
  callbackId: string,
  tx: typeof db
): Promise<IngestItemOutcome> {
  const previous = await tx.readings.where('callbackId').equals(callbackId).first()
  if (!previous) throw new InvalidCallbackError('内部错误：幂等记录丢失')
  await tx.readings.update(previous.id as number, {
    deliveryCount: previous.deliveryCount + 1
  })
  return {
    callbackId,
    duplicated: true,
    readingId: previous.id as number,
    reconcileState: previous.reconcileState,
    activityApplied: previous.activityApplied,
    conflictCreated: false
  }
}

async function ingestOne(
  rawItem: unknown,
  tx: typeof db
): Promise<IngestItemOutcome> {
  // 幂等优先：同一 callbackId 一律不重新校验内容、不新增读数、不更新活性
  const callbackId = peekCallbackId(rawItem)
  if (callbackId && await tx.readings.where('callbackId').equals(callbackId).first()) {
    return duplicatedOutcome(callbackId, tx)
  }

  // 新报文才做严格字段校验；非法内容整体拒绝
  const payload = normalizeCallback(rawItem)

  const reconciliation = await reconcileReading(payload, tx)

  const activityApplied = await shouldApplyActivity(
    payload.solutionBatchNo,
    payload.measuredAt,
    reconciliation.reconcileState,
    tx
  )

  const reading: MachineReading = {
    ...payload,
    ...reconciliation,
    activityApplied,
    receivedAt: nowIso(),
    deliveryCount: 1,
    schemaRev: 3
  }
  const readingId = await tx.readings.add(reading)
  reading.id = readingId

  if (reconciliation.reconcileState === 'matched' && reconciliation.runId !== undefined) {
    await attachReadingToRun(reconciliation.runId, readingId, tx)
  }

  let conflictId: number | undefined
  if (activityApplied && reconciliation.developerId !== undefined) {
    await tx.developers.update(reconciliation.developerId, {
      lastActivity: payload.activity,
      lastActivityAt: payload.measuredAt
    })
    // 活性更新：未完成的修正建议立即失效，再按新活性重算
    await voidPendingForDeveloper(reconciliation.developerId, readingId, tx)
    conflictId = await detectBaselineConflict(reading, tx)
    await regenerateCorrections(reconciliation.developerId, payload.activity, readingId, tx)
  }

  return {
    callbackId: payload.callbackId,
    duplicated: false,
    readingId,
    reconcileState: reconciliation.reconcileState,
    activityApplied,
    conflictCreated: conflictId !== undefined,
    conflictId
  }
}

/**
 * 投递一批回传报文（重试安全）。
 * 幂等判断先于内容校验：任何已见过的 callbackId 都只累加投递次数。
 * 全新报文若字段非法则整体拒绝，不产生部分写入。
 */
export async function ingestCallbacks(raw: unknown): Promise<IngestResult> {
  const rawItems = extractRawItems(raw)
  if (rawItems.length === 0) throw new InvalidCallbackError('回传批次为空')

  return db.transaction(
    'rw',
    [db.readings, db.developers, db.runs, db.recipes, db.baselineConflicts, db.corrections],
    async () => {
      const seenInBatch = new Set<string>()
      const items: IngestItemOutcome[] = []
      for (const rawItem of rawItems) {
        const callbackId = peekCallbackId(rawItem)
        if (callbackId && seenInBatch.has(callbackId)) {
          items.push(await duplicatedOutcome(callbackId, db))
          continue
        }
        if (callbackId) seenInBatch.add(callbackId)
        items.push(await ingestOne(rawItem, db))
      }
      return {
        accepted: items.filter((item) => !item.duplicated).length,
        duplicated: items.filter((item) => item.duplicated).length,
        items
      }
    }
  )
}

/**
 * 读数晚于实冲记录到达，或补录实冲后，把尚未对上的读数重新对账。
 * 已对账读数不重复处理。
 */
export async function reconcilePendingReadings(): Promise<number> {
  return db.transaction(
    'rw',
    [db.readings, db.developers, db.runs, db.recipes, db.baselineConflicts, db.corrections],
    async () => {
      const pendingReadings = await db.readings
        .filter((reading) => reading.reconcileState !== 'matched')
        .toArray()
      let changed = 0
      for (const reading of pendingReadings) {
        const reconciliation = await reconcileReading(reading, db)
        if (reconciliation.reconcileState === reading.reconcileState) continue
        await db.readings.update(reading.id as number, { ...reconciliation })
        changed += 1
        if (reconciliation.reconcileState === 'matched' && reconciliation.runId !== undefined) {
          await attachReadingToRun(reconciliation.runId, reading.id as number, db)
        }

        // 对账成功的读数若带来更新的活性事实，则解冻活性并触发重算
        if (reconciliation.developerId !== undefined) {
          const shouldApply = await shouldApplyActivity(
            reading.solutionBatchNo,
            reading.measuredAt,
            reconciliation.reconcileState,
            db
          )
          if (shouldApply) {
            await db.readings.update(reading.id as number, { activityApplied: true })
            await db.developers.update(reconciliation.developerId, {
              lastActivity: reading.activity,
              lastActivityAt: reading.measuredAt
            })
            await voidPendingForDeveloper(reconciliation.developerId, reading.id as number, db)
            await detectBaselineConflict({ ...reading, ...reconciliation }, db)
            await regenerateCorrections(reconciliation.developerId, reading.activity, reading.id as number, db)
          }
        }
      }
      return changed
    }
  )
}

/** 人工选定配方基准版本后：解除工作液冻结，并按所选基准立即重算建议 */
export async function resolveBaselineConflict(
  conflictId: number,
  chosenSide: 'machine' | 'local'
): Promise<void> {
  await db.transaction(
    'rw',
    [db.baselineConflicts, db.developers, db.recipes, db.readings, db.corrections],
    async () => {
      const conflict = await db.baselineConflicts.get(conflictId)
      if (!conflict || conflict.status !== 'pending') return
      const resolvedBaseline = chosenSide === 'machine' ? conflict.machineBaseline : conflict.localBaseline
      await db.baselineConflicts.update(conflictId, {
        status: 'resolved',
        chosenSide,
        resolvedBaseline,
        resolvedAt: nowIso()
      })

      const appliedReadings = await db.readings
        .where('solutionBatchNo').equals(conflict.solutionBatchNo)
        .filter((item) => item.activityApplied)
        .toArray()
      const appliedReading = appliedReadings
        .sort((a, b) => b.measuredAt.localeCompare(a.measuredAt))[0]
      if (!appliedReading) return
      // 基准变更视为依据更新：旧 pending 建议失效后按选定基准重算
      await voidPendingForDeveloper(conflict.developerId, appliedReading.id as number, db)
      await regenerateCorrections(conflict.developerId, appliedReading.activity, appliedReading.id as number, db)
    }
  )
}
