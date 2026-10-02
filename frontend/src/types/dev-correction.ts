/**
 * 本机修正建议：配方建议始终由本机按配方与工作液活性重算，
 * 外部系统不参与建议生成。
 *
 * 生命周期：
 * pending  —— 活性更新后生成/重算，等待在实冲中采纳
 * applied  —— 已被某条实冲记录采纳，判定依据当场冻结，永不再变
 * void     —— 活性再次更新时尚未采纳，立即失效（由新的 pending 建议接替）
 */

export type CorrectionStatus = 'pending' | 'applied' | 'void'

/** 生成建议时的判定依据快照，applied 后永久保留，重算不覆盖 */
export interface CorrectionBasis {
  recipeCode: string
  /** 当时采用的配方基准（受基准冲突人工选定结果约束） */
  baselineTempC: number
  baselineMinutes: number
  /** 建议生成时的工作液活性（事实，来自控制条） */
  activity: number
  /** 该活性对应的读数 ID */
  readingId: number
  /** 依据的配方基准是否经过人工冲突选定 */
  conflictResolved: boolean
  basisKey: string
}

export interface DevCorrection {
  id?: number
  developerId: number
  solutionBatchNo: string
  recipeId: number
  /** 建议状态机 */
  status: CorrectionStatus
  /** 按基准温度折算后的建议显影时长（分钟），已计入活性衰减 */
  suggestedMinutes: number
  /** 活性补偿系数（不含温度折算） */
  activityFactor: number
  basis: CorrectionBasis
  /** applied：被哪条实冲记录采纳 */
  appliedRunId?: number
  appliedAt?: string
  /** 被作废时的活性读数 ID（被哪个更新的活性淘汰） */
  voidedByReadingId?: number
  voidedAt?: string
  createdAt: string
  updatedAt: string
  schemaRev?: number
}
