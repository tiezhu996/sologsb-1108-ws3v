export type DeveloperCategory = 'D-76' | 'HC-110' | 'Rodinal' | 'C-41'
export type Dilution = '1:1' | '1:3'
export type DeveloperState = '新配' | '在用' | '报废'

export interface Developer {
  id?: number
  name: string
  category: DeveloperCategory
  dilution: Dilution
  volumeMl: number
  mixedAt: string
  maxRolls: number
  usedRolls: number
  state: DeveloperState
  /** 工作液批号，与冲洗机回传对账的业务键 */
  batchNo: string
  /** 最近一次控制条活性事实（无仪器读数时为空，不补造数值） */
  lastActivity?: number | null
  /** 最近一次活性更新时间 */
  lastActivityAt?: string | null
  schemaRev?: number
}
