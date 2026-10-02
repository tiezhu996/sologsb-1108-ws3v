export type AdviceStatus = 'pending' | 'applied' | 'invalidated'

export interface CorrectionAdvice {
  id?: number
  developerId: number
  recipeId: number
  readingId: number
  activity: number
  measuredTempC: number
  baseTempC: number
  baseMinutes: number
  suggestedMinutes: number
  basis: string
  status: AdviceStatus
  createdAt: string
  closedAt?: string
  schemaRev?: number
}
