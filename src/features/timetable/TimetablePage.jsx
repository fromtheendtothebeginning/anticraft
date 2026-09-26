import { useState, useEffect, useMemo, useRef } from 'react'
import { Link } from 'react-router-dom'
import Navbar from '../../components/Navbar'
import Modal from '../../components/Modal'
import { UiIcon } from '../../components/Icons'
import { t } from '../../i18n'
import { apiFetch } from '../../utils/api'
import { emptyTimetable, loadTimetable, saveTimetable, locateToday, deriveImportedCourses, removeImportedOccurrence, eventConflicts, WEEKDAY_LABELS } from './model'
import WeekBoard from './WeekBoard'
import DayList from './DayList'
import WeekNav from './WeekNav'
import { SemesterModal, CourseFormModal, CourseDetailModal, EventFormModal, EventDetailModal } from './modals'
import './TimetablePage.css'

function genId() {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`
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
  // 本地缓存先行渲染，云端合并交给挂载后的同步逻辑（updatedAt 最后写入胜）
  const [tt, setTt] = useState(() => loadTimetable() || emptyTimetable())
  const [view, setView] = useState('week') // week | day
  const [week, setWeek] = useState(1)
  const [day, setDay] = useState(0)
  const [now, setNow] = useState(() => new Date()) // 过期置灰的时间基准，60s 心跳刷新
  const [syncErr, setSyncErr] = useState(false)
  // 周视图节次列是否标注上课时间（本机 UI 偏好，不进云端数据）
  const [showTimes, setShowTimes] = useState(() => localStorage.getItem('campus_timetable_showtimes') === '1')
  // 教务系统导入
  const [importBusy, setImportBusy] = useState(false)
  const [importMsg, setImportMsg] = useState('')
  const [importErr, setImportErr] = useState('')
  const [captchaData, setCaptchaData] = useState(null) // { b64, zs, xnm, xqm }
  const [captchaInput, setCaptchaInput] = useState('')

  const toggleShowTimes = () => {
    setShowTimes(v => {
      localStorage.setItem('campus_timetable_showtimes', v ? '0' : '1')
      return !v
    })
  }

  const [settingsOpen, setSettingsOpen] = useState(false)
  const [editorOpen, setEditorOpen] = useState(false)
  const [editing, setEditing] = useState(null) // null=新增
  const [detail, setDetail] = useState(null)
  const [eventEditorOpen, setEventEditorOpen] = useState(false)
  const [editingEvent, setEditingEvent] = useState(null) // null=新增
  const [eventDetail, setEventDetail] = useState(null)
  const [deleteTarget, setDeleteTarget] = useState(null) // { kind: 'course'|'event', id, name }
  const [eventConflict, setEventConflict] = useState(null) // { entry, conflicts }

  const token = localStorage.getItem('token')
  const ttRef = useRef(tt)
  useEffect(() => { ttRef.current = tt })

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
        const cloud = b.data && Array.isArray(b.data.courses) ? b.data : null
        if (!cloud) return
        const local = ttRef.current || emptyTimetable()
        const localAt = local.updatedAt || 0
        const cloudAt = cloud.updatedAt || 0
        if (cloudAt > localAt) {
          saveTimetable(cloud)
          setTt({ ...emptyTimetable(), ...cloud })
          // 新设备首次采纳云端数据时，同样落到当前周/今天
          const loc = locateToday(cloud.startDate, cloud.weekCount)
          if (loc && loc.week) setWeek(loc.week)
          if (loc) setDay(loc.dayIndex)
        } else if (localAt > cloudAt) {
          pushCloud(local)
        }
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [token])

  const persist = (next) => {
    const withTs = { ...next, updatedAt: Date.now() }
    setTt(withTs)
    saveTimetable(withTs)
    if (token) pushCloud(withTs)
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
    const entry = { ...data, id: data.id || genId() }
    const courses = editing
      ? tt.courses.map(c => (c.id === entry.id ? entry : c))
      : [...tt.courses, entry]
    persist({ ...tt, courses })
    setEditorOpen(false)
    setDetail(null)
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

  // ── 教务系统导入：首次逐周遍历全学期（直到接口报错），之后仅更新当前停留周 ──
  const runImport = async () => {
    const now = new Date()
    const y = now.getFullYear()
    const m = now.getMonth() + 1
    // 正方学期码：3=第一学期(9月~次年1月) / 12=第二学期(2~6月) / 16=短学期(7~8月)
    const xnm = String(m >= 9 ? y : y - 1)
    const xqm = (m >= 9 || m === 1) ? '3' : m <= 6 ? '12' : '16'
    const isFull = !(tt.jwxt && Object.keys(tt.jwxt.weeks || {}).length)
    const weeks = { ...(tt.jwxt?.weeks || {}) }
    let w = isFull ? 1 : week
    let lastWeek = tt.weekCount
    let imported = 0
    let newStart = tt.startDate
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
        setCaptchaData({ b64: b.captcha_base64, zs: w, xnm, xqm })
        setCaptchaInput('')
        return false // 弹验证码；确认后教务会话已建立，重新走导入
      }
      if (!res.ok || !b || !b.ok) {
        if (!isFull) setImportErr((b && b.detail) || t('timetable.importFailed'))
        break // 首次导入：遍历到学期之外（接口报错）为止
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
    const weekCount = isFull ? Math.max(1, lastWeek) : tt.weekCount
    const next = { ...tt, jwxt: { weeks, importedAt: Date.now() }, startDate: newStart || tt.startDate, weekCount }
    persist(next)
    if (isFull) {
      setImportMsg(t('timetable.importDone', { n: imported }))
      const loc = locateToday(next.startDate, next.weekCount)
      if (loc && loc.week) setWeek(loc.week)
      if (loc) setDay(loc.dayIndex)
    }
    return true
  }

  const doImport = async () => {
    if (importBusy) return
    setImportBusy(true)
    setImportErr('')
    try {
      const ok = await runImport()
      if (ok) setSettingsOpen(false) // 从设置弹窗触发时，导入成功直接回到课表
    } finally {
      setImportBusy(false)
    }
  }

  const submitCaptcha = async () => {
    if (!captchaInput.trim() || !captchaData) return
    setImportBusy(true)
    try {
      const res = await apiFetch('/api/timetable/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ zs: captchaData.zs, xnm: captchaData.xnm, xqm: captchaData.xqm, captcha: captchaInput.trim() }),
      })
      const b = await res.json().catch(() => null)
      setCaptchaData(null)
      if (!res.ok || !b || !b.ok) {
        setImportErr((b && b.detail) || t('timetable.importFailed'))
        return
      }
      await runImport() // 教务会话已建立，重新走导入
    } finally {
      setImportBusy(false)
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
            <button type="button" className="btn btn-primary tt-addbtn" onClick={() => { setEditing(null); setEditorOpen(true) }}>
              <UiIcon name="plus" size={13} />
              {t('timetable.addCourse')}
            </button>
            <button type="button" className="btn btn-secondary tt-addbtn" onClick={() => { setEditingEvent(null); setEventEditorOpen(true) }}>
              <UiIcon name="calendar" size={13} />
              {t('timetable.addEvent')}
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

        {tt.courses.length === 0 && (
          <p className="tt-empty">{t('timetable.empty')}<br />{t('timetable.emptyHint')}</p>
        )}
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
        importBusy={importBusy}
        importMsg={importMsg}
        onImport={doImport}
        onSave={(next) => { saveSettings(next); setSettingsOpen(false) }}
        onClose={() => setSettingsOpen(false)}
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
        sessions={detail ? tt.courses.filter(c => c.name === detail.name) : []}
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
