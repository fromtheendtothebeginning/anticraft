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
const STORAGE_KEY = 'campus_timetable'

export function emptyTimetable() {
  return { version: 1, name: '', startDate: '', weekCount: DEFAULT_WEEK_COUNT, courses: [], events: [] }
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
export function minutesToSub(min, isEnd = false) {
  const first = SLOT_TIMES.findIndex(([st]) => minutesOf(st) > min)
  const k = (first === -1 ? SLOT_COUNT : first) - 1
  if (k < 0) return 0
  const frac = ((min - minutesOf(SLOT_TIMES[k][0])) / 45) * SUBS_PER_SLOT
  const f = Math.max(0, Math.min(SUBS_PER_SLOT, isEnd ? Math.ceil(frac) : Math.floor(frac)))
  return k * SUBS_PER_SLOT + f
}

export function fmtMin(min) {
  const p = (n) => String(n).padStart(2, '0')
  return `${p(Math.floor(min / 60))}:${p(min % 60)}`
}

export function dateISOOf(d) {
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
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

// jwxt.weeks = { [周号]: [{name, place, teachers, day, slotStart, slotEnd}] } → 课程条目数组
export function deriveImportedCourses(jwxt) {
  const weeks = (jwxt && jwxt.weeks) || {}
  const groups = new Map()
  for (const zsStr of Object.keys(weeks)) {
    const zs = parseInt(zsStr, 10)
    for (const o of weeks[zsStr] || []) {
      const key = `${o.name}|${o.place}|${o.teachers}|${o.day}|${o.slotStart}|${o.slotEnd}`
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key).push(zs)
    }
  }
  const out = []
  let n = 0
  for (const [key, zsList] of groups) {
    const [name, place, teachers, day, slotStart, slotEnd] = key.split('|')
    const zsListU = [...new Set(zsList)].sort((a, b) => a - b)
    for (const seg of splitWeekRuns(zsListU)) {
      n += 1
      out.push({
        id: `jw-${n}`,
        name, place, teachers,
        day: Number(day), slotStart: Number(slotStart), slotEnd: Number(slotEnd),
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

// 场次是否已上完（该周该天 + 实际下课时刻已过）——用于置灰
export function lessonPassed(startDate, week, dayIndex, course, now) {
  const d = dateOfWeekDay(startDate, week, dayIndex)
  if (!d) return false
  const end = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, courseEndMin(course))
  return end.getTime() < now.getTime()
}
