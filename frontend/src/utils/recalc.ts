import { calculateCompensatedMinutes } from '../hooks/useTempCompensate'
import type { CorrectionAdvice } from '../types/correction-advice'
import type { DevRecipe } from '../types/dev-recipe'
import type { MachineReading } from '../types/machine-reading'

const MIN_ACTIVITY = 0.5
const MAX_ACTIVITY = 1.5

export function clampActivity(activity: number): number {
  if (!Number.isFinite(activity)) return 1
  return Math.min(MAX_ACTIVITY, Math.max(MIN_ACTIVITY, activity))
}

export function recalcSuggestedMinutes(
  baseMinutes: number,
  baseTempC: number,
  measuredTempC: number,
  activity: number
): number {
  const tempAdjusted = calculateCompensatedMinutes(baseMinutes, measuredTempC, baseTempC)
  const safeActivity = clampActivity(activity)
  return Math.max(0.25, Math.round((tempAdjusted / safeActivity) * 100) / 100)
}

export function buildAdviceBasis(reading: MachineReading, recipe: DevRecipe): string {
  return `依据回传 ${reading.reportId}：活性 ${reading.activity.toFixed(2)}、实测 ${reading.tempC}°C / ${reading.minutes} 分钟，按配方基准 ${recipe.tempC}°C / ${recipe.devMinutes} 分钟由本机重算`
}

export function buildAdviceFromReading(
  reading: MachineReading,
  recipe: DevRecipe,
  now: string
): Omit<CorrectionAdvice, 'id'> {
  const suggestedMinutes = recalcSuggestedMinutes(
    recipe.devMinutes,
    recipe.tempC,
    reading.tempC,
    reading.activity
  )
  return {
    developerId: reading.developerId ?? 0,
    recipeId: recipe.id ?? 0,
    readingId: reading.id ?? 0,
    activity: reading.activity,
    measuredTempC: reading.tempC,
    baseTempC: recipe.tempC,
    baseMinutes: recipe.devMinutes,
    suggestedMinutes,
    basis: buildAdviceBasis(reading, recipe),
    status: 'pending',
    createdAt: now,
    schemaRev: 3
  }
}

export function baselineMatches(
  recipe: Pick<DevRecipe, 'tempC' | 'devMinutes'>,
  machineTempC: number,
  machineMinutes: number
): boolean {
  return Math.abs(recipe.tempC - machineTempC) <= 0.05
    && Math.abs(recipe.devMinutes - machineMinutes) <= 0.01
}
