import type { DevRecipe } from '../types/dev-recipe'
import type { CorrectionBasis } from '../types/dev-correction'

/**
 * 本机修正建议引擎。
 * 配方建议只由本机依据「配方基准 + 工作液活性事实」重算，
 * 冲洗机不提供任何建议字段。
 */

/** 活性 → 时间补偿系数：活性越低，显影时间越长（线性补偿，封顶） */
export function activityFactor(activity: number): number {
  const safe = Math.min(1, Math.max(0.2, activity))
  return Math.round((1 / safe) * 1000) / 1000
}

/** 两版配方基准是否一致（温度与时长都相同才视为一致） */
export function sameBaseline(
  a: { tempC: number; devMinutes: number },
  b: { tempC: number; devMinutes: number }
): boolean {
  return a.tempC === b.tempC && a.devMinutes === b.devMinutes
}

/** 基准温度下、计入活性衰减后的建议时长 */
export function suggestMinutesForActivity(baseMinutes: number, activity: number): number {
  const factor = activityFactor(activity)
  return Math.max(0.25, Math.round(baseMinutes * factor * 100) / 100)
}

/**
 * 实冲时在指定实测温度下应采用的分钟数：
 * 先按配方温度基准做活性补偿，再按实测温度做温度补偿。
 * 沿用既有温度补偿模型（每 +1°C ×0.9，每 -1°C ×1.1）。
 */
export function suggestMinutesAtTemp(
  basis: Pick<CorrectionBasis, 'baselineTempC' | 'baselineMinutes' | 'activity'>,
  actualTempC: number
): number {
  const atBaseline = suggestMinutesForActivity(basis.baselineMinutes, basis.activity)
  const delta = actualTempC - basis.baselineTempC
  const tempFactor = delta >= 0 ? Math.pow(0.9, delta) : Math.pow(1.1, Math.abs(delta))
  return Math.max(0.25, Math.round(atBaseline * tempFactor * 100) / 100)
}

/** 配方基准的稳定摘要，用于判断回传基准与本机配方是否一致 */
export function recipeCodeOf(recipe: DevRecipe): string {
  return `REC-${recipe.id}`
}

/** 依据快照的稳定键：依据任一要素变化即重算 */
export function makeBasisKey(parts: {
  recipeCode: string
  baselineTempC: number
  baselineMinutes: number
  activity: number
  readingId: number
  conflictResolved: boolean
}): string {
  return [
    parts.recipeCode,
    parts.baselineTempC,
    parts.baselineMinutes,
    parts.activity,
    parts.readingId,
    parts.conflictResolved ? 'R' : 'A'
  ].join('|')
}

export function describeAdvice(basis: CorrectionBasis, suggestedMinutes: number): string {
  const pct = Math.round((basis.activity - 1) * 100)
  const activityText = pct === 0
    ? '活性 100%，无需活性补偿'
    : `活性 ${Math.round(basis.activity * 100)}%（${pct > 0 ? '+' : ''}${pct}%），活性补偿系数 ×${activityFactor(basis.activity)}`
  return `${activityText}；建议基准时长 ${suggestedMinutes.toFixed(2)} 分钟（依据读数 #${basis.readingId}）`
}
