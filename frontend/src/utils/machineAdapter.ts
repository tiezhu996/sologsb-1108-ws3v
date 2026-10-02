import type { MachineCallbackPayload, MachineRecipeBaseline } from '../types/machine-reading'

/**
 * 暗房冲洗机（外部系统）回传适配层。
 * 职责边界：只接收活性、温度、时长三类事实；
 * 任何"建议/补偿"字段一律丢弃，配方建议由本机重算。
 */

export class InvalidCallbackError extends Error {}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function normalizeBaseline(value: unknown): MachineRecipeBaseline | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'object') throw new InvalidCallbackError('recipeBaseline 必须是对象')
  const raw = value as Record<string, unknown>
  if (!isNonEmptyString(raw.recipeCode)) throw new InvalidCallbackError('配方基准缺少 recipeCode')
  if (!isFiniteNumber(raw.tempC)) throw new InvalidCallbackError('配方基准温度非法')
  if (!isFiniteNumber(raw.devMinutes)) throw new InvalidCallbackError('配方基准时长非法')
  return {
    recipeCode: raw.recipeCode.trim(),
    tempC: raw.tempC,
    devMinutes: raw.devMinutes
  }
}

/**
 * 校验并规整一条回传报文。
 * 显式按白名单取字段，外部多带的"建议类"字段不会进入本机。
 */
export function normalizeCallback(raw: unknown): MachineCallbackPayload {
  if (typeof raw !== 'object' || raw === null) {
    throw new InvalidCallbackError('回传报文必须是 JSON 对象')
  }
  const source = raw as Record<string, unknown>
  if (!isNonEmptyString(source.callbackId)) throw new InvalidCallbackError('缺少 callbackId')
  if (!isNonEmptyString(source.solutionBatchNo)) throw new InvalidCallbackError('缺少工作液批号')
  if (!isNonEmptyString(source.runBatchNo)) throw new InvalidCallbackError('缺少实冲批次号')
  if (!isFiniteNumber(source.activity)) throw new InvalidCallbackError('活性读数非法')
  if (source.activity <= 0 || source.activity > 1.5) throw new InvalidCallbackError('活性读数超出合理区间 (0, 1.5]')
  if (!isFiniteNumber(source.tempC)) throw new InvalidCallbackError('温度读数非法')
  if (source.tempC < 0 || source.tempC > 60) throw new InvalidCallbackError('温度读数超出合理区间 [0, 60]')
  if (!isFiniteNumber(source.minutes)) throw new InvalidCallbackError('时长读数非法')
  if (source.minutes <= 0 || source.minutes > 600) throw new InvalidCallbackError('时长读数超出合理区间 (0, 600]')
  if (!isNonEmptyString(source.measuredAt)) throw new InvalidCallbackError('缺少测量时间')

  return {
    callbackId: source.callbackId.trim(),
    solutionBatchNo: source.solutionBatchNo.trim(),
    runBatchNo: source.runBatchNo.trim(),
    activity: source.activity,
    tempC: source.tempC,
    minutes: source.minutes,
    measuredAt: source.measuredAt.trim(),
    recipeBaseline: normalizeBaseline(source.recipeBaseline)
  }
}

/** 解析批量投递（冲洗机可能一次回传多条），逐条规整 */
export function normalizeCallbackBatch(raw: unknown): MachineCallbackPayload[] {
  return extractRawItems(raw).map((item) => normalizeCallback(item))
}

/** 取出批量中的原始条目，不做字段校验（供幂等前置判断使用） */
export function extractRawItems(raw: unknown): unknown[] {
  if (typeof raw !== 'object' || raw === null) {
    throw new InvalidCallbackError('回传报文必须是 JSON 对象')
  }
  const source = raw as Record<string, unknown>
  return Array.isArray(source.readings) ? source.readings : [source]
}

/** 在不做完整校验的前提下读取 callbackId；非法报文返回 null */
export function peekCallbackId(raw: unknown): string | null {
  if (typeof raw !== 'object' || raw === null) return null
  const value = (raw as Record<string, unknown>).callbackId
  return typeof value === 'string' && value.trim() ? value.trim() : null
}
