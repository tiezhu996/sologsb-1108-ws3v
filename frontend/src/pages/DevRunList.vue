<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { useRoute } from 'vue-router'
import EmptyPanel from '../components/common/EmptyPanel.vue'
import FilterBar from '../components/common/FilterBar.vue'
import PushPullTag from '../components/common/PushPullTag.vue'
import { useTempCompensate } from '../hooks/useTempCompensate'
import { suggestMinutesAtTemp } from '../utils/advice'
import { useDeveloperStore } from '../stores/developerStore'
import { useFilmStore } from '../stores/filmStore'
import { useRecipeStore } from '../stores/recipeStore'
import { useRunStore } from '../stores/runStore'
import { useMachineStore } from '../stores/machineStore'
import type { TankType } from '../types/dev-run'

interface FilterValue {
  keyword: string
  selections: Record<string, string[]>
}

interface RunForm {
  batchNo: string
  recipeId: number
  developerId: number | null
  actualTempC: number
  actualMinutes: number
  tankType: TankType
  runDate: string
  result: string
  applyCorrectionId: number | null
}

const route = useRoute()
const filmStore = useFilmStore()
const developerStore = useDeveloperStore()
const recipeStore = useRecipeStore()
const runStore = useRunStore()
const machineStore = useMachineStore()
const showForm = ref(false)
const saving = ref(false)
const today = new Date().toISOString().slice(0, 10)

const querySelections = (key: string): string[] => {
  const value = route.query[key]
  return typeof value === 'string' && value ? value.split(',') : []
}

const filterValue = ref<FilterValue>({
  keyword: typeof route.query.q === 'string' ? route.query.q : '',
  selections: {
    tankType: querySelections('tankType'),
    result: querySelections('result')
  }
})

const form = reactive<RunForm>({
  batchNo: `R-${today.replace(/-/g, '')}-01`,
  recipeId: 1,
  developerId: null,
  actualTempC: 20,
  actualMinutes: 8,
  tankType: '双联罐',
  runDate: today,
  result: '密度均匀，中间调细腻',
  applyCorrectionId: null
})

const selectedRecipe = computed(() => recipeStore.recipes.find((recipe) => recipe.id === form.recipeId))
const referenceTemp = computed(() => selectedRecipe.value?.tempC ?? 20)
const { suggest } = useTempCompensate(referenceTemp)
const suggestion = computed(() => {
  const recipe = selectedRecipe.value
  if (!recipe) return null
  return suggest(recipe.devMinutes, form.actualTempC)
})

const recipeDeveloperId = computed(() => selectedRecipe.value?.developerId ?? null)
const blockedBatchNos = computed(() => new Set(machineStore.blockedBatchNos))
const selectedDeveloper = computed(() =>
  developerStore.developers.find((item) => item.id === (form.developerId ?? recipeDeveloperId.value))
)
const batchBlocked = computed(() =>
  selectedDeveloper.value ? blockedBatchNos.value.has(selectedDeveloper.value.batchNo) : false
)
/** 针对所选工作液+配方、由本机按活性重算且仍生效的修正建议 */
const pendingCorrection = computed(() =>
  machineStore.pendingCorrectionFor(form.developerId ?? recipeDeveloperId.value, form.recipeId)
)
const correctionMinutes = computed(() => {
  const correction = pendingCorrection.value
  if (!correction) return null
  return suggestMinutesAtTemp(correction.basis, form.actualTempC)
})

watch(selectedRecipe, (recipe) => {
  if (!recipe) return
  form.actualTempC = recipe.tempC
  form.actualMinutes = recipe.devMinutes
  form.developerId = recipe.developerId
  form.applyCorrectionId = null
}, { immediate: true })

watch([pendingCorrection, () => form.actualTempC], () => {
  if (!form.applyCorrectionId) return
  if (correctionMinutes.value !== null) form.actualMinutes = correctionMinutes.value
})

const filteredRuns = computed(() => {
  const keyword = filterValue.value.keyword.trim().toLowerCase()
  const tankTypes = filterValue.value.selections.tankType ?? []
  const results = filterValue.value.selections.result ?? []
  return runStore.runs.filter((run) => {
    const recipe = recipeStore.recipes.find((item) => item.id === run.recipeId)
    const film = filmStore.films.find((item) => item.id === recipe?.filmId)
    const haystack = `${run.batchNo} ${run.result} ${film?.model ?? ''}`.toLowerCase()
    const matchesKeyword = !keyword || haystack.includes(keyword)
    const matchesTank = tankTypes.length === 0 || tankTypes.includes(run.tankType)
    const matchesResult = results.length === 0 || results.some((item) => run.result.includes(item))
    return matchesKeyword && matchesTank && matchesResult
  })
})

function recipeLabel(id: number): string {
  const recipe = recipeStore.recipes.find((item) => item.id === id)
  if (!recipe) return '未知配方'
  const film = filmStore.films.find((item) => item.id === recipe.filmId)
  const developer = developerStore.developers.find((item) => item.id === recipe.developerId)
  return `${film?.model ?? '未知胶片'} · ${developer?.name ?? '未知显影液'} · ${recipe.tempC}°C`
}

function recipeForRun(id: number) {
  return recipeStore.recipes.find((item) => item.id === id)
}

function applySuggestion(): void {
  if (!suggestion.value) return
  form.applyCorrectionId = null
  form.actualMinutes = suggestion.value.minutes
}

function applyCorrection(): void {
  if (correctionMinutes.value === null || !pendingCorrection.value) return
  form.applyCorrectionId = pendingCorrection.value.id ?? null
  form.actualMinutes = correctionMinutes.value
}

async function submitRun(): Promise<void> {
  if (!form.batchNo.trim() || !form.recipeId || !form.result.trim()) {
    ElMessage.warning('请填写批次号、配方与结果评价')
    return
  }
  const effectiveDeveloperId = form.developerId ?? recipeDeveloperId.value
  if (batchBlocked.value) {
    ElMessage.warning('该工作液批号的配方基准尚待人工选定，本批不使用活性修正建议（仍可手工录入实冲）')
    form.applyCorrectionId = null
  }
  saving.value = true
  const selectedDev = developerStore.developers.find((item) => item.id === effectiveDeveloperId)
  const willExceedLimit = selectedDev !== undefined
    && selectedDev.state !== '报废'
    && selectedDev.usedRolls + 1 > selectedDev.maxRolls
  try {
    await runStore.addRun({
      batchNo: form.batchNo.trim(),
      recipeId: Number(form.recipeId),
      developerId: effectiveDeveloperId,
      actualTempC: Number(form.actualTempC),
      actualMinutes: Number(form.actualMinutes),
      tankType: form.tankType,
      runDate: form.runDate,
      result: form.result.trim(),
      applyCorrectionId: form.applyCorrectionId
    })
    await Promise.all([developerStore.load(), recipeStore.load(), machineStore.load()])
    if (willExceedLimit) {
      ElMessage.warning('冲洗记录已保存，本次已超过显影液标称可冲上限，请评估后标记报废')
    } else {
      ElMessage.success('冲洗记录已保存，显影液用量同步更新')
    }
    form.batchNo = `R-${today.replace(/-/g, '')}-${String(runStore.runs.length + 1).padStart(2, '0')}`
    form.result = ''
    form.applyCorrectionId = null
    showForm.value = false
  } finally {
    saving.value = false
  }
}

async function writeBack(recipeId?: number, runId?: number): Promise<void> {
  if (recipeId === undefined || runId === undefined) return
  await runStore.writeBackNote(runId, recipeId)
  await recipeStore.load()
  ElMessage.success('本次实冲结果已回写配方注释')
}

onMounted(async () => {
  await Promise.all([
    filmStore.load(),
    developerStore.load(),
    recipeStore.load(),
    runStore.load(),
    machineStore.load()
  ])
  if (recipeStore.recipes[0]?.id !== undefined) {
    form.recipeId = recipeStore.recipes[0].id
  }
})
</script>

<template>
  <section class="page-shell">
    <header class="page-hero page-hero--compact">
      <div>
        <span class="eyebrow">RUN JOURNAL</span>
        <h1>冲洗记录与结果评价</h1>
        <p>记录每一次实测温度、实际时间与样片结果，让下一批参数来自真实经验。</p>
      </div>
      <button type="button" class="primary-button" data-testid="new-run" @click="showForm = !showForm">
        {{ showForm ? '收起表单' : '新建冲洗记录' }}
      </button>
    </header>

    <form v-if="showForm" class="inline-form" data-testid="form-run" @submit.prevent="submitRun">
      <div class="inline-form__head">
        <div>
          <h2>录入本次实冲</h2>
          <p>选择配方后会自动带入基准条件，可依据实测温度一键采用修正时间。</p>
        </div>
        <PushPullTag v-if="selectedRecipe" :value="selectedRecipe.pushPull" show-hint />
      </div>
      <div class="form-grid form-grid--three">
        <label>
          <span>批次号</span>
          <input v-model="form.batchNo" data-testid="field-batchNo" type="text" />
        </label>
        <label class="span-2">
          <span>冲洗配方</span>
          <select v-model.number="form.recipeId" data-testid="field-recipeId">
            <option v-for="recipe in recipeStore.recipes" :key="recipe.id" :value="recipe.id">
              {{ recipeLabel(recipe.id ?? 0) }}
            </option>
          </select>
        </label>
        <label>
          <span>实测温度</span>
          <input v-model.number="form.actualTempC" data-testid="field-actualTempC" type="number" min="10" max="50" step="0.1" />
        </label>
        <label>
          <span>实际时间</span>
          <input v-model.number="form.actualMinutes" data-testid="field-actualMinutes" type="number" min="0.25" max="90" step="0.25" />
        </label>
        <label>
          <span>罐型</span>
          <select v-model="form.tankType" data-testid="field-tankType">
            <option value="双联罐">双联罐</option>
            <option value="深罐">深罐</option>
          </select>
        </label>
        <label>
          <span>冲洗日期</span>
          <input v-model="form.runDate" data-testid="field-runDate" type="date" />
        </label>
        <label class="span-2">
          <span>使用工作液</span>
          <select v-model.number="form.developerId" data-testid="field-developerId">
            <option v-for="developer in developerStore.developers" :key="developer.id" :value="developer.id">
              {{ developer.name }} · {{ developer.batchNo }}
            </option>
          </select>
        </label>
        <label class="span-2">
          <span>结果评价</span>
          <input v-model="form.result" data-testid="field-result" type="text" placeholder="记录反差、灰雾与密度表现" />
        </label>
        <div class="span-3 compensation-callout" :class="{ 'compensation-callout--active': form.applyCorrectionId }">
          <div>
            <strong>温度补偿建议（即时折算）</strong>
            <p v-if="suggestion">{{ suggestion.advice }}；显影液用量会在保存后加一卷。</p>
            <p v-else>请选择一条配方后查看修正建议。</p>
          </div>
          <button type="button" class="ghost-button" :disabled="!suggestion" @click="applySuggestion">采用温度折算</button>
        </div>
        <div v-if="selectedDeveloper" class="span-3 compensation-callout correction-callout">
          <div>
            <strong>活性修正建议（本机重算）</strong>
            <p v-if="batchBlocked">
              工作液 {{ selectedDeveloper.batchNo }} 的配方基准两版尚未人工选定，本批暂不参与新建议。
            </p>
            <p v-else-if="pendingCorrection && correctionMinutes !== null">
              控制条活性 {{ Math.round(pendingCorrection.basis.activity * 100) }}%，活性系数 ×{{ pendingCorrection.activityFactor }}；
              按 {{ form.actualTempC }}°C 实冲建议 <strong>{{ correctionMinutes.toFixed(2) }} 分钟</strong>。
              <em v-if="form.applyCorrectionId">已采用，保存时将冻结当时判定依据。</em>
            </p>
            <p v-else>该工作液暂无控制条活性读数，按手工校验处理，不补造活性数值。</p>
          </div>
          <button
            v-if="pendingCorrection && correctionMinutes !== null && !batchBlocked"
            type="button"
            class="primary-button"
            data-testid="apply-correction"
            @click="applyCorrection"
          >采用活性建议</button>
        </div>
      </div>
      <div class="form-actions">
        <button type="button" class="ghost-button" @click="showForm = false">取消</button>
        <button type="submit" class="primary-button" data-testid="submit-run" :disabled="saving">
          {{ saving ? '保存中…' : '保存冲洗记录' }}
        </button>
      </div>
    </form>

    <div class="stat-strip">
      <div class="simple-stat"><span>记录总数</span><strong data-testid="count-run">{{ runStore.runs.length }}</strong><small>次</small></div>
      <div class="simple-stat"><span>当前筛选</span><strong>{{ filteredRuns.length }}</strong><small>次</small></div>
      <div class="simple-stat"><span>回写配方</span><strong>{{ recipeStore.recipes.filter((item) => item.note).length }}</strong><small>条</small></div>
    </div>

    <FilterBar
      v-model="filterValue"
      :fields="[
        { key: 'tankType', label: '罐型', options: ['双联罐', '深罐'] },
        { key: 'result', label: '结果特点', options: ['密度均匀', '暗部略薄', '反差稍强', '高光保留', '灰雾'] }
      ]"
    />

    <div v-if="filteredRuns.length" class="run-list">
      <article v-for="run in filteredRuns" :key="run.id" class="run-card" data-testid="row-run">
        <div class="run-card__date">
          <strong>{{ run.runDate.slice(5) }}</strong>
          <span>{{ run.runDate.slice(0, 4) }}</span>
        </div>
        <div class="run-card__body">
          <div class="entity-card__title">
            <div>
              <h2>{{ run.batchNo }}</h2>
              <p>{{ recipeLabel(run.recipeId) }}</p>
            </div>
            <PushPullTag v-if="recipeForRun(run.recipeId)" :value="recipeForRun(run.recipeId)?.pushPull ?? 'N'" />
          </div>
          <div class="run-parameters">
            <span><small>实测温度</small><strong>{{ run.actualTempC }}°C</strong></span>
            <span><small>实际时间</small><strong>{{ run.actualMinutes }} 分钟</strong></span>
            <span><small>罐型</small><strong>{{ run.tankType }}</strong></span>
            <span>
              <small>数据校验</small>
              <span
                class="status-chip"
                :class="run.verifiedBy === 'instrument' ? 'status--cyan' : 'status--amber'"
                data-testid="run-verified"
              >{{ run.verifiedBy === 'instrument' ? '仪器读数' : '手工校验' }}</span>
            </span>
          </div>
          <blockquote>{{ run.result }}</blockquote>
          <div v-if="run.basisSnapshot" class="basis-snapshot" data-testid="run-basis">
            采纳时依据已冻结：活性 {{ Math.round(run.basisSnapshot.activity * 100) }}%
            · 基准 {{ run.basisSnapshot.baselineTempC }}°C / {{ run.basisSnapshot.baselineMinutes }} 分钟
            · 读数 #{{ run.basisSnapshot.readingId }}
            <em v-if="run.basisSnapshot.conflictResolved">（人工选定基准）</em>
          </div>
          <div class="run-card__foot">
            <small v-if="recipeForRun(run.recipeId)?.note">配方注释：{{ recipeForRun(run.recipeId)?.note }}</small>
            <button type="button" class="text-button" @click="writeBack(run.recipeId, run.id)">回写配方注释</button>
          </div>
        </div>
      </article>
    </div>
    <EmptyPanel v-else title="没有符合条件的冲洗记录" description="调整罐型、结果特点或关键字后重新查看。" />
  </section>
</template>
