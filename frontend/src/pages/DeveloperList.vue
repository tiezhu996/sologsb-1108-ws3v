<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue'
import { ElMessage } from 'element-plus'
import DilutionInput from '../components/common/DilutionInput.vue'
import StatBadge from '../components/common/StatBadge.vue'
import { useDeveloperStore } from '../stores/developerStore'
import { useMachineStore } from '../stores/machineStore'
import type { Developer, DeveloperCategory, DeveloperState, Dilution } from '../types/developer'
import { calculateStockVolume, remainingRolls } from '../utils/ratio'

interface DeveloperForm {
  name: string
  batchNo: string
  category: DeveloperCategory
  dilution: Dilution
  volumeMl: number
  mixedAt: string
  maxRolls: number
  usedRolls: number
  state: DeveloperState
}

const developerStore = useDeveloperStore()
const machineStore = useMachineStore()
const showForm = ref(false)
const saving = ref(false)
const batchDrafts = reactive<Record<number, string>>({})
const form = reactive<DeveloperForm>({
  name: '',
  batchNo: '',
  category: 'D-76',
  dilution: '1:1',
  volumeMl: 1000,
  mixedAt: new Date().toISOString().slice(0, 10),
  maxRolls: 12,
  usedRolls: 0,
  state: '新配'
})

function stateTone(developer: Developer): 'cyan' | 'amber' | 'rose' {
  if (developer.state === '报废') return 'rose'
  if (developer.state === '新配') return 'cyan'
  return 'amber'
}

function isBaselinePending(id?: number): boolean {
  return id !== undefined && machineStore.pendingConflictDeveloperIds.has(id)
}

async function submitDeveloper(): Promise<void> {
  if (!form.name.trim() || !form.mixedAt) {
    ElMessage.warning('请填写显影液名称与配制日期')
    return
  }
  saving.value = true
  try {
    await developerStore.addDeveloper({
      ...form,
      name: form.name.trim(),
      batchNo: form.batchNo.trim(),
      volumeMl: Math.max(0, form.volumeMl),
      maxRolls: Math.max(1, form.maxRolls),
      usedRolls: Math.max(0, form.usedRolls)
    })
    ElMessage.success('显影液工作液已登记')
    form.name = ''
    form.batchNo = ''
    form.mixedAt = new Date().toISOString().slice(0, 10)
    form.maxRolls = 12
    form.usedRolls = 0
    form.state = '新配'
    showForm.value = false
  } finally {
    saving.value = false
  }
}

async function saveBatchNo(id?: number): Promise<void> {
  if (id === undefined) return
  const batchNo = (batchDrafts[id] ?? '').trim()
  if (!batchNo) {
    ElMessage.warning('请填写要补登的工作液批号')
    return
  }
  await developerStore.setBatchNo(id, batchNo)
  delete batchDrafts[id]
  ElMessage.success('工作液批号已补登，后续回传可按批号对账')
}

async function scrapDeveloper(id?: number): Promise<void> {
  if (id === undefined) return
  await developerStore.scrap(id)
  ElMessage.success('该工作液已标记为报废')
}

onMounted(() => {
  void Promise.all([developerStore.load(), machineStore.load()])
})
</script>

<template>
  <section class="page-shell">
    <header class="page-hero page-hero--compact">
      <div>
        <span class="eyebrow">CHEMISTRY DESK</span>
        <h1>显影液配制与余量</h1>
        <p>记录配制日期与可冲卷数，剩余量归零前及时安排补充或标记报废。</p>
      </div>
      <button type="button" class="primary-button" data-testid="new-developer" @click="showForm = !showForm">
        {{ showForm ? '收起表单' : '新建显影液' }}
      </button>
    </header>

    <div class="stat-strip">
      <StatBadge label="工作液总数" :value="developerStore.developers.length" hint="含新配与报废记录" tone="cyan" />
      <StatBadge label="可用余量" :value="developerStore.availableRolls" hint="按剩余可冲卷数合计" tone="amber" />
      <StatBadge label="已报废" :value="developerStore.developers.filter((item) => item.state === '报废').length" hint="不再计入可用余量" tone="rose" />
    </div>

    <form v-if="showForm" class="inline-form" data-testid="form-developer" @submit.prevent="submitDeveloper">
      <div class="inline-form__head">
        <div>
          <h2>登记显影液工作液</h2>
          <p>容量按工作液总量记录，稀释换算会同步估算单卷用量。</p>
        </div>
      </div>
      <div class="form-grid form-grid--three">
        <label>
          <span>名称</span>
          <input v-model="form.name" data-testid="field-name" type="text" placeholder="如 柯达 D-76 工作液 A" />
        </label>
        <label>
          <span>工作液批号</span>
          <input v-model="form.batchNo" data-testid="field-batchNo" type="text" placeholder="回传对账用，如 D76-260912-A" />
        </label>
        <label>
          <span>类型</span>
          <select v-model="form.category" data-testid="field-category">
            <option value="D-76">D-76</option>
            <option value="HC-110">HC-110</option>
            <option value="Rodinal">Rodinal</option>
            <option value="C-41">C-41</option>
          </select>
        </label>
        <label>
          <span>状态</span>
          <select v-model="form.state" data-testid="field-state">
            <option value="新配">新配</option>
            <option value="在用">在用</option>
            <option value="报废">报废</option>
          </select>
        </label>
        <div class="span-2">
          <DilutionInput
            v-model:ratio="form.dilution"
            v-model:working-volume-ml="form.volumeMl"
            ratio-test-id="field-dilution"
            volume-test-id="field-volumeMl"
          />
        </div>
        <label>
          <span>配制日期</span>
          <input v-model="form.mixedAt" data-testid="field-mixedAt" type="date" />
        </label>
        <label>
          <span>可冲上限</span>
          <input v-model.number="form.maxRolls" data-testid="field-maxRolls" type="number" min="1" max="100" />
        </label>
        <label>
          <span>已冲卷数</span>
          <input v-model.number="form.usedRolls" data-testid="field-usedRolls" type="number" min="0" max="100" />
        </label>
      </div>
      <div class="form-actions">
        <button type="button" class="ghost-button" @click="showForm = false">取消</button>
        <button type="submit" class="primary-button" data-testid="submit-developer" :disabled="saving">
          {{ saving ? '保存中…' : '保存工作液' }}
        </button>
      </div>
    </form>

    <div class="dev-grid">
      <div class="panel dev-count-panel">
        <span>台账记录</span>
        <strong data-testid="count-developer">{{ developerStore.developers.length }}</strong>
        <small>条工作液记录</small>
      </div>
      <article
        v-for="developer in developerStore.developers"
        :key="developer.id"
        class="entity-card developer-card"
        data-testid="row-developer"
      >
        <div class="entity-card__main">
          <div class="entity-card__title">
            <div>
              <span class="status-chip" :class="`status--${stateTone(developer)}`">{{ developer.state }}</span>
              <span v-if="isBaselinePending(developer.id)" class="status-chip status--warning">基准待定</span>
              <h2>{{ developer.name }}</h2>
            </div>
            <button
              v-if="developer.state !== '报废'"
              type="button"
              class="text-button text-button--danger"
              @click="scrapDeveloper(developer.id)"
            >
              标记报废
            </button>
          </div>
          <dl class="data-pairs">
            <div><dt>工作液批号</dt><dd>{{ developer.batchNo || '未登记' }}</dd></div>
            <div><dt>类型 / 稀释</dt><dd>{{ developer.category }} · {{ developer.dilution }}</dd></div>
            <div><dt>工作液容量</dt><dd>{{ developer.volumeMl }} mL</dd></div>
            <div><dt>配制日期</dt><dd>{{ developer.mixedAt }}</dd></div>
            <div><dt>所需浓缩液</dt><dd>{{ calculateStockVolume(developer.volumeMl, developer.dilution) }} mL</dd></div>
          </dl>
          <div v-if="!developer.batchNo" class="batchno-patch">
            <input
              v-model="batchDrafts[developer.id ?? 0]"
              data-testid="field-batchNo-patch"
              type="text"
              placeholder="补登批号以对账冲洗机回传"
            />
            <button type="button" class="text-button" @click="saveBatchNo(developer.id)">补登批号</button>
          </div>
          <p v-if="isBaselinePending(developer.id)" class="baseline-pending-hint">
            配方基准两版待人工选定，选定前该工作液不参与新建议。
          </p>
          <div class="life-meter">
            <div class="life-meter__head">
              <span>剩余 {{ remainingRolls(developer.maxRolls, developer.usedRolls) }} 卷</span>
              <span>已用 {{ developer.usedRolls }} / {{ developer.maxRolls }}</span>
            </div>
            <div class="life-meter__track">
              <i :style="{ width: `${Math.min(100, developer.usedRolls / developer.maxRolls * 100)}%` }"></i>
            </div>
            <small v-if="remainingRolls(developer.maxRolls, developer.usedRolls) === 0">余量已耗尽，建议报废并重新配制。</small>
          </div>
        </div>
      </article>
    </div>
  </section>
</template>
