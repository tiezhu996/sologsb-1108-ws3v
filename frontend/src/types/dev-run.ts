import type { CorrectionBasis } from './dev-correction'

export type TankType = '双联罐' | '深罐'

/** 数据校验来源：instrument=有仪器读数；manual=手工校验，无读数不补造数值 */
export type RunVerification = 'instrument' | 'manual'

export interface DevRun {
  id?: number
  batchNo: string
  recipeId: number
  actualTempC: number
  actualMinutes: number
  tankType: TankType
  runDate: string
  result: string
  /** 实冲时使用的工作液；无对应工作液时为空 */
  developerId?: number | null
  /** 仪器读数 / 手工校验（旧记录默认手工校验） */
  verifiedBy: RunVerification
  /** 仪器校验时关联的控制条读数 ID；手工校验时不设置 */
  readingId?: number | null
  /** 采纳本机修正建议时冻结的判定依据；手工录入无建议时不设置 */
  basisSnapshot?: CorrectionBasis | null
  schemaRev?: number
}
