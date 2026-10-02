export type ConflictStatus = 'pending' | 'resolved-local' | 'resolved-machine'

export interface BaselineConflict {
  id?: number
  developerId: number
  recipeId: number
  readingId: number
  localTempC: number
  localMinutes: number
  machineTempC: number
  machineMinutes: number
  status: ConflictStatus
  createdAt: string
  resolvedAt?: string
  schemaRev?: number
}
