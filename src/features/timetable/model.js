// 课程表数据模型与工具 —— 参考 NoXiaoYing（SIT 课程表 App）
// 约定：startDate 为第一周周一（非周一也按「这天=第1周周一」对齐，与 NoXiaoYing 一致）；
// 每天固定 11 节（SIT 作息），周次 UI 与存储均从 1 计；一条课程记录 = 一个上课场次。

export const SLOT_TIMES = [
  ['08:20', '09:05'], ['09:10', '09:55'], ['10:10', '10:55'], ['11:00', '11:45'],
  ['13:00', '13:45'], ['13:50', '14:35'], ['14:55', '15:40'], ['15:45', '16:30'],
  ['18:00', '18:45'], ['18:50', '19:35'], ['19:40', '20:25'],
]
export const SLOT_COUNT = SLOT_TIMES.length
export const DEFAULT_WEEK_COUNT = 20

export const WEEKDAY_LABELS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日']
export const WEEKDAY_SHORT = ['一', '二', '三', '四', '五', '六', '日']

// 同名课程共用一个颜色：按课名哈希选色相（0-4），跨会话稳定
export function courseHue(name) {
  let h = 0
  for (const ch of name || '') h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return h % 5
}

const DAY_MS = 86400000
// 设备级存储：不做按用户分 key——应用启动后 user 对象会被异步改写，挂载时读到的 id 不可靠
// 多学期结构：{ version, nj, active, semesters: { [key]: timetable }, updatedAt }
// key = '学年-学期码'（正方学期码：3=第一学期/12=第二学期/16=短学期，如 2025-3 = 大一上）
const STORAGE_KEY = 'campus_timetable'

export function emptyTimetable() {
  return { version: 1, name: '', startDate: '', weekCount: DEFAULT_WEEK_COUNT, courses: [], events: [], adjustments: [] }
}

// 学期起点日期 → 学期 key：9-12 月=当年第一学期(3)，1 月=上一学年第一学期，2-6 月=第二学期(12)，7-8 月=短学期(16)
export function semesterKeyOf(startDate) {
  const d = new Date(`${startDate}T00:00:00`)
  if (!startDate || Number.isNaN(d.getTime())) return 'default'
  const y = d.getFullYear()
  const m = d.getMonth() + 1
  if (m >= 9) return `${y}-3`
  if (m === 1) return `${y - 1}-3`
  if (m <= 6) return `${y - 1}-12`
  return `${y - 1}-16`
}

const TERM_NAMES = ['大一上', '大一下', '大二上', '大二下', '大三上', '大三下', '大四上', '大四下']

// 学期 key → 展示名：已知年级（入学学年）给「大一上」式短名，否则给学年全名
export function semesterLabel(key, nj) {
  const m = /^(\d{4})-(3|12|16)$/.exec(key || '')
  if (!m) return key === 'default' ? '旧课表' : (key || '')
  const xnm = Number(m[1])
  if (m[2] === '16') return `${xnm}-${xnm + 1} 短学期`
  const n = parseInt(nj, 10)
  if (n) {
    const term = (xnm - n) * 2 + (m[2] === '12' ? 2 : 1)
    if (term >= 1 && term <= 8) return TERM_NAMES[term - 1]
  }
  return `${xnm}-${xnm + 1} ${m[2] === '3' ? '第一学期' : '第二学期'}`
}

// 旧版考试导入的日程没有 kind/seat 字段：按备注含「考试」补标并提取座位号
//（考试的课程卡样式渲染与考完置灰都依赖 kind）
function migrateEvents(events) {
  return (events || []).map(ev => {
    if (ev.kind || !ev.date || !(ev.note || '').includes('考试')) return ev
    const m = /座位\s*([0-9A-Za-z]+)/.exec(ev.note || '')
    return { ...ev, kind: 'exam', seat: ev.seat || (m ? m[1] : '') }
  })
}

// 任意历史/新版数据 → 标准多学期结构（旧版单课表按学期起点归入对应学期）；无有效数据返回 null
export function normalizeStore(d) {
  if (!d || typeof d !== 'object') return null
  if (d.semesters && typeof d.semesters === 'object') {
    const semesters = {}
    for (const [k, v] of Object.entries(d.semesters)) {
      if (v && Array.isArray(v.courses)) semesters[k] = { ...emptyTimetable(), ...v, events: migrateEvents(v.events) }
    }
    if (!Object.keys(semesters).length) return null
    const active = semesters[d.active] ? d.active : Object.keys(semesters)[0]
    return { version: 1, nj: d.nj || '', active, semesters, updatedAt: d.updatedAt || 0 }
  }
  if (Array.isArray(d.courses)) {
    const key = semesterKeyOf(d.startDate)
    return {
      version: 1, nj: d.nj || '', active: key, updatedAt: d.updatedAt || 0,
      semesters: { [key]: { ...emptyTimetable(), ...d, events: migrateEvents(d.events) } },
    }
  }
  return null
}

export function loadStore() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    return normalizeStore(JSON.parse(raw))
  } catch { return null }
}

export function saveStore(store) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(store)) } catch { /* 忽略 */ }
}

// 一天三个时段：第 1-4 节上午 / 5-8 下午 / 9-11 晚上（slot 0 起：0-3 / 4-7 / 8-10）
export const SECTIONS = [
  { index: 0, key: 'morning', labelKey: 'sectionMorning', from: 0, to: 3 },
  { index: 1, key: 'afternoon', labelKey: 'sectionAfternoon', from: 4, to: 7 },
  { index: 2, key: 'evening', labelKey: 'sectionEvening', from: 8, to: 10 },
]

export function sectionOfSlot(slot) {
  return SECTIONS.find(s => slot >= s.from && slot <= s.to) || SECTIONS[0]
}

export function minutesOf(hm) {
  const [h, m] = (hm || '0:0').split(':').map(Number)
  return h * 60 + m
}

// 每节静默分成 10 份（45 分钟/节 → 每份 4.5 分钟），仅用于日程的精确落位
export const SUBS_PER_SLOT = 10

// 时间（分钟）→ 份数下标（第 k 节第 f 份 = k*10 + f；isEnd 时向上取整，结束边界才算到线）
export function fmtMin(min) {
  const p = (n) => String(n).padStart(2, '0')
  return `${p(Math.floor(min / 60))}:${p(min % 60)}`
}

export function dateISOOf(d) {
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

export function minutesToSub(min, isEnd = false) {
  const first = SLOT_TIMES.findIndex(([st]) => minutesOf(st) > min)
  const k = (first === -1 ? SLOT_COUNT : first) - 1
  if (k < 0) return 0
  const frac = ((min - minutesOf(SLOT_TIMES[k][0])) / 45) * SUBS_PER_SLOT
  const f = Math.max(0, Math.min(SUBS_PER_SLOT, isEnd ? Math.ceil(frac) : Math.floor(frac)))
  return k * SUBS_PER_SLOT + f
}

// 日程是否落在某个课表日（week+dayIndex 对应 dateISO）：
// 填了 date 只在那天显示；留 date 则按星期每重复周
export function eventOnDay(ev, colISO, dayIndex) {
  if (ev.date) return !!colISO && ev.date === colISO
  return ev.day === dayIndex
}

// 课程编辑器表单草稿初值
export function emptyDraft(weekCount) {
  return {
    name: '', place: '', teachers: '',
    day: 0, slotStart: 0, slotEnd: 1,
    weekType: 'all', weekStart: 1, weekEnd: weekCount,
    endAt: '', // 中午下课时间覆盖（最后一节为第 4 节时可选 11:55）
  }
}

export function loadTimetable() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const d = JSON.parse(raw)
    if (!d || !Array.isArray(d.courses)) return null
    return { ...emptyTimetable(), ...d }
  } catch { return null }
}

export function saveTimetable(data) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(data)) } catch { /* 忽略 */ }
}

function clearTime(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}

// 今天是第几周（1 起；学期外返回 null）与周几（0=周一）
export function locateToday(startDate, weekCount, now = new Date()) {
  if (!startDate) return null
  const start = new Date(`${startDate}T00:00:00`)
  if (Number.isNaN(start.getTime())) return null
  const totalDays = Math.round((clearTime(now) - start.getTime()) / DAY_MS)
  const dayIndex = ((totalDays % 7) + 7) % 7
  const week = Math.floor(totalDays / 7) + 1
  return { week: week >= 1 && week <= weekCount ? week : null, dayIndex }
}

// 某周某天（week 1 起、dayIndex 0=周一）对应的日期
export function dateOfWeekDay(startDate, week, dayIndex) {
  const start = new Date(`${startDate}T00:00:00`)
  if (Number.isNaN(start.getTime())) return null
  return new Date(start.getTime() + ((week - 1) * 7 + dayIndex) * DAY_MS)
}

// 课程是否命中某周（weekType：all 每周 / odd 单周 / even 双周，按 1-based 周号奇偶）
export function courseMatchesWeek(week, course) {
  if (week == null || week < course.weekStart || week > course.weekEnd) return false
  if (course.weekType === 'odd') return week % 2 === 1
  if (course.weekType === 'even') return week % 2 === 0
  return true
}

// ── 调休：off=放假无课；follow=该日按 day(0=周一) 的课表上课。存课表 JSON 内随云端同步 ──

// 某日期的调休规则（无则 null）
export function adjustmentOnDate(adjustments, iso) {
  if (!iso || !Array.isArray(adjustments)) return null
  return adjustments.find(a => a && a.date === iso) || null
}

// 地点拆行：末尾的字母+数字编号单独一行（图文信息中心B302 → 图文信息中心 / B302），无编号返回原串
export function splitPlace(place) {
  const p = (place || '').trim()
  const m = /^(.*?)([A-Za-z]+[\dA-Za-z-]*)$/.exec(p)
  return m && m[1].trim() ? [m[1].trim(), m[2]] : [p, '']
}

// 日期区间展开为逐日 ISO 列表（含两端，上限 42 天防误填）
export function expandDateRange(startISO, endISO) {
  const start = new Date(`${startISO}T00:00:00`)
  const end = new Date(`${endISO}T00:00:00`)
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end < start) return []
  const out = []
  for (let d = start; d <= end && out.length < 42; d = new Date(d.getTime() + DAY_MS)) out.push(dateISOOf(d))
  return out
}

// 某周某天的课程（按起始节次排序）
export function coursesOfDay(timetable, week, dayIndex) {
  return timetable.courses
    .filter(c => c.day === dayIndex && courseMatchesWeek(week, c))
    .sort((a, b) => a.slotStart - b.slotStart || a.slotEnd - b.slotEnd)
}

// 周次范围文案，如「1-16 周」「1-16 周单周」「8 周双周」——typeLabel 由页面传入（i18n 在页面解析）
export function weekRangeLabel(course, typeLabel) {
  const t = typeLabel[course.weekType] || ''
  if (course.weekStart === course.weekEnd) return `${course.weekStart} 周${t ? ` · ${t}` : ''}`
  return `${course.weekStart}-${course.weekEnd} 周${t ? ` · ${t}` : ''}`
}

// 课程实际下课时间（分钟）：最后一节是第 4 节时，可被课程的 endAt 覆盖
//（学校有两套作息，中午下课有 11:45 / 11:55 两个时间点）
// 两条件目是否会在同一天出现（date 优先，无 date 按每周星期）
function eventsCoOccur(a, b) {
  if (a.date && b.date) return a.date === b.date
  if (a.date) {
    const dt = new Date(`${a.date}T00:00:00`)
    return (dt.getDay() + 6) % 7 === b.day
  }
  if (b.date) {
    const dt = new Date(`${b.date}T00:00:00`)
    return (dt.getDay() + 6) % 7 === a.day
  }
  return a.day === b.day
}

// 新日程与现有课程/日程的时间冲突列表（编辑时跳过自身）
export function eventConflicts(tt, ev) {
  const s = minutesOf(ev.start)
  const e = minutesOf(ev.end)
  const out = []
  const weekdayOfDate = (d) => {
    const dt = new Date(`${d}T00:00:00`)
    return Number.isNaN(dt.getTime()) ? null : (dt.getDay() + 6) % 7
  }
  for (const c of tt.courses || []) {
    if (ev.date) {
      const wk = locateToday(tt.startDate, tt.weekCount, new Date(`${ev.date}T00:00:00`))
      if (!wk || wk.week === null || c.day !== weekdayOfDate(ev.date) || !courseMatchesWeek(wk.week, c)) continue
    } else if (c.day !== ev.day) {
      continue
    }
    const cs = minutesOf(SLOT_TIMES[c.slotStart][0])
    const ce = courseEndMin(c)
    if (s < ce && e > cs) out.push({ kind: 'course', item: c })
  }
  for (const other of tt.events || []) {
    if (ev.id && other.id === ev.id) continue
    if (!eventsCoOccur(ev, other)) continue
    const os = minutesOf(other.start)
    const oe = minutesOf(other.end)
    if (s < oe && e > os) out.push({ kind: 'event', item: other })
  }
  return out
}

export function courseEndMin(course) {
  if (course.slotEnd === 3 && course.endAt) return minutesOf(course.endAt)
  return minutesOf(SLOT_TIMES[course.slotEnd][1])
}

// ── 教务导入：每周原始场次 → 合并成展示用课程条目（连续周一段、同奇偶合并为单/双周）──

// 周号集合 → 展示段
function splitWeekRuns(weeks) {
  const runs = []
  for (const x of weeks) {
    const last = runs[runs.length - 1]
    if (last && x - last[last.length - 1] === 1) last.push(x)
    else runs.push([x])
  }
  // 间隔 2 且同奇偶的相邻段合并（如 6,8 → 双周 6-8）
  const merged = []
  for (const r of runs) {
    const prev = merged[merged.length - 1]
    if (prev && r[0] - prev[prev.length - 1] === 2 && prev.every(x => x % 2 === r[0] % 2)) prev.push(...r)
    else merged.push(r)
  }
  return merged.map(r => {
    if (r.length >= 2 && r.every(x => x % 2 === r[0] % 2)) {
      return { type: r[0] % 2 === 1 ? 'odd' : 'even', start: r[0], end: r[r.length - 1] }
    }
    return { type: 'all', start: r[0], end: r[r.length - 1] }
  })
}

// jwxt.weeks = { [周号]: [{name, place, teachers, code, clazz, day, slotStart, slotEnd}] } → 课程条目数组
const GUID_RE = /^[0-9A-Fa-f]{32}$/

export function deriveImportedCourses(jwxt) {
  const weeks = (jwxt && jwxt.weeks) || {}
  const groups = new Map()
  for (const zsStr of Object.keys(weeks)) {
    const zs = parseInt(zsStr, 10)
    for (const o of weeks[zsStr] || []) {
      // code/clazz 不进合并键：后续导入只刷新当前停留周，新旧数据混存会把同一场次拆成多段（代码行显示不齐的根因）
      // 作为附属元数据随组合并，取首个有效值（跳过 32 位 GUID 形态的旧脏数据）
      const key = `${o.name}|${o.place}|${o.teachers}|${o.day}|${o.slotStart}|${o.slotEnd}`
      if (!groups.has(key)) {
        groups.set(key, { zsList: [], code: '', clazz: '', name: o.name, place: o.place,
          teachers: o.teachers, day: o.day, slotStart: o.slotStart, slotEnd: o.slotEnd })
      }
      const g = groups.get(key)
      g.zsList.push(zs)
      const code = (o.code || '').trim()
      const clazz = (o.clazz || '').trim()
      if (!g.code && code && !GUID_RE.test(code)) g.code = code
      if (!g.clazz && clazz) g.clazz = clazz
    }
  }
  const out = []
  let n = 0
  for (const g of groups.values()) {
    const zsListU = [...new Set(g.zsList)].sort((a, b) => a - b)
    for (const seg of splitWeekRuns(zsListU)) {
      n += 1
      out.push({
        id: `jw-${n}`,
        name: g.name, place: g.place, teachers: g.teachers,
        code: g.code, clazz: g.clazz,
        day: Number(g.day), slotStart: Number(g.slotStart), slotEnd: Number(g.slotEnd),
        weekType: seg.type, weekStart: seg.start, weekEnd: seg.end,
        imported: true,
      })
    }
  }
  return out.sort((a, b) => a.day - b.day || a.slotStart - b.slotStart)
}

// 从教务导入的原始周数据中移除场次：scope 'one' 删该条目（同课名+天+节次+地点+教师），'all' 删同名全部
export function removeImportedOccurrence(jwxt, item, scope, week) {
  const weeks = {}
  for (const [zs, occ] of Object.entries((jwxt && jwxt.weeks) || {})) {
    const inScope = scope === 'all' || Number(zs) === week
    weeks[zs] = !inScope
      ? (occ || [])
      : (occ || []).filter(o => {
          if (scope === 'all') return o.name !== item.name
          return !(o.name === item.name && o.day === item.day && o.slotStart === item.slotStart
            && o.slotEnd === item.slotEnd && o.place === item.place && o.teachers === item.teachers)
        })
  }
  return { ...(jwxt || {}), weeks }
}

// 移除一个展示段（编辑导入课程转手动时用）：只删该段周次范围内（按单/双周过滤）同键的场次
export function removeImportedSegment(jwxt, item) {
  const weeks = {}
  for (const [zs, occ] of Object.entries((jwxt && jwxt.weeks) || {})) {
    const w = Number(zs)
    const inSeg = w >= item.weekStart && w <= item.weekEnd
      && (item.weekType === 'odd' ? w % 2 === 1 : item.weekType === 'even' ? w % 2 === 0 : true)
    weeks[zs] = !inSeg
      ? (occ || [])
      : (occ || []).filter(o => !(o.name === item.name && o.day === item.day
          && o.slotStart === item.slotStart && o.slotEnd === item.slotEnd
          && o.place === item.place && o.teachers === item.teachers))
  }
  return { ...(jwxt || {}), weeks }
}

// 场次是否已上完（该周该天 + 实际下课时刻已过）——用于置灰
export function lessonPassed(startDate, week, dayIndex, course, now) {
  const d = dateOfWeekDay(startDate, week, dayIndex)
  if (!d) return false
  const end = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, courseEndMin(course))
  return end.getTime() < now.getTime()
}

// 考试是否已结束（考完变灰）：带日期日程的结束时刻已过
export function eventPassed(ev, now) {
  if (!ev.date || !ev.end) return false
  const t = new Date(`${ev.date}T${ev.end}:00`)
  return !Number.isNaN(t.getTime()) && t.getTime() < now.getTime()
}
