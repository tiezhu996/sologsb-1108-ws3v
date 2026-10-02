export type ReconStatus = 'matched' | 'developer-missing' | 'run-missing'

export interface MachineReading {
  id?: number
  reportId: string
  developerBatchNo: string
  runBatchNo: string
  activity: number
  tempC: number
  minutes: number
  machineBaselineTempC: number
  machineBaselineMinutes: number
  reconStatus: ReconStatus
  developerId?: number
  runId?: number
  receivedAt: string
  schemaRev?: number
}

export interface MachineReportPayload {
  reportId: string
  developerBatchNo: string
  runBatchNo: string
  activity: number
  tempC: number
  minutes: number
  machineBaselineTempC: number
  machineBaselineMinutes: number
}
