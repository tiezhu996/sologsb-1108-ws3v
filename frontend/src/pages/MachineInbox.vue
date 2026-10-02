<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { ElMessage } from 'element-plus'
import StatBadge from '../components/common/StatBadge.vue'
import { useMachineStore } from '../stores/machineStore'
import { useDeveloperStore } from '../stores/developerStore'
import { useRecipeStore } from '../stores/recipeStore'
import { useFilmStore } from '../stores/filmStore'
import { InvalidCallbackError } from '../utils/machineAdapter'
import type { IngestResult } from '../utils/machineIngest'
import type { MachineReading } from '../types/machine-reading'

const machineStore = useMachineStore()
const developerStore = useDeveloperStore()
const recipeStore = useRecipeStore()
const filmStore = useFilmStore()

const rawText = ref('')
const importing = ref(false)
const justResult = ref<IngestResult | null>(null)

const samplePayload = `{
  "readings": [
    {
      "callbackId": "CB-261002-01",
      "solutionBatchNo": "WB-260912-01",
      "runBatchNo": "R-260918-01",
      "activity": 0.92,
      "tempC": 20.1,
      "minutes": 9.6,
      "measuredAt": "2026-10-02T09:12:00+08:00",
      "recipeBaseline": { "recipeCode": "REC-1", "tempC": 20, "devMinutes": 9.5 }
    },
    {
      "callbackId": "CB-261002-02",
      "solutionBatchNo": "WB-260916-02",
      "runBatchNo": "R-260920-02",
      "activity": 0.88,
      "tempC": 20.4,
      "minutes": 7.9,
      "measuredAt": "2026-10-02T09:20:00+08:00",
      "recipeBaseline": { "recipeCode": "REC-2", "tempC": 20, "devMinutes": 8.0 }
    }
  ]
}`

const blockedSet = computed(() => new Set(machineStore.blockedBatchNos))

function developerName(id?: number): string {
  if (id === undefined) return '未对上工作液'
  return developerStore.developers.find((item) => item.id === id)?.name ?? '未知工作液'
}

function recipeLabel(recipeId: number): string {
  const recipe = recipeStore.recipes.find((item) => item.id === recipeId)
  if (!recipe) return `配方 #${recipeId}`
  const film = filmStore.films.find((item) => item.id === recipe.filmId)
  return `${film?.model ?? '未知胶片'} · ${recipe.tempC}°C / ${recipe.devMinutes} 分钟`
}

function stateMeta(state: MachineReading['reconcileState']): { label: string; tone: string } {
  if (state === 'matched') return { label: '已对账', tone: 'cyan' }
  if (state === 'batch-mismatch') return { label: '批号冲突', tone: 'rose' }
  return { label: '未对上账', tone: 'amber' }
}

function stateHint(reading: MachineReading): string {
  if (reading.reconcileState === 'matched') return '工作液批号与实冲批次均与本地台账一致'
  if (reading.reconcileState === 'batch-mismatch') {
    return `实冲批次 ${reading.runBatchNo} 本地登记的工作液与回传批号 ${reading.solutionBatchNo} 不一致`
  }
  const hasDeveloper = developerStore.developers.some((item) => item.batchNo === reading.solutionBatchNo)
  return hasDeveloper
    ? `本地无实冲批次 ${reading.runBatchNo}；录入实冲后会自动重新对账`
    : `本地无工作液批号 ${reading.solutionBatchNo}；补录工作液/实冲后点"重新对账"`
}

async function submitImport(): Promise<void> {
  const text = rawText.value.trim()
  if (!text) {
    ElMessage.warning('请粘贴冲洗机回传的 JSON 报文')
    return
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    ElMessage.error('报文不是合法 JSON，请检查后重试')
    return
  }
  importing.value = true
  try {
    const result = await machineStore.ingest(parsed)
    justResult.value = result
    if (result.duplicated > 0 && result.accepted === 0) {
      ElMessage.warning(`报文为重复投递（${result.duplicated} 条），未新增任何读数`)
    } else {
      ElMessage.success(`已接收 ${result.accepted} 条读数${result.duplicated ? `，重复投递 ${result.duplicated} 条已忽略` : ''}`)
    }
    await developerStore.load()
    rawText.value = ''
  } catch (error) {
    if (error instanceof InvalidCallbackError) {
      ElMessage.error(`回传报文被拒收：${error.message}`)
    } else {
      ElMessage.error('回传处理失败，请检查报文格式')
    }
  } finally {
    importing.value = false
  }
}

function loadSample(): void {
  rawText.value = samplePayload
}

async function rerunReconcile(): Promise<void> {
  const changed = await machineStore.reconcilePending()
  await Promise.all([developerStore.load(), recipeStore.load(), filmStore.load()])
  ElMessage[changed > 0 ? 'success' : 'info'](changed > 0 ? `有 ${changed} 条读数完成对账` : '没有可补对账的读数')
}

async function chooseBaseline(conflictId: number, side: 'machine' | 'local'): Promise<void> {
  await machineStore.resolveConflict(conflictId, side)
  ElMessage.success(side === 'machine' ? '已采用机器回传基准并立即重算建议' : '已沿用本机配方基准并立即重算建议')
}

onMounted(async () => {
  await Promise.all([
    machineStore.load(),
    developerStore.load(),
    recipeStore.load(),
    filmStore.load()
  ])
})
</script>

<template>
  <section class="page-shell">
    <header class="page-hero page-hero--compact">
      <div>
        <span class="eyebrow">PROCESSOR INBOX</span>
        <h1>冲洗机回传对账</h1>
        <p>外部冲洗机只回传活性、温度、时长三类事实，按工作液批号与实冲批次同本地台账核对；配方建议一律由本机重算。</p>
      </div>
      <button type="button" class="ghost-button" data-testid="rerun-reconcile" @click="rerunReconcile">
        重新对账
      </button>
    </header>

    <div class="stat-strip">
      <StatBadge label="读数总数" :value="machineStore.readings.length" hint="同一回调重复投递不新增" tone="cyan" />
      <StatBadge label="待对上账" :value="machineStore.unmatchedReadings.length" hint="批号或实冲批次缺失/冲突" tone="amber" />
      <StatBadge label="待选定基准" :value="machineStore.pendingConflicts.length" hint="选定前该批工作液不出新建议" tone="rose" />
      <StatBadge label="生效中建议" :value="machineStore.pendingCorrections.length" hint="本机按配方+活性重算" />
    </div>

    <form class="inline-form" data-testid="form-callback" @submit.prevent="submitImport">
      <div class="inline-form__head">
        <div>
          <h2>接收回传报文</h2>
          <p>粘贴冲洗机推送的 JSON（单条或 {"readings": [...]} 批量）。机器若夹带建议字段会被直接丢弃。</p>
        </div>
        <button type="button" class="ghost-button" @click="loadSample">载入示例报文</button>
      </div>
      <textarea
        v-model="rawText"
        class="callback-input"
        data-testid="field-callback-json"
        rows="8"
        placeholder='{"callbackId":"CB-...","solutionBatchNo":"WB-...","runBatchNo":"R-...","activity":0.92,"tempC":20.1,"minutes":9.6,"measuredAt":"...","recipeBaseline":{...}}'
      ></textarea>
      <div class="form-actions">
        <button type="submit" class="primary-button" data-testid="submit-callback" :disabled="importing">
          {{ importing ? '对账中…' : '接收并对账' }}
        </button>
      </div>
      <p v-if="justResult" class="ingest-summary" data-testid="ingest-summary">
        新接收 {{ justResult.accepted }} 条 · 重复投递 {{ justResult.duplicated }} 条
      </p>
    </form>

    <div v-if="machineStore.pendingConflicts.length" class="panel conflict-panel">
      <div class="panel__head">
        <div>
          <h2>配方基准两版并列 · 待人工选定</h2>
          <p>回传中的配方基准与本机配方不一致。选定前，对应工作液批号不参与任何新建议。</p>
        </div>
      </div>
      <article v-for="conflict in machineStore.pendingConflicts" :key="conflict.id" class="conflict-card" data-testid="row-conflict">
        <header>
          <strong>{{ conflict.solutionBatchNo }}</strong>
          <span>实冲 {{ conflict.runBatchNo }}</span>
          <span>{{ recipeLabel(conflict.recipeId) }}</span>
        </header>
        <div class="conflict-sides">
          <div class="conflict-side conflict-side--machine">
            <h3>机器回传基准</h3>
            <p>{{ conflict.machineBaseline.tempC }}°C / {{ conflict.machineBaseline.devMinutes }} 分钟</p>
            <small>来自读数报文，仅作事实对照</small>
          </div>
          <div class="conflict-side conflict-side--local">
            <h3>本机当前配方</h3>
            <p>{{ conflict.localBaseline.tempC }}°C / {{ conflict.localBaseline.devMinutes }} 分钟</p>
            <small>本机改过，配方主权仍在本机</small>
          </div>
        </div>
        <div class="conflict-actions">
          <button type="button" class="ghost-button" data-testid="choose-machine" @click="chooseBaseline(conflict.id!, 'machine')">采用机器版并重算</button>
          <button type="button" class="primary-button" data-testid="choose-local" @click="chooseBaseline(conflict.id!, 'local')">沿用本机版并重算</button>
        </div>
      </article>
    </div>

    <div class="panel">
      <div class="panel__head">
        <div>
          <h2>读数台账</h2>
          <p>仅存仪器事实；旧手工记录不会补造数值。</p>
        </div>
      </div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>回调 ID</th>
              <th>工作液批号</th>
              <th>实冲批次</th>
              <th>活性</th>
              <th>温度</th>
              <th>时长</th>
              <th>对账状态</th>
              <th>投递</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="reading in machineStore.readings" :key="reading.id" data-testid="row-reading">
              <td><small>{{ reading.callbackId }}</small></td>
              <td>
                <strong>{{ reading.solutionBatchNo }}</strong>
                <small>{{ developerName(reading.developerId) }}</small>
              </td>
              <td>{{ reading.runBatchNo }}</td>
              <td>{{ Math.round(reading.activity * 100) }}%</td>
              <td>{{ reading.tempC }}°C</td>
              <td>{{ reading.minutes }} 分钟</td>
              <td>
                <span class="status-chip" :class="`status--${stateMeta(reading.reconcileState).tone}`">
                  {{ stateMeta(reading.reconcileState).label }}
                </span>
                <small class="state-hint">{{ stateHint(reading) }}</small>
                <em v-if="blockedSet.has(reading.solutionBatchNo)" class="block-flag">该批工作液已冻结，待基准选定</em>
              </td>
              <td>
                ×{{ reading.deliveryCount }}
                <small v-if="reading.deliveryCount > 1">重试未新增读数</small>
              </td>
            </tr>
          </tbody>
        </table>
        <div v-if="machineStore.readings.length === 0" class="inline-empty">还没有收到任何冲洗机回传。</div>
      </div>
    </div>

    <div class="panel">
      <div class="panel__head">
        <div>
          <h2>本机修正建议</h2>
          <p>由本机按配方基准与工作液活性重算；活性更新后，未采纳的建议立即作废并由新建议接替。</p>
        </div>
      </div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>工作液批号</th>
              <th>配方</th>
              <th>活性 / 系数</th>
              <th>建议时长</th>
              <th>状态</th>
              <th>判定依据</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="correction in machineStore.corrections" :key="correction.id" data-testid="row-correction">
              <td>{{ correction.solutionBatchNo }}</td>
              <td>{{ recipeLabel(correction.recipeId) }}</td>
              <td>{{ Math.round(correction.basis.activity * 100) }}% · ×{{ correction.activityFactor }}</td>
              <td><strong class="accent-number">{{ correction.suggestedMinutes.toFixed(2) }} 分钟</strong></td>
              <td>
                <span
                  class="status-chip"
                  :class="{
                    'status--cyan': correction.status === 'pending',
                    'status--rose': correction.status === 'void',
                    'status--amber': correction.status === 'applied'
                  }"
                >
                  {{ correction.status === 'pending' ? '待采纳' : correction.status === 'void' ? '已失效' : '已采纳' }}
                </span>
                <small v-if="correction.status === 'void' && correction.voidedAt">
                  于 {{ correction.voidedAt.slice(0, 16).replace('T', ' ') }} 被新活性淘汰
                </small>
                <small v-if="correction.status === 'applied'">实冲记录 #{{ correction.appliedRunId }}</small>
              </td>
              <td>
                <small>
                  基准 {{ correction.basis.baselineTempC }}°C / {{ correction.basis.baselineMinutes }} 分钟
                  <template v-if="correction.basis.conflictResolved">（人工选定基准）</template>
                  · 读数 #{{ correction.basis.readingId }}
                </small>
              </td>
            </tr>
          </tbody>
        </table>
        <div v-if="machineStore.corrections.length === 0" class="inline-empty">
          尚未生成建议；当读数对上账并带来新的活性事实时，本机才会重算修正建议。
        </div>
      </div>
    </div>
  </section>
</template>
