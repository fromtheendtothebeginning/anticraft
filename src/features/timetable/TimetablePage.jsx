import { useState, useEffect, useMemo, useRef } from 'react'
import { Link } from 'react-router-dom'
import Navbar from '../../components/Navbar'
import Modal from '../../components/Modal'
import CategoryDropdown from '../../components/CategoryDropdown'
import { UiIcon } from '../../components/Icons'
import { t } from '../../i18n'
import { apiFetch } from '../../utils/api'
import { emptyTimetable, loadStore, saveStore, normalizeStore, semesterLabel, locateToday, deriveImportedCourses, removeImportedOccurrence, removeImportedSegment, eventConflicts, WEEKDAY_LABELS } from './model'
import WeekBoard from './WeekBoard'
import DayList from './DayList'
import WeekNav from './WeekNav'
import { SemesterModal, CourseFormModal, CourseDetailModal, EventFormModal, EventDetailModal, AdjustModal } from './modals'
import './TimetablePage.css'

function genId() {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`
}

// 「大一上~大四下」(1-8) → 正方学期码：以年级（入学学年）锚定学年，奇=上学期(3)/偶=下学期(12)。
// 教务接口的 xqm 是 3/12/16 码，不是 1-8 序号；nj 取自教务响应的年级，无年级时返回 null
function termToSemester(term, nj) {
  const n = parseInt(nj, 10)
  const t = parseInt(term, 10)
  if (!n || !(t >= 1 && t <= 8)) return null
  return { xnm: String(n + Math.floor((t - 1) / 2)), xqm: t % 2 === 1 ? '3' : '12' }
}

// 触摸横滑手势：返回可展开的 touch 事件 props；dx 明显大于 dy 且超过阈值才判定
function useSwipe(onSwipe) {
  const touchRef = useRef(null)
  const onTouchStart = (e) => {
    touchRef.current = { x: e.touches[0].clientX, y: e.touches[0].clientY }
  }
  const onTouchEnd = (e) => {
    const st = touchRef.current
    touchRef.current = null
    if (!st) return
    const dx = e.changedTouches[0].clientX - st.x
    const dy = e.changedTouches[0].clientY - st.y
    if (Math.abs(dx) < 60 || Math.abs(dx) < Math.abs(dy) * 1.5) return
    onSwipe(dx < 0 ? -1 : 1) // -1=向左滑（下一个），1=向右滑（上一个）
  }
  return { onTouchStart, onTouchEnd }
}

export default function TimetablePage() {
  // 多学期存储（store = { nj, active, semesters: { '学年-学期码': 课表 } }）：
  // 本地缓存先行渲染，云端合并交给挂载后的同步逻辑（updatedAt 最后写入胜）
  const [store, setStore] = useState(() => loadStore())
  const [activeKey, setActiveKey] = useState(() => (store && store.active) || '')
  // 当前学期的课表（无数据给空表）；全部数据变更经 persist/persistSemester 走本地 + 云端
  const tt = useMemo(() => (store && store.semesters[activeKey]) || emptyTimetable(), [store, activeKey])
  const [view, setView] = useState('week') // week | day
  const [week, setWeek] = useState(1)
  const [day, setDay] = useState(0)
  const [now, setNow] = useState(() => new Date()) // 过期置灰的时间基准，60s 心跳刷新
  const [syncErr, setSyncErr] = useState(false)
  // 周视图节次列是否标注上课时间（本机 UI 偏好，不进云端数据）
  const [showTimes, setShowTimes] = useState(() => localStorage.getItem('campus_timetable_showtimes') === '1')
  // 教务系统导入（course=课程表 / exam=考试安排；空串=空闲）
  const [importBusyKind, setImportBusyKind] = useState('')
  const importBusy = importBusyKind !== ''
  const [importMsg, setImportMsg] = useState('')
  const [importErr, setImportErr] = useState('')
  // 教务学期码：用户选择大一上~大四下（1-8），记忆上次选择
  const [importTerm, setImportTerm] = useState(() => localStorage.getItem('tt.importTerm') || '3')
  const changeImportTerm = (v) => {
    setImportTerm(v)
    try { localStorage.setItem('tt.importTerm', v) } catch { /* 隐私模式忽略 */ }
  }
  const [captchaData, setCaptchaData] = useState(null) // { b64, zs, xnm, xqm }
  const [captchaInput, setCaptchaInput] = useState('')

  const toggleShowTimes = () => {
    setShowTimes(v => {
      localStorage.setItem('campus_timetable_showtimes', v ? '0' : '1')
      return !v
    })
  }

  const [settingsOpen, setSettingsOpen] = useState(false)
  const [adjustOpen, setAdjustOpen] = useState(false)
  const [editorOpen, setEditorOpen] = useState(false)
  const [editing, setEditing] = useState(null) // null=新增
  const [detail, setDetail] = useState(null)
  const [eventEditorOpen, setEventEditorOpen] = useState(false)
  const [editingEvent, setEditingEvent] = useState(null) // null=新增
  const [eventDetail, setEventDetail] = useState(null)
  const [deleteTarget, setDeleteTarget] = useState(null) // { kind: 'course'|'event', id, name }
  const [eventConflict, setEventConflict] = useState(null) // { entry, conflicts }

  const token = localStorage.getItem('token')
  const storeRef = useRef(store)
  useEffect(() => { storeRef.current = store })

  useEffect(() => {
    const loc = locateToday(tt.startDate, tt.weekCount)
    setWeek(loc && loc.week ? loc.week : 1)
    setDay(loc ? loc.dayIndex : 0)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 过期置灰的分钟级心跳
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 60000)
    return () => clearInterval(timer)
  }, [])

  // ── 云端同步：拉取后按 updatedAt 合并，本地较新则回推 ──
  const pushCloud = (data) => {
    apiFetch('/api/timetable', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data }),
    })
      .then(r => { if (!r.ok) throw new Error('sync failed'); setSyncErr(false) })
      .catch(() => setSyncErr(true))
  }

  useEffect(() => {
    if (!token) return
    let cancelled = false
    apiFetch('/api/timetable')
      .then(r => (r.ok ? r.json() : null))
      .then(b => {
        if (cancelled || !b) return
        const cloud = normalizeStore(b.data)
        if (!cloud) return
        const local = storeRef.current
        const localAt = (local && local.updatedAt) || 0
        const cloudAt = cloud.updatedAt || 0
        if (cloudAt > localAt) {
          saveStore(cloud)
          setStore(cloud)
          setActiveKey(cloud.active)
          // 新设备首次采纳云端数据时，同样落到当前周/今天
          const sem = cloud.semesters[cloud.active] || emptyTimetable()
          const loc = locateToday(sem.startDate, sem.weekCount)
          if (loc && loc.week) setWeek(loc.week)
          if (loc) setDay(loc.dayIndex)
        } else if (local && localAt > cloudAt) {
          pushCloud(local)
        }
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [token])

  // 写入指定学期课表（activate=true 时切到该学期），本地 + 云端一次更新
  const persistSemester = (key, sem, activate, nj) => {
    const base = storeRef.current || { version: 1, nj: '', active: key, semesters: {}, updatedAt: 0 }
    const nextStore = {
      ...base,
      nj: base.nj || nj || sem.nj || '',
      semesters: { ...base.semesters, [key]: sem },
      active: activate ? key : (base.active || key),
      updatedAt: Date.now(),
    }
    setStore(nextStore)
    if (activate) setActiveKey(key)
    saveStore(nextStore)
    if (token) pushCloud(nextStore)
  }

  // 写入当前学期课表（所有手动编辑的统一出口）
  const persist = (next) => {
    persistSemester(activeKey, { ...next, updatedAt: Date.now() }, false)
  }

  // ── 学期切换：多份课表并存，切换后落到该学期的今天/第 1 周 ──
  const switchSemester = (key) => {
    if (!store || !key || key === activeKey || !store.semesters[key]) return
    const nextStore = { ...store, active: key, updatedAt: Date.now() }
    setActiveKey(key)
    setStore(nextStore)
    saveStore(nextStore)
    if (token) pushCloud(nextStore)
    const sem = nextStore.semesters[key] || emptyTimetable()
    const loc = locateToday(sem.startDate, sem.weekCount)
    setWeek(loc && loc.week ? loc.week : 1)
    setDay(loc ? loc.dayIndex : 0)
  }

  const today = useMemo(() => locateToday(tt.startDate, tt.weekCount), [tt.startDate, tt.weekCount])
  const clampWeek = (w) => Math.min(Math.max(1, w), tt.weekCount)
  // 教务导入的原始周数据 → 合并成展示用课程条目，与手动课程并列渲染
  const importedCourses = useMemo(() => deriveImportedCourses(tt.jwxt), [tt.jwxt])
  const displayTt = useMemo(() => ({ ...tt, courses: [...tt.courses, ...importedCourses] }), [tt, importedCourses])
  // 不在今天的位置时，底栏周次标签带提示点（点击回到今天）
  const offToday = !!(today && today.week && (week !== today.week || (view === 'day' && day !== today.dayIndex)))

  // ── 滑动切周 / 切天 ──
  const handleSwipe = (dir) => {
    if (view === 'week') {
      setWeek(w => clampWeek(w - dir))
      return
    }
    if (dir === -1) {
      if (day < 6) setDay(day + 1)
      else if (week < tt.weekCount) { setWeek(week + 1); setDay(0) }
    } else {
      if (day > 0) setDay(day - 1)
      else if (week > 1) { setWeek(week - 1); setDay(6) }
    }
  }
  const swipe = useSwipe(handleSwipe)

  const backToday = () => {
    if (!today) return
    if (today.week) setWeek(today.week)
    setDay(today.dayIndex)
  }

  // ── 数据变更（全部经 persist 走本地 + 云端）──
  const saveSettings = (next) => {
    persist({ ...tt, ...next })
    // 设好学期起点后直接落到当前周/今天，免去手动翻页
    const loc = locateToday(next.startDate, next.weekCount)
    if (loc && loc.week) setWeek(loc.week)
    else setWeek(w => Math.min(w, next.weekCount))
    if (loc) setDay(loc.dayIndex)
  }

  const saveCourse = (data) => {
    // 教务导入的课程：保存即转为手动课程——从原始周数据移除该段场次，新建同周次的手动条目
    if (editing && editing.imported) {
      persist({
        ...tt,
        courses: [...tt.courses, { ...data, id: genId() }],
        jwxt: removeImportedSegment(tt.jwxt, editing),
      })
      setEditorOpen(false)
      setDetail(null)
      return
    }
    const entry = { ...data, id: data.id || genId() }
    const courses = editing
      ? tt.courses.map(c => (c.id === entry.id ? entry : c))
      : [...tt.courses, entry]
    persist({ ...tt, courses })
    setEditorOpen(false)
    setDetail(null)
  }

  const saveAdjust = (adjustments) => {
    persist({ ...tt, adjustments })
    setAdjustOpen(false)
  }

  const saveEvent = (data, force = false) => {
    const entry = { ...data, id: data.id || genId() }
    const conflicts = eventConflicts(displayTt, entry) // 检测范围含教务导入的课程
    if (!force && conflicts.length > 0) {
      setEventConflict({ entry, conflicts })
      return
    }
    const events = editingEvent
      ? (tt.events || []).map(ev => (ev.id === entry.id ? entry : ev))
      : [...(tt.events || []), entry]
    persist({ ...tt, events })
    setEventEditorOpen(false)
    setEventDetail(null)
    setEventConflict(null)
  }

  // 冲突处理：删除冲突项后保存新日程 / 全部保留
  const resolveConflict = (replace) => {
    const { entry, conflicts } = eventConflict
    const removeIds = replace ? new Set(conflicts.map(cf => cf.item.id)) : new Set()
    const entryFinal = { ...entry, id: entry.id || genId() }
    let jwxt = tt.jwxt
    const courses = tt.courses.filter(c => !removeIds.has(c.id))
    let events = editingEvent
      ? (tt.events || []).map(ev => (ev.id === entryFinal.id ? entryFinal : ev))
      : [...(tt.events || []), entryFinal]
    events = events.filter(ev => !removeIds.has(ev.id))
    // 教务导入的冲突场次：从原始周数据移除
    for (const cf of conflicts) {
      if (cf.kind === 'course' && cf.item.imported) {
        jwxt = removeImportedOccurrence(jwxt, cf.item, 'one')
      }
    }
    persist({ ...tt, jwxt, courses, events })
    setEventConflict(null)
    setEventEditorOpen(false)
    setEventDetail(null)
  }

  const removeEntry = (target, scope = 'week') => {
    if (target.kind === 'event') {
      persist({ ...tt, events: (tt.events || []).filter(ev => ev.id !== target.id) })
      setEventDetail(null)
      setDeleteTarget(null)
      return
    }
    if (scope === 'all') {
      // 删除这门课：手动同名场次 + 教务导入的同名场次全部移除
      persist({
        ...tt,
        courses: tt.courses.filter(c => c.name !== target.name),
        jwxt: removeImportedOccurrence(tt.jwxt, target, 'all'),
      })
      setDetail(null)
      setDeleteTarget(null)
      return
    }
    // 仅删除本周这一次
    if (target.imported) {
      persist({ ...tt, jwxt: removeImportedOccurrence(tt.jwxt, target, 'week', week) })
    } else {
      // 手动课程按周次范围拆分（单周课程直接移除）
      const parts = []
      if (target.weekStart < week) parts.push({ ...target, id: genId(), weekEnd: week - 1 })
      if (week < target.weekEnd) parts.push({ ...target, id: genId(), weekStart: week + 1 })
      persist({ ...tt, courses: tt.courses.flatMap(c => (c.id === target.id ? parts : [c])) })
    }
    setDetail(null)
    setDeleteTarget(null)
  }

  // ── 教务系统导入：目标学期=所选学期（已知年级精确换算，未知先按当前日期猜、响应年级纠正）。
  //    目标学期无数据或今天不在其范围内 → 逐周遍历全量重导；范围内仅刷新停留周/今天所在周 ──
  const runImport = async () => {
    const now = new Date()
    const y = now.getFullYear()
    const m = now.getMonth() + 1
    const known = termToSemester(importTerm, store && store.nj)
    let xnm = known ? known.xnm : String(m >= 9 ? y : y - 1)
    let xqm = known ? known.xqm : (Number(importTerm) % 2 === 1 ? '3' : '12')
    let targetKey = `${xnm}-${xqm}`
    let targetSem = (store && store.semesters[targetKey]) || emptyTimetable()
    let nj = (store && store.nj) || ''
    let loc = locateToday(targetSem.startDate, targetSem.weekCount)
    let isFull = !(targetSem.jwxt && Object.keys(targetSem.jwxt.weeks || {}).length) || !(loc && loc.week)
    let weeks = isFull ? {} : { ...(targetSem.jwxt?.weeks || {}) }
    let w = isFull ? 1 : (targetKey === activeKey ? week : loc.week)
    let lastWeek = targetSem.weekCount
    let imported = 0
    let newStart = targetSem.startDate
    let anchored = !!known
    let vpnRetry = 0
    for (;;) {
      const res = await apiFetch('/api/timetable/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ zs: w, xnm, xqm }),
      })
      const b = await res.json().catch(() => null)
      if (b && b.vpn_connecting) {
        vpnRetry += 1
        // VPN 建立需要 1-2 分钟，耐心轮询 2 分钟再放弃
        if (vpnRetry > 20) { setImportErr(t('timetable.importVpnFail')); break }
        setImportMsg(t('campusService.vpnAutoConnecting'))
        await new Promise(r => setTimeout(r, 6000))
        continue
      }
      if (b && b.need_captcha) {
        setCaptchaData({ b64: b.captcha_base64, kind: 'course', zs: w, xnm, xqm })
        setCaptchaInput('')
        return false // 弹验证码；确认后教务会话已建立，重新走导入
      }
      if (!res.ok || !b || !b.ok) {
        if (!isFull) setImportErr((b && b.detail) || t('timetable.importFailed'))
        break // 全量导入：遍历到学期之外（接口报错）为止
      }
      if (!anchored && b.nj) {
        anchored = true
        nj = b.nj
        const want = termToSemester(importTerm, b.nj)
        if (want && (want.xnm !== xnm || want.xqm !== xqm)) {
          // 年级纠正了学期：换正确学期码，目标学期改为全量遍历（此刻还没写入任何数据）
          xnm = want.xnm
          xqm = want.xqm
          targetKey = `${xnm}-${xqm}`
          targetSem = (store && store.semesters[targetKey]) || emptyTimetable()
          isFull = true
          weeks = {}
          w = 1
          lastWeek = targetSem.weekCount
          newStart = targetSem.startDate
          continue
        }
      }
      weeks[w] = b.courses || []
      imported += 1
      lastWeek = w
      if (isFull && w === 1) {
        const mon = (b.dates || []).find(dd => String(dd.xqj) === '1')
        if (mon && mon.rq) newStart = mon.rq // 第 1 周周一 = 学期起点
      }
      if (!isFull) { setImportMsg(t('timetable.importUpdateDone', { n: w })); break }
      setImportMsg(t('timetable.importWeekProgress', { n: w + 1 }))
      w += 1
      if (w > 40) break
    }
    if (imported === 0) {
      if (isFull) setImportErr(t('timetable.importFailed'))
      return false
    }
    const weekCount = isFull ? Math.max(1, lastWeek) : targetSem.weekCount
    const next = {
      ...targetSem,
      nj,
      jwxt: { weeks, importedAt: Date.now() },
      startDate: newStart || targetSem.startDate,
      weekCount,
    }
    persistSemester(targetKey, next, true, nj) // 导入完成切到该学期
    if (isFull) {
      setImportMsg(t('timetable.importDone', { n: imported }))
      const after = locateToday(next.startDate, next.weekCount)
      if (after && after.week) setWeek(after.week)
      if (after) setDay(after.dayIndex)
    }
    return true
  }

  const doImport = async () => {
    if (importBusy) return
    setImportBusyKind('course')
    setImportErr('')
    try {
      const ok = await runImport()
      if (ok) setSettingsOpen(false) // 从设置弹窗触发时，导入成功直接回到课表
    } finally {
      setImportBusyKind('')
    }
  }

  // ── 教务系统考试导入：按所选学期精确查询（上学期=3/下学期=12，已知年级精确换算），
  //    考试转为该学期的带日期日程事件（重导按 日期+课名+时间 去重），完成后切到该学期 ──
  const runExamImport = async () => {
    const now = new Date()
    const y = now.getFullYear()
    const m = now.getMonth() + 1
    const known = termToSemester(importTerm, store && store.nj)
    const xnm = known ? known.xnm : String(m >= 9 ? y : y - 1)
    const xqm = known ? known.xqm : (Number(importTerm) % 2 === 1 ? '3' : '12')
    const targetKey = `${xnm}-${xqm}`
    let vpnRetry = 0
    for (;;) {
      const res = await apiFetch('/api/timetable/exams/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ xnm, xqm }),
      })
      const b = await res.json().catch(() => null)
      if (b && b.vpn_connecting) {
        vpnRetry += 1
        // VPN 建立需要 1-2 分钟，耐心轮询 2 分钟再放弃
        if (vpnRetry > 20) { setImportErr(t('timetable.importVpnFail')); return false }
        setImportMsg(t('campusService.vpnAutoConnecting'))
        await new Promise(r => setTimeout(r, 6000))
        continue
      }
      if (b && b.need_captcha) {
        setCaptchaData({ b64: b.captcha_base64, kind: 'exam' })
        setCaptchaInput('')
        return false // 弹验证码；确认后教务会话已建立，重新走导入
      }
      if (!res.ok || !b || !b.ok) {
        setImportErr((b && b.detail) || t('timetable.importFailed'))
        return false
      }
      const targetSem = (store && store.semesters[targetKey]) || emptyTimetable()
      const exams = b.exams || []
      // 只导入落在该学期课表范围内的考试（该学期还没导入课程时没有范围，全部收下）
      let inRange = exams
      let skipped = 0
      if (targetSem.startDate) {
        const from = new Date(`${targetSem.startDate}T00:00:00`).getTime()
        const to = from + (parseInt(targetSem.weekCount, 10) || 0) * 7 * 86400000
        inRange = exams.filter(x => {
          const d = new Date(`${x.date}T00:00:00`).getTime()
          return d >= from && d < to
        })
        skipped = exams.length - inRange.length
      }
      const existed = new Set((targetSem.events || []).map(ev => `${ev.date}|${ev.name}|${ev.start}|${ev.end}`))
      const fresh = []
      for (const e of inRange) {
        const key = `${e.date}|${e.name}|${e.start}|${e.end}`
        if (existed.has(key)) continue
        existed.add(key)
        fresh.push({
          id: genId(),
          name: e.name,
          place: e.place || '',
          date: e.date,
          day: (new Date(`${e.date}T00:00:00`).getDay() + 6) % 7,
          start: e.start,
          end: e.end,
          note: [e.ksmc, e.seat ? `${t('timetable.examSeat')} ${e.seat}` : ''].filter(Boolean).join(' · '),
        })
      }
      persistSemester(targetKey, { ...targetSem, events: [...(targetSem.events || []), ...fresh] }, true)
      setImportMsg(t('timetable.examImportDone', {
        sem: semesterLabel(targetKey, (store && store.nj) || ''),
        total: inRange.length, n: fresh.length,
      }) + (skipped > 0 ? t('timetable.examSkippedOther', { k: skipped }) : ''))
      return true
    }
  }

  const doExamImport = async () => {
    if (importBusy) return
    setImportBusyKind('exam')
    setImportErr('')
    try {
      const ok = await runExamImport()
      if (ok) setSettingsOpen(false) // 导入成功直接回到课表看考试落位
    } finally {
      setImportBusyKind('')
    }
  }

  const submitCaptcha = async () => {
    if (!captchaInput.trim() || !captchaData) return
    const isExam = captchaData.kind === 'exam'
    setImportBusyKind(isExam ? 'exam' : 'course')
    try {
      const res = await apiFetch(isExam ? '/api/timetable/exams/import' : '/api/timetable/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(isExam
          ? { captcha: captchaInput.trim() }
          : { zs: captchaData.zs, xnm: captchaData.xnm, xqm: captchaData.xqm, captcha: captchaInput.trim() }),
      })
      const b = await res.json().catch(() => null)
      setCaptchaData(null)
      if (!res.ok || !b || !b.ok) {
        setImportErr((b && b.detail) || t('timetable.importFailed'))
        return
      }
      // 教务会话已建立，重新走导入
      if (isExam) await runExamImport()
      else await runImport()
    } finally {
      setImportBusyKind('')
    }
  }

  return (
    <div className="tool-page tt-page">
      <Navbar activePage="tools" />
      <div className="tool-main">
        <header className="tool-header">
          <Link to="/tools/campus-service" className="tool-back">{t('timetable.backToCampus')}</Link>
          <h1 className="tool-title">{t('timetable.title')}</h1>
          <p className="tool-subtitle">{t('timetable.subtitle')}</p>
        </header>

        {!token && (
          <div className="tool-login-hint">
            {t('campusService.needLogin')}<Link to="/auth">{t('campusService.goAuth')}</Link>
          </div>
        )}

        <div className="tt-toolbar">
          <div className="tt-viewtoggle">
            <button
              type="button"
              className={view === 'week' ? 'active' : ''}
              onClick={() => setView('week')}
            >{t('timetable.viewWeek')}</button>
            <button
              type="button"
              className={view === 'day' ? 'active' : ''}
              onClick={() => setView('day')}
            >{t('timetable.viewDay')}</button>
          </div>
          <div className="tt-actions">
            {store && Object.keys(store.semesters).length > 0 && (
              <div className="tt-semdd" title={t('timetable.switchSemester')}>
                <CategoryDropdown
                  popover
                  closeOnSelect
                  hideClear
                  value={activeKey}
                  onChange={switchSemester}
                  options={Object.keys(store.semesters).map(k => ({ value: k, label: semesterLabel(k, store.nj) }))}
                />
              </div>
            )}
            <button type="button" className="btn btn-primary tt-addbtn" onClick={() => { setEditing(null); setEditorOpen(true) }}>
              <UiIcon name="plus" size={13} />
              {t('timetable.addCourse')}
            </button>
            <button type="button" className="btn btn-secondary tt-addbtn" onClick={() => { setEditingEvent(null); setEventEditorOpen(true) }}>
              <UiIcon name="calendar" size={13} />
              {t('timetable.addEvent')}
            </button>
            <button type="button" className="btn btn-secondary tt-addbtn" onClick={() => setAdjustOpen(true)}>
              <UiIcon name="swap" size={13} />
              {t('timetable.adjustBtn')}
            </button>
            <button
              type="button"
              className={`tt-iconbtn${showTimes ? ' active' : ''}`}
              title={t('timetable.showTimes')}
              aria-label={t('timetable.showTimes')}
              aria-pressed={showTimes}
              onClick={toggleShowTimes}
            >
              <UiIcon name="clock" size={16} />
            </button>
            <button
              type="button"
              className="tt-iconbtn"
              title={t('timetable.settings')}
              aria-label={t('timetable.settings')}
              onClick={() => setSettingsOpen(true)}
            >
              <UiIcon name="sliders" size={16} />
            </button>
          </div>
        </div>

        {syncErr && <div className="tool-error">{t('timetable.cloudSyncFailed')}</div>}
        {importErr && <div className="tool-error">{importErr}</div>}
        {importMsg && !importErr && <p className="tt-importmsg">{importMsg}</p>}
        {!tt.startDate && (
          <div className="tool-error">{t('timetable.needSetup')}</div>
        )}

        {view === 'week'
          ? <WeekBoard timetable={displayTt} week={week} today={today} now={now} showTimes={showTimes} onPick={setDetail} onPickEvent={setEventDetail} swipe={swipe} />
          : <DayList timetable={displayTt} week={week} day={day} today={today} now={now} onSetDay={setDay} onPick={setDetail} onPickEvent={setEventDetail} swipe={swipe} />}

        <p className="tt-localhint">{token ? t('timetable.syncHint') : t('timetable.savedLocally')}</p>

        <WeekNav
          week={week}
          weekCount={tt.weekCount}
          offToday={offToday}
          onPrev={() => setWeek(w => clampWeek(w - 1))}
          onNext={() => setWeek(w => clampWeek(w + 1))}
          onBackToday={backToday}
        />
      </div>

      <SemesterModal
        open={settingsOpen}
        timetable={tt}
        busyKind={importBusyKind}
        importMsg={importMsg}
        term={importTerm}
        onTermChange={changeImportTerm}
        onImport={doImport}
        onImportExams={doExamImport}
        onSave={(next) => { saveSettings(next); setSettingsOpen(false) }}
        onClose={() => setSettingsOpen(false)}
      />

      <AdjustModal
        open={adjustOpen}
        timetable={tt}
        onSave={saveAdjust}
        onClose={() => setAdjustOpen(false)}
      />

      <CourseFormModal
        open={editorOpen}
        editing={editing}
        weekCount={tt.weekCount}
        onSave={saveCourse}
        onClose={() => setEditorOpen(false)}
      />

      <CourseDetailModal
        open={!!detail}
        course={detail}
        sessions={detail ? displayTt.courses.filter(c => c.name === detail.name) : []}
        onEdit={(course) => { setDetail(null); setEditing(course); setEditorOpen(true) }}
        onDelete={(c) => setDeleteTarget({ ...c, kind: 'course' })}
        onClose={() => setDetail(null)}
      />

      <EventFormModal
        open={eventEditorOpen}
        editing={editingEvent}
        onSave={saveEvent}
        onClose={() => setEventEditorOpen(false)}
      />

      <EventDetailModal
        open={!!eventDetail}
        event={eventDetail}
        onEdit={(ev) => { setEventDetail(null); setEditingEvent(ev); setEventEditorOpen(true) }}
        onDelete={(ev) => setDeleteTarget({ ...ev, kind: 'event' })}
        onClose={() => setEventDetail(null)}
      />

      {/* 教务导入验证码 */}
      <Modal
        open={!!captchaData}
        title={t('timetable.importCaptcha')}
        confirmText={t('modal.confirm')}
        onConfirm={submitCaptcha}
        onCancel={() => setCaptchaData(null)}
        confirmDisabled={!captchaInput.trim() || importBusy}
      >
        <div className="tt-form">
          {captchaData && (
            <img
              className="tt-captcha-img"
              src={`data:image/png;base64,${captchaData.b64}`}
              alt={t('timetable.importCaptcha')}
            />
          )}
          <input
            type="text"
            value={captchaInput}
            onChange={e => setCaptchaInput(e.target.value)}
            placeholder={t('timetable.importCaptchaPlaceholder')}
          />
        </div>
      </Modal>

      {/* 删除确认：课程可选「本次 / 全部场次」，日程单删 */}
      <Modal
        open={!!deleteTarget}
        title={deleteTarget && deleteTarget.kind === 'event' ? t('timetable.deleteEventTitle') : t('timetable.deleteConfirmTitle')}
        showConfirm={false}
        showCancel={false}
        onCancel={() => setDeleteTarget(null)}
      >
        {deleteTarget && (
          <div className="tt-del">
            <p className="tt-del-msg">
              {deleteTarget.kind === 'event'
                ? t('timetable.eventDeleteConfirmMsg', { name: deleteTarget.name })
                : t('timetable.deleteConfirmMsg', { name: deleteTarget.name })}
            </p>
            {deleteTarget.kind === 'event' ? (
              <div className="tt-del-choices">
                <button type="button" className="btn btn-danger" onClick={() => removeEntry(deleteTarget)}>{t('timetable.delete')}</button>
                <button type="button" className="btn btn-secondary" onClick={() => setDeleteTarget(null)}>{t('modal.cancel')}</button>
              </div>
            ) : (
              <div className="tt-del-choices">
                <button type="button" className="btn btn-danger" onClick={() => removeEntry(deleteTarget, 'week')}>{t('timetable.deleteWeekOne')}</button>
                <button type="button" className="btn btn-danger" onClick={() => removeEntry(deleteTarget, 'all')}>{t('timetable.deleteAllSessions')}</button>
                <button type="button" className="btn btn-secondary" onClick={() => setDeleteTarget(null)}>{t('modal.cancel')}</button>
              </div>
            )}
          </div>
        )}
      </Modal>

      {/* 日程时间冲突处理 */}
      <Modal
        open={!!eventConflict}
        title={t('timetable.conflictTitle')}
        showConfirm={false}
        showCancel={false}
        onCancel={() => setEventConflict(null)}
      >
        {eventConflict && (
          <div className="tt-conflict">
            <p className="tt-conflict-head">{t('timetable.conflictHead')}</p>
            {eventConflict.conflicts.map(cf => (
              <div key={cf.kind + cf.item.id} className="tt-conflict-item">
                <span className="tt-conflict-kind">{t(cf.kind === 'course' ? 'timetable.conflictCourse' : 'timetable.conflictEvent')}</span>
                <span className="tt-conflict-name">{cf.item.name}</span>
                <span className="tt-conflict-time">
                  {cf.kind === 'course'
                    ? `${WEEKDAY_LABELS[cf.item.day]} ${t('timetable.slotLabel', { a: cf.item.slotStart + 1, b: cf.item.slotEnd + 1 })}`
                    : `${WEEKDAY_LABELS[cf.item.day]} ${cf.item.start}–${cf.item.end}`}
                </span>
              </div>
            ))}
            <div className="tt-conflict-actions">
              <button type="button" className="btn btn-danger" onClick={() => resolveConflict(true)}>{t('timetable.conflictReplace')}</button>
              <button type="button" className="btn btn-secondary" onClick={() => resolveConflict(false)}>{t('timetable.conflictKeepAll')}</button>
              <button type="button" className="btn btn-secondary" onClick={() => { setEventConflict(null); setEventEditorOpen(false) }}>{t('timetable.conflictDiscard')}</button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  )
}
