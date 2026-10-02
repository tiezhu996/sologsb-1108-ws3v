export type TankType = '双联罐' | '深罐'
export type ReadingSource = 'machine' | 'manual'

export interface DevRun {
  id?: number
  batchNo: string
  recipeId: number
  actualTempC: number
  actualMinutes: number
  tankType: TankType
  runDate: string
  result: string
  readingSource?: ReadingSource
  readingId?: number
  schemaRev?: number
}
