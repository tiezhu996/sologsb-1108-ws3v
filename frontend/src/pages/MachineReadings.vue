<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { ElMessage } from 'element-plus'
import EmptyPanel from '../components/common/EmptyPanel.vue'
import StatBadge from '../components/common/StatBadge.vue'
import { useDeveloperStore } from '../stores/developerStore'
import { useFilmStore } from '../stores/filmStore'
import { useMachineStore, type IngestResult } from '../stores/machineStore'
import { useRecipeStore } from '../stores/recipeStore'
import type { ReconStatus } from '../types/machine-reading'
import type { AdviceStatus } from '../types/correction-advice'

interface ReportForm {
  reportId: string
  developerBatchNo: string
  runBatchNo: string
  activity: number
  tempC: number
  minutes: number
  machineBaselineTempC: number
  machineBaselineMinutes: number
}

const filmStore = useFilmStore()
const developerStore = useDeveloperStore()
const recipeStore = useRecipeStore()
const machineStore = useMachineStore()
const showForm = ref(false)
const saving = ref(false)

function nextReportId(): string {
  const stamp = new Date().toISOString().slice(2, 10).replace(/-/g, '')
  return `MX-${stamp}-${String(machineStore.readings.length + 1).padStart(2, '0')}`
}

const form = reactive<ReportForm>({
  reportId: nextReportId(),
  developerBatchNo: '',
  runBatchNo: '',
  activity: 1,
  tempC: 20,
  minutes: 10,
  machineBaselineTempC: 20,
  machineBaselineMinutes: 10
})

const matchedCount = computed(() => machineStore.readings.filter((reading) => reading.reconStatus === 'matched').length)

const sortedAdvices = computed(() => {
  const order: Record<AdviceStatus, number> = { pending: 0, applied: 1, invalidated: 2 }
  return [...machineStore.advices].sort((a, b) => {
    const byStatus = order[a.status] - order[b.status]
    return byStatus !== 0 ? byStatus : (b.id ?? 0) - (a.id ?? 0)
  })
})

const resolvedConflicts = computed(() => machineStore.conflicts.filter((conflict) => conflict.status !== 'pending'))

function developerName(id?: number): string {
  if (id === undefined) return '未匹配工作液'
  return developerStore.developers.find((item) => item.id === id)?.name ?? '未知显影液'
}

function recipeLabel(id: number): string {
  const recipe = recipeStore.recipes.find((item) => item.id === id)
  if (!recipe) return '未知配方'
  const film = filmStore.films.find((item) => item.id === recipe.filmId)
  return `${film?.model ?? '未知胶片'} · ${developerName(recipe.developerId)} · 配方 #${recipe.id}`
}

function reconLabel(status: ReconStatus): string {
  if (status === 'matched') return '已对账'
  if (status === 'developer-missing') return '工作液未匹配'
  return '批次未匹配'
}

function reconTone(status: ReconStatus): string {
  return status === 'matched' ? 'status--ok' : 'status--warning'
}

function adviceTone(status: AdviceStatus): string {
  if (status === 'pending') return 'status--amber'
  if (status === 'applied') return 'status--ok'
  return 'status--rose'
}

function adviceLabel(status: AdviceStatus): string {
  if (status === 'pending') return '待采纳'
  if (status === 'applied') return '已采纳'
  return '已失效'
}

function notifyResult(result: IngestResult): void {
  if (result.duplicated) {
    ElMessage.warning(`回传 ${result.reading.reportId} 已接收过，本次重试未重复入账`)
    return
  }
  if (result.reconStatus === 'developer-missing') {
    ElMessage.warning('工作液批号未在台账登记，读数已挂起，请先在显影液台账补登批号')
    return
  }
  if (result.reconStatus === 'run-missing') {
    ElMessage.warning('实冲批次未在台账登记，读数已挂起，请先补录冲洗记录')
    return
  }
  if (result.conflictPending) {
    ElMessage.warning('读数已对账；回传配方基准与本机不一致，两版已并列，人工选定前该工作液不参与新建议')
    return
  }
  if (result.suspended) {
    ElMessage.warning(`读数已对账；该工作液基准仍待选定，${result.invalidatedCount} 条未完成建议已失效，待选定后重算`)
    return
  }
  ElMessage.success(`读数已对账，已按最新活性重算 ${result.createdAdviceCount} 条修正建议（${result.invalidatedCount} 条旧建议失效）`)
}

async function submitReport(): Promise<void> {
  if (!form.reportId.trim() || !form.developerBatchNo.trim() || !form.runBatchNo.trim()) {
    ElMessage.warning('请填写回传单号、工作液批号与实冲批次')
    return
  }
  saving.value = true
  try {
    const result = await machineStore.ingestReport({
      reportId: form.reportId.trim(),
      developerBatchNo: form.developerBatchNo.trim(),
      runBatchNo: form.runBatchNo.trim(),
      activity: Number(form.activity),
      tempC: Number(form.tempC),
      minutes: Number(form.minutes),
      machineBaselineTempC: Number(form.machineBaselineTempC),
      machineBaselineMinutes: Number(form.machineBaselineMinutes)
    })
    notifyResult(result)
    if (!result.duplicated) {
      form.reportId = nextReportId()
      showForm.value = false
    }
  } finally {
    saving.value = false
  }
}

async function pickBaseline(conflictId: number | undefined, choice: 'local' | 'machine'): Promise<void> {
  if (conflictId === undefined) return
  await machineStore.resolveConflict(conflictId, choice)
  await recipeStore.load()
  ElMessage.success(choice === 'local' ? '已选定本机基准，该工作液恢复参与新建议' : '已选定冲洗机基准并更新配方，该工作液恢复参与新建议')
}

async function applyAdvice(adviceId: number | undefined): Promise<void> {
  if (adviceId === undefined) return
  await machineStore.applyAdvice(adviceId)
  ElMessage.success('修正建议已采纳，判定依据将随记录保留')
}

onMounted(async () => {
  await Promise.all([filmStore.load(), developerStore.load(), recipeStore.load(), machineStore.load()])
})
</script>

<template>
  <section class="page-shell">
    <header class="page-hero page-hero--compact">
      <div>
        <span class="eyebrow">MACHINE UPLINK</span>
        <h1>冲洗机回传对账</h1>
        <p>冲洗机只回传活性、温度与时长事实，按工作液批号与实冲批次对账；配方建议仍由本机按配方和工作液重算。</p>
      </div>
      <button type="button" class="primary-button" data-testid="new-reading" @click="showForm = !showForm">
        {{ showForm ? '收起表单' : '接收回传' }}
      </button>
    </header>

    <form v-if="showForm" class="inline-form" data-testid="form-reading" @submit.prevent="submitReport">
      <div class="inline-form__head">
        <div>
          <h2>接收冲洗机回传</h2>
          <p>同一回传单号重复提交不会重复入账；回传仅登记事实读数，建议由本机重算。</p>
        </div>
      </div>
      <div class="form-grid form-grid--four">
        <label>
          <span>回传单号</span>
          <input v-model="form.reportId" data-testid="field-reportId" type="text" />
        </label>
        <label>
          <span>工作液批号</span>
          <input v-model="form.developerBatchNo" data-testid="field-developerBatchNo" type="text" placeholder="如 D76-260912-A" />
        </label>
        <label>
          <span>实冲批次</span>
          <input v-model="form.runBatchNo" data-testid="field-runBatchNo" type="text" placeholder="如 R-260924-06" />
        </label>
        <label>
          <span>活性</span>
          <input v-model.number="form.activity" data-testid="field-activity" type="number" min="0.5" max="1.5" step="0.01" />
        </label>
        <label>
          <span>实测温度</span>
          <input v-model.number="form.tempC" data-testid="field-tempC" type="number" min="10" max="50" step="0.1" />
        </label>
        <label>
          <span>实测时长</span>
          <input v-model.number="form.minutes" data-testid="field-minutes" type="number" min="0.25" max="90" step="0.25" />
        </label>
        <label>
          <span>机侧基准温度</span>
          <input v-model.number="form.machineBaselineTempC" data-testid="field-baselineTempC" type="number" min="10" max="50" step="0.5" />
        </label>
        <label>
          <span>机侧基准时间</span>
          <input v-model.number="form.machineBaselineMinutes" data-testid="field-baselineMinutes" type="number" min="0.5" max="60" step="0.25" />
        </label>
      </div>
      <div class="form-actions">
        <button type="button" class="ghost-button" @click="showForm = false">取消</button>
        <button type="submit" class="primary-button" data-testid="submit-reading" :disabled="saving">
          {{ saving ? '入账中…' : '接收并入账' }}
        </button>
      </div>
    </form>

    <div class="stat-strip">
      <StatBadge label="回传读数" :value="machineStore.readings.length" hint="同一单号重试不重复入账" tone="cyan" />
      <StatBadge label="已对账" :value="matchedCount" hint="批号与实冲批次均匹配台账" />
      <StatBadge label="基准待选定" :value="machineStore.pendingConflicts.length" hint="选定前对应工作液不参与新建议" tone="amber" />
      <StatBadge label="生效中建议" :value="machineStore.pendingAdvices.length" hint="按最新活性由本机重算" tone="rose" />
    </div>

    <div v-if="machineStore.pendingConflicts.length" class="panel">
      <div class="panel__head">
        <div>
          <h2>配方基准待选定</h2>
          <p>回传基准与本机不一致，两版并列保留；人工选定前该工作液不参与新建议。</p>
        </div>
      </div>
      <article v-for="conflict in machineStore.pendingConflicts" :key="conflict.id" class="conflict-card" data-testid="row-conflict">
        <div class="conflict-card__head">
          <strong>{{ developerName(conflict.developerId) }}</strong>
          <small>{{ recipeLabel(conflict.recipeId) }} · 登记于 {{ conflict.createdAt }}</small>
        </div>
        <div class="conflict-compare">
          <div class="conflict-side">
            <span class="conflict-side__tag">本机基准</span>
            <strong>{{ conflict.localTempC }}°C / {{ conflict.localMinutes }} 分钟</strong>
            <small>配方表当前记录</small>
          </div>
          <div class="conflict-side conflict-side--machine">
            <span class="conflict-side__tag">冲洗机基准</span>
            <strong>{{ conflict.machineTempC }}°C / {{ conflict.machineMinutes }} 分钟</strong>
            <small>来自回传读数</small>
          </div>
        </div>
        <div class="conflict-card__actions">
          <button type="button" class="ghost-button" data-testid="pick-local" @click="pickBaseline(conflict.id, 'local')">采用本机版</button>
          <button type="button" class="primary-button" data-testid="pick-machine" @click="pickBaseline(conflict.id, 'machine')">采用冲洗机版</button>
        </div>
      </article>
    </div>

    <div class="panel">
      <div class="panel__head">
        <div>
          <h2>修正建议</h2>
          <p>活性更新后未完成的建议立即失效并按本机模型重算；已采纳的建议与判定依据照旧保留。</p>
        </div>
      </div>
      <div v-if="sortedAdvices.length" class="advice-list">
        <article
          v-for="advice in sortedAdvices"
          :key="advice.id"
          class="advice-card"
          :class="{ 'advice-card--closed': advice.status !== 'pending' }"
          data-testid="row-advice"
        >
          <div class="advice-card__main">
            <div class="entity-card__title">
              <div>
                <span class="status-chip" :class="adviceTone(advice.status)">{{ adviceLabel(advice.status) }}</span>
                <h2>{{ developerName(advice.developerId) }}</h2>
              </div>
              <strong class="advice-card__minutes">{{ advice.suggestedMinutes.toFixed(2) }} 分钟</strong>
            </div>
            <p class="advice-card__recipe">{{ recipeLabel(advice.recipeId) }}</p>
            <small class="advice-card__basis">{{ advice.basis }}</small>
          </div>
          <div class="advice-card__foot">
            <small>登记于 {{ advice.createdAt }}<template v-if="advice.closedAt"> · 关闭于 {{ advice.closedAt }}</template></small>
            <button
              v-if="advice.status === 'pending'"
              type="button"
              class="text-button"
              data-testid="apply-advice"
              @click="applyAdvice(advice.id)"
            >采纳建议</button>
          </div>
        </article>
      </div>
      <EmptyPanel v-else title="暂无修正建议" description="接收冲洗机回传并对账成功后，本机会按最新活性生成修正建议。" />
    </div>

    <div v-if="resolvedConflicts.length" class="panel">
      <div class="panel__head">
        <div>
          <h2>基准选定记录</h2>
          <p>人工选定的历史结果，两版数值与选定时间留档。</p>
        </div>
      </div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>工作液 / 配方</th>
              <th>本机版</th>
              <th>冲洗机版</th>
              <th>选定结果</th>
              <th>选定时间</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="conflict in resolvedConflicts" :key="conflict.id">
              <td>
                <strong>{{ developerName(conflict.developerId) }}</strong>
                <small>{{ recipeLabel(conflict.recipeId) }}</small>
              </td>
              <td>{{ conflict.localTempC }}°C / {{ conflict.localMinutes }} 分钟</td>
              <td>{{ conflict.machineTempC }}°C / {{ conflict.machineMinutes }} 分钟</td>
              <td>
                <span class="status-chip" :class="conflict.status === 'resolved-local' ? 'status--cyan' : 'status--amber'">
                  {{ conflict.status === 'resolved-local' ? '采用本机版' : '采用冲洗机版' }}
                </span>
              </td>
              <td>{{ conflict.resolvedAt }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <div class="panel">
      <div class="panel__head">
        <div>
          <h2>回传读数台账</h2>
          <p>冲洗机回传的活性、温度与时长事实，按工作液批号与实冲批次逐条对账。</p>
        </div>
        <span class="count-pill">读数 <strong data-testid="count-reading">{{ machineStore.readings.length }}</strong></span>
      </div>
      <div v-if="machineStore.readings.length" class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>回传单号</th>
              <th>对账状态</th>
              <th>工作液批号</th>
              <th>实冲批次</th>
              <th>活性</th>
              <th>实测温度 / 时长</th>
              <th>机侧基准</th>
              <th>接收时间</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="reading in machineStore.readings" :key="reading.id" data-testid="row-reading">
              <td><strong>{{ reading.reportId }}</strong></td>
              <td><span class="status-chip" :class="reconTone(reading.reconStatus)">{{ reconLabel(reading.reconStatus) }}</span></td>
              <td>
                <strong>{{ reading.developerBatchNo }}</strong>
                <small>{{ developerName(reading.developerId) }}</small>
              </td>
              <td>{{ reading.runBatchNo }}</td>
              <td>{{ reading.activity.toFixed(2) }}</td>
              <td>{{ reading.tempC }}°C / {{ reading.minutes }} 分钟</td>
              <td>{{ reading.machineBaselineTempC }}°C / {{ reading.machineBaselineMinutes }} 分钟</td>
              <td>{{ reading.receivedAt }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <EmptyPanel v-else title="暂无回传读数" description="点击右上角“接收回传”，录入冲洗机回报的控制条读数。" />
    </div>
  </section>
</template>
