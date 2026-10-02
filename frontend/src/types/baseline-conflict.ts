/**
 * 配方基准冲突：回传中的配方基准在本机被改过（或本机基准与机器不一致）。
 * 两版并列保留，人工选定前该工作液批号不参与新建议。
 */

import type { MachineRecipeBaseline } from './machine-reading'

export type BaselineConflictStatus = 'pending' | 'resolved'

export interface RecipeBaselineConflict {
  id?: number
  /** 触发冲突的读数 ID（可回溯事实来源） */
  readingId: number
  /** 触发冲突的回调报文 ID */
  callbackId: string
  solutionBatchNo: string
  developerId: number
  runBatchNo: string
  recipeId: number
  /** 机器回传的配方基准版本 */
  machineBaseline: MachineRecipeBaseline
  /** 冲突发生瞬间本机配方基准版本 */
  localBaseline: MachineRecipeBaseline
  status: BaselineConflictStatus
  /** 人工选定：machine=采用机器版，local=沿用本机版 */
  chosenSide?: 'machine' | 'local'
  /** 选定后冻结的基准，作为后续重算修正建议的依据 */
  resolvedBaseline?: MachineRecipeBaseline
  resolvedAt?: string
  createdAt: string
  schemaRev?: number
}
