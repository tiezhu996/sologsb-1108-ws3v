/**
 * 端到端规则验证（不经过浏览器）：
 *   npx tsx scripts/verify-ingest.ts
 * 覆盖：旧记录手工校验、对账、活性更新失效重算、已采纳依据冻结、
 *       基准冲突冻结与人工选定、重试幂等、晚到读数补对账、报文拒收。
 */
import 'fake-indexeddb/auto'
import { db } from '../src/utils/db'
import { ingestCallbacks, reconcilePendingReadings, resolveBaselineConflict } from '../src/utils/machineIngest'
import { InvalidCallbackError } from '../src/utils/machineAdapter'
import { useRunStore } from '../src/stores/runStore'
import { setActivePinia, createPinia } from 'pinia'

let passed = 0
let failed = 0

function check(name: string, condition: boolean, detail = ''): void {
  if (condition) {
    passed += 1
    console.log(`  ✓ ${name}`)
  } else {
    failed += 1
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

async function resetDb(): Promise<void> {
  await db.delete()
  await db.open()
  setActivePinia(createPinia())
}

async function main(): Promise<void> {
  // 1. 旧记录：手工校验、不补造数值、工作液批号回填
  await resetDb()
  const legacyRun = await db.runs.get(1)!
  check('旧实冲记录标为手工校验', legacyRun.verifiedBy === 'manual')
  check('旧记录不补造读数', legacyRun.readingId === null && legacyRun.basisSnapshot === null)
  check('旧记录回填工作液', legacyRun.developerId === 1)
  const legacyDev = await db.developers.get(1)!
  check('种子工作液带批号', /^WB-\d{6}-01$/.test(legacyDev.batchNo), legacyDev.batchNo)
  check('旧工作液活性为空（不补造）', legacyDev.lastActivity === null)

  // 2. 正常回传对账 + 活性更新 + 本机重算建议
  const matched = await ingestCallbacks({
    callbackId: 'CB-1',
    solutionBatchNo: 'WB-260912-01',
    runBatchNo: 'R-260918-01',
    activity: 0.92,
    tempC: 20.1,
    minutes: 9.6,
    measuredAt: '2026-10-02T09:00:00+08:00',
    recipeBaseline: { recipeCode: 'REC-1', tempC: 20, devMinutes: 9.5 }
  })
  check('首投接收 1 条且对账成功', matched.accepted === 1 && matched.items[0].reconcileState === 'matched')
  const reading1 = await db.readings.where('callbackId').equals('CB-1').first()!
  check('读数落库只有 1 条', (await db.readings.count()) === 1)
  check('读数推动活性更新', reading1.activityApplied === true)
  const dev1 = await db.developers.get(1)!
  check('工作液活性更新为事实值', dev1.lastActivity === 0.92)
  const run1 = await db.runs.get(1)!
  check('已存在实冲记录标记仪器校验', run1.verifiedBy === 'instrument' && run1.readingId === reading1.id)
  check('已完成实冲记录的数值不被改写', run1.actualTempC === 20.2 && run1.actualMinutes === 9.4)
  check('已完成实冲记录当时无依据快照（照旧）', run1.basisSnapshot === null)
  const pendingForRecipe1 = await db.corrections
    .where('developerId').equals(1).and((c) => c.status === 'pending' && c.recipeId === 1).first()!
  check('本机按配方+活性重算建议（9.5/0.92≈10.33）', pendingForRecipe1.suggestedMinutes === 10.33,
    `got ${pendingForRecipe1.suggestedMinutes}`)
  check('活性系数为本机计算（非机器回传）', pendingForRecipe1.activityFactor === 1.087)

  // 3. 同一报文重试：幂等，不多出读数，不再更新活性
  const retry = await ingestCallbacks({
    callbackId: 'CB-1',
    solutionBatchNo: 'WB-260912-01',
    runBatchNo: 'R-260918-01',
    activity: 0.5,
    tempC: 99,
    minutes: 99,
    measuredAt: '2026-10-02T09:00:00+08:00'
  })
  check('重试判为重复', retry.duplicated === 1 && retry.accepted === 0)
  check('重试后读数仍只有 1 条', (await db.readings.count()) === 1)
  const reading1Retry = await db.readings.where('callbackId').equals('CB-1').first()!
  check('投递次数累加到 2', reading1Retry.deliveryCount === 2)
  check('重试未改写事实与活性', reading1Retry.activity === 0.92 && (await db.developers.get(1))!.lastActivity === 0.92)

  // 4. 活性再更新（同批工作液、更晚测量时间）：未采纳建议立即失效并重算
  const pendingCountBefore = await db.corrections
    .where('developerId').equals(1).and((c) => c.status === 'pending').count()
  check('首批活性为本机配方 1/5/6 各生成一条 pending', pendingCountBefore === 3)

  await ingestCallbacks({
    callbackId: 'CB-2',
    solutionBatchNo: 'WB-260912-01',
    runBatchNo: 'R-260923-05',
    activity: 0.8,
    tempC: 24.0,
    minutes: 8.1,
    measuredAt: '2026-10-03T10:00:00+08:00',
    recipeBaseline: { recipeCode: 'REC-5', tempC: 24, devMinutes: 6.5 }
  })
  const reading2 = await db.readings.where('callbackId').equals('CB-2').first()!
  check('更晚测量时间的读数推动活性更新', reading2.activityApplied === true)
  const voided = await db.corrections
    .where('developerId').equals(1).and((c) => c.status === 'void').toArray()
  check('旧 pending 建议全部失效', voided.length === 3)
  check('失效建议保留淘汰读数溯源', voided.every((c) => c.voidedByReadingId === reading2.id))
  const regen = await db.corrections
    .where('developerId').equals(1).and((c) => c.status === 'pending').toArray()
  check('按新活性重算 pending（配方1：9.5/0.8=11.88）',
    regen.find((c) => c.recipeId === 1)?.suggestedMinutes === 11.88)
  check('依据快照指向新读数', regen.every((c) => c.basis.readingId === reading2.id))

  // 更早测量时间的迟到读数：只留事实，不回退活性、不失效建议
  await ingestCallbacks({
    callbackId: 'CB-2B',
    solutionBatchNo: 'WB-260912-01',
    runBatchNo: 'R-260924-06',
    activity: 0.5,
    tempC: 20,
    minutes: 15.5,
    measuredAt: '2026-09-30T11:00:00+08:00'
  })
  const reading2b = await db.readings.where('callbackId').equals('CB-2B').first()!
  check('迟到的旧读数不推动活性更新', reading2b.activityApplied === false)
  check('当前活性不被旧读数回退', (await db.developers.get(1))!.lastActivity === 0.8)
  check('旧读数到达不产生新的失效/重算',
    (await db.corrections.where('developerId').equals(1).and((c) => c.status === 'pending').count()) === 3)

  // 5. 新一批工作液：回传基准与本机配方不一致 → 两版并列，整批冻结
  const conflictResult = await ingestCallbacks({
    callbackId: 'CB-4',
    solutionBatchNo: 'WB-260916-02',
    runBatchNo: 'R-260920-02',
    activity: 0.88,
    tempC: 20.4,
    minutes: 7.9,
    measuredAt: '2026-10-03T12:00:00+08:00',
    recipeBaseline: { recipeCode: 'REC-2', tempC: 20, devMinutes: 8.0 }
  })
  check('基准不一致被识别', conflictResult.items[0].conflictCreated === true)
  const conflict = await db.baselineConflicts.where('status').equals('pending').first()!
  check('两版基准并列保留', conflict.machineBaseline.devMinutes === 8.0 && conflict.localBaseline.devMinutes === 7.5)
  const dev2Pending = await db.corrections
    .where('developerId').equals(2).and((c) => c.status === 'pending').count()
  check('选定前整批工作液不参与新建议（0 条 pending）', dev2Pending === 0)
  check('活性事实仍已更新（事实留档与建议冻结互不影响）',
    (await db.developers.get(2))!.lastActivity === 0.88)

  // 同批另一条配方的更晚读数也不应在冻结期间生成建议
  await ingestCallbacks({
    callbackId: 'CB-4B',
    solutionBatchNo: 'WB-260916-02',
    runBatchNo: 'R-260920-02',
    activity: 0.85,
    tempC: 20.4,
    minutes: 8.2,
    measuredAt: '2026-10-03T12:30:00+08:00'
  })
  check('冻结期间更新的活性事实照常入库但仍不产生建议',
    (await db.corrections.where('developerId').equals(2).and((c) => c.status === 'pending').count()) === 0
    && (await db.developers.get(2))!.lastActivity === 0.85)

  // 6. 人工选定本机版：解冻并按本机基准重算
  await resolveBaselineConflict(conflict.id!, 'local')
  const conflictAfter = await db.baselineConflicts.get(conflict.id!)!
  check('冲突标记为 resolved 并冻结选择', conflictAfter.status === 'resolved' && conflictAfter.chosenSide === 'local')
  const dev2PendingAfter = await db.corrections
    .where('developerId').equals(2).and((c) => c.status === 'pending').toArray()
  check('选定后按本机基准与最新活性重算建议', dev2PendingAfter.length >= 1)
  const recipe2Correction = dev2PendingAfter.find((c) => c.recipeId === 2)!
  check('重算采用本机基准 7.5、活性 0.85（7.5/0.85≈8.82）', recipe2Correction.suggestedMinutes === 8.82,
    `got ${recipe2Correction.suggestedMinutes}`)
  check('依据快照标记为人工选定', recipe2Correction.basis.conflictResolved === true)

  // 7. 采纳 pending 建议 → applied 冻结；之后活性更新不改变已采纳建议与实冲依据
  const runStore = useRunStore()
  const newRunId = await runStore.addRun({
    batchNo: 'R-261002-09',
    recipeId: 2,
    developerId: 2,
    actualTempC: 20,
    actualMinutes: recipe2Correction.suggestedMinutes,
    tankType: '双联罐',
    runDate: '2026-10-03',
    result: '活性修正后密度正常',
    applyCorrectionId: recipe2Correction.id!
  })
  const appliedCorrection = await db.corrections.get(recipe2Correction.id!)!
  check('采纳后建议状态为 applied', appliedCorrection.status === 'applied' && appliedCorrection.appliedRunId === newRunId)
  const appliedRun = await db.runs.get(newRunId)!
  check('实冲冻结当时判定依据', appliedRun.basisSnapshot?.basisKey === recipe2Correction.basis.basisKey
    && appliedRun.verifiedBy === 'instrument')

  await ingestCallbacks({
    callbackId: 'CB-5',
    solutionBatchNo: 'WB-260916-02',
    runBatchNo: 'R-261002-09',
    activity: 0.7,
    tempC: 20.1,
    minutes: 8.6,
    measuredAt: '2026-10-04T13:00:00+08:00'
  })
  const appliedStill = await db.corrections.get(recipe2Correction.id!)!
  check('活性更新后已采纳建议照旧（仍 applied、依据不变）',
    appliedStill.status === 'applied' && appliedStill.basis.basisKey === recipe2Correction.basis.basisKey)
  const appliedRunUntouched = await db.runs.get(newRunId)!
  check('已完成实冲记录的判定依据照旧',
    appliedRunUntouched.basisSnapshot?.readingId === recipe2Correction.basis.readingId)
  check('未完成的其它建议已按新活性重算（dev2 存在新的 pending）',
    (await db.corrections.where('developerId').equals(2)
      .and((c) => c.status === 'pending' && c.basis.activity === 0.7).count()) >= 1)

  // 8. 新一批工作液 WB-260920-04（C-41）首次读数 → 建议生成
  await ingestCallbacks({
    callbackId: 'CB-6',
    solutionBatchNo: 'WB-260920-04',
    runBatchNo: 'R-260921-03',
    activity: 0.95,
    tempC: 38.1,
    minutes: 3.4,
    measuredAt: '2026-10-03T14:00:00+08:00',
    recipeBaseline: { recipeCode: 'REC-3', tempC: 38, devMinutes: 3.25 }
  })
  const firstDev4 = await db.corrections
    .where('developerId').equals(4).and((c) => c.status === 'pending').first()!
  check('新批工作液生成 pending 建议（3.25/0.95≈3.42）', firstDev4.suggestedMinutes === 3.42)

  // 9. 早到读数：先无本地批号与实冲 → unmatched；补录后自动重新对账 → 活性生效 + 建议生成
  await ingestCallbacks({
    callbackId: 'CB-8',
    solutionBatchNo: 'WB-261002-99',
    runBatchNo: 'R-261002-99',
    activity: 0.85,
    tempC: 20,
    minutes: 10,
    measuredAt: '2026-10-03T15:00:00+08:00'
  })
  const unmatchedReading = await db.readings.where('callbackId').equals('CB-8').first()!
  check('台账缺失时读数标为 unmatched', unmatchedReading.reconcileState === 'unmatched')
  check('unmatched 读数不更新任何活性', unmatchedReading.activityApplied === false)

  const newDevId = await db.developers.add({
    name: 'D-76 应急工作液', category: 'D-76', dilution: '1:1', volumeMl: 1000,
    mixedAt: '2026-10-03', maxRolls: 8, usedRolls: 0, state: '在用',
    batchNo: 'WB-261002-99', lastActivity: null, lastActivityAt: null, schemaRev: 3
  })
  await db.recipes.add({
    filmId: 1, developerId: newDevId, dilution: '1:1', tempC: 20, devMinutes: 10,
    agitation: '标准', stopBath: '停显', fixer: '定影', washMinutes: 10, pushPull: 'N',
    note: '', schemaRev: 3
  })
  const runStore2 = useRunStore()
  await runStore2.addRun({
    batchNo: 'R-261002-99',
    recipeId: 8,
    developerId: newDevId,
    actualTempC: 20,
    actualMinutes: 10,
    tankType: '双联罐',
    runDate: '2026-10-03',
    result: '应急批次手工录入'
  })
  const matchedReading = await db.readings.where('callbackId').equals('CB-8').first()!
  check('补录实冲后自动重新对账成功', matchedReading.reconcileState === 'matched')
  check('补对账后活性生效', matchedReading.activityApplied === true)
  const newDev = await db.developers.get(newDevId)!
  check('工作液活性在补对账后更新', newDev.lastActivity === 0.85)
  const newDevCorrection = await db.corrections
    .where('developerId').equals(newDevId).and((c) => c.status === 'pending').first()
  check('补对账后生成本机建议（10/0.85≈11.76）', newDevCorrection?.suggestedMinutes === 11.76)
  const lateRun = await db.runs.where('batchNo').equals('R-261002-99').first()!
  check('手工录入的实冲在读数对上账后标为仪器校验', lateRun.verifiedBy === 'instrument' && lateRun.readingId === matchedReading.id)
  check('手工录入时的实冲数值原样保留（不补造）', lateRun.actualTempC === 20 && lateRun.actualMinutes === 10)
  check('手工录入时无依据快照（当时确无建议）', lateRun.basisSnapshot === null)

  // 10. batch-mismatch：实冲批次本地属于另一工作液
  await ingestCallbacks({
    callbackId: 'CB-9',
    solutionBatchNo: 'WB-260916-02',
    runBatchNo: 'R-260918-01',
    activity: 0.7,
    tempC: 20,
    minutes: 9,
    measuredAt: '2026-10-04T16:00:00+08:00'
  })
  const mismatch = await db.readings.where('callbackId').equals('CB-9').first()!
  check('批号冲突标为 batch-mismatch', mismatch.reconcileState === 'batch-mismatch')
  check('冲突读数不推动活性', mismatch.activityApplied === false)

  // 11. 报文拒收与字段白名单
  let rejected = false
  try {
    await ingestCallbacks({
      callbackId: 'CB-X', solutionBatchNo: 'B', runBatchNo: 'R',
      activity: 5, tempC: 20, minutes: 9, measuredAt: 't'
    })
  } catch (error) {
    rejected = error instanceof InvalidCallbackError
  }
  check('超出合理区间的报文被拒收', rejected)

  const stripped = await ingestCallbacks({
    callbackId: 'CB-10',
    solutionBatchNo: 'WB-260912-01',
    runBatchNo: 'R-260922-04',
    activity: 0.99,
    tempC: 20,
    minutes: 11,
    measuredAt: '2026-10-04T17:00:00+08:00',
    // @ts-expect-error 外部系统若夹带建议字段，适配层必须丢弃
    suggestedMinutes: 1,
    machineAdvice: 'ignore me'
  })
  check('夹带建议字段不影响接收（白名单取字段）', stripped.accepted === 1)
  const stored10 = await db.readings.where('callbackId').equals('CB-10').first()!
  check('落库读数不含任何建议字段',
    !('suggestedMinutes' in stored10) && !('machineAdvice' in stored10))

  // 12. 批量投递 + 批次内重复 callbackId
  const batch = await ingestCallbacks({
    readings: [
      { callbackId: 'B-1', solutionBatchNo: 'WB-260912-01', runBatchNo: 'R-260918-01', activity: 0.9, tempC: 20, minutes: 9, measuredAt: '2026-10-04T18:00:00+08:00' },
      { callbackId: 'CB-1', solutionBatchNo: 'WB-260912-01', runBatchNo: 'R-260918-01', activity: 0.9, tempC: 20, minutes: 9, measuredAt: '2026-10-04T18:00:00+08:00' }
    ]
  })
  check('批量投递中重复 callbackId 不产生第二条读数', batch.accepted === 1 && batch.duplicated === 1)

  const changed = await reconcilePendingReadings()
  check('无待对账读数时重新对账为 0', changed === 0)

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
  await db.close()
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
