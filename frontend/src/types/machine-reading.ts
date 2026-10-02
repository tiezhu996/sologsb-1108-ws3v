/**
 * 暗房冲洗机（外部系统）回传的控制条读数。
 * 机器只提供三类事实：活性、温度、时长；不提供任何配方建议。
 */

/** 回传中附带的配方基准（仅作对照用，不直接写入本机配方） */
export interface MachineRecipeBaseline {
  recipeCode: string
  tempC: number
  devMinutes: number
}

/** 外部系统 POST 过来的原始报文结构 */
export interface MachineCallbackPayload {
  /** 外部系统的回调报文 ID，用于重试幂等：同一 ID 重复投递不得多出读数 */
  callbackId: string
  /** 工作液批号（机器侧） */
  solutionBatchNo: string
  /** 实冲批次号；控制条读数可能先于或晚于本机实冲记录到达 */
  runBatchNo: string
  /** 控制条活性，1 为标称活性，衰减时小于 1 */
  activity: number
  /** 实测温度 °C（事实） */
  tempC: number
  /** 实测时长 分钟（事实） */
  minutes: number
  measuredAt: string
  /** 机器记录的配方基准；缺失表示该批未绑定配方基准 */
  recipeBaseline?: MachineRecipeBaseline
}

/** 读数与本地台账的对账结果 */
export type ReadingReconcileState =
  | 'matched'        // 工作液批号与实冲批次均对上
  | 'unmatched'      // 工作液批号或实冲批次在本地台账中不存在
  | 'batch-mismatch' // 实冲批次对应的本地工作液批号与回传不一致

/** 落库后的读数（对账字段由本机补写，外部系统不提供） */
export interface MachineReading extends MachineCallbackPayload {
  id?: number
  /** 对账命中的本地工作液（显影液）ID */
  developerId?: number
  /** 对账命中的本地实冲记录 ID */
  runId?: number
  reconcileState: ReadingReconcileState
  /** 该读数是否推动了活性更新（仅每个工作液批号第一条有效读数为 true） */
  activityApplied: boolean
  receivedAt: string
  /** 同一报文重试时记录次数，首投为 1；重试不新增读数 */
  deliveryCount: number
  schemaRev?: number
}
