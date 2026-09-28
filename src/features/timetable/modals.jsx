// 课程表弹窗：学期设置 / 课程编辑 / 课程详情 / 日程编辑 / 日程详情
// 草稿状态内聚在各弹窗里，open 时重置；保存时把数据交给页面 persist
// 弹窗内的选择器统一走 CategoryDropdown（popover 模式：fixed 菜单贴按钮弹出，不溢出弹窗底板）
import { useState, useEffect } from 'react'
import Modal from '../../components/Modal'
import ActionButton from '../../components/ActionButton'
import CategoryDropdown from '../../components/CategoryDropdown'
import { UiIcon } from '../../components/Icons'
import { t } from '../../i18n'
import { apiFetch } from '../../utils/api'
import {
  SLOT_TIMES, DEFAULT_WEEK_COUNT, WEEKDAY_LABELS, WEEKDAY_SHORT,
  emptyDraft, courseHue, weekRangeLabel, minutesOf, expandDateRange,
} from './model'
import TimePicker from './TimePicker'

const WEEK_TYPE_OPTIONS = [
  { value: 'all', label: t('timetable.weekTypeAll') },
  { value: 'odd', label: t('timetable.weekTypeOdd') },
  { value: 'even', label: t('timetable.weekTypeEven') },
]

const WEEK_TYPE_LABELS = Object.fromEntries(WEEK_TYPE_OPTIONS.map(o => [o.value, o.label]))

const emptyEventDraft = () => ({
  name: '', place: '', date: '', day: 0,
  start: '12:00', end: '13:00', note: '',
})

// 教务学期码由用户选择：大一上~大四下 ↔ 1-8
const TERM_LABELS = ['大一上', '大一下', '大二上', '大二下', '大三上', '大三下', '大四上', '大四下']

export function SemesterModal({ open, timetable, importBusy, importMsg, term, onTermChange, onImport, onSave, onClose }) {
  const [draft, setDraft] = useState({ name: '', startDate: '', weekCount: DEFAULT_WEEK_COUNT })
  useEffect(() => {
    if (open) setDraft({ name: timetable.name, startDate: timetable.startDate, weekCount: timetable.weekCount })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const save = () => {
    const wc = Math.min(Math.max(1, parseInt(draft.weekCount, 10) || DEFAULT_WEEK_COUNT), 40)
    onSave({ name: draft.name.trim(), startDate: draft.startDate, weekCount: wc })
  }

  return (
    <Modal
      open={open}
      title={t('timetable.settings')}
      confirmText={t('modal.save')}
      onConfirm={save}
      onCancel={onClose}
      confirmDisabled={!draft.startDate}
    >
      <div className="tt-form">
        <label className="tt-field">
          <span>{t('timetable.settingsName')}</span>
          <input
            type="text"
            value={draft.name}
            onChange={e => setDraft({ ...draft, name: e.target.value })}
            placeholder={t('timetable.settingsNamePlaceholder')}
          />
        </label>
        <label className="tt-field">
          <span>{t('timetable.startDate')}</span>
          <input
            type="date"
            value={draft.startDate}
            onChange={e => setDraft({ ...draft, startDate: e.target.value })}
          />
        </label>
        <label className="tt-field">
          <span>{t('timetable.weekCount')}</span>
          <input
            type="number"
            min="1" max="40"
            value={draft.weekCount}
            onChange={e => setDraft({ ...draft, weekCount: e.target.value })}
          />
        </label>
        <div className="tt-import-box">
          <p className="tt-import-box-hint">{t('timetable.importBoxHint')}</p>
          <label className="tt-field">
            <span>{t('timetable.importTerm')}</span>
            <select value={term} onChange={e => onTermChange(e.target.value)} disabled={importBusy}>
              {TERM_LABELS.map((label, i) => (
                <option key={i + 1} value={String(i + 1)}>{label}</option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className="btn btn-secondary tt-import-box-btn"
            onClick={onImport}
            disabled={importBusy}
          >
            {importBusy ? (importMsg || t('timetable.importing')) : t('timetable.importCourse')}
          </button>
        </div>
      </div>
    </Modal>
  )
}

export function CourseFormModal({ open, editing, weekCount, onSave, onClose }) {
  const [draft, setDraft] = useState(() => emptyDraft(weekCount))
  useEffect(() => {
    // imported 标记不进草稿：导入课程保存转手动后，新条目不应再带该标记
    if (open) setDraft(editing ? { ...editing, imported: undefined } : emptyDraft(weekCount))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const valid = draft.name.trim()
    && draft.slotStart <= draft.slotEnd
    && draft.weekStart <= draft.weekEnd
    && draft.weekStart >= 1 && draft.weekEnd <= weekCount

  const save = () => {
    onSave({
      ...draft,
      id: editing ? editing.id : undefined, // 新增时由页面生成 id
      name: draft.name.trim(),
      place: draft.place.trim(),
      teachers: draft.teachers.trim(),
      endAt: draft.slotEnd === 3 ? (draft.endAt || '') : '', // 中午下课覆盖仅对末节=第4节有意义
    })
  }

  return (
    <Modal
      open={open}
      title={editing ? t('timetable.editCourse') : t('timetable.addCourse')}
      confirmText={t('modal.save')}
      onConfirm={save}
      onCancel={onClose}
      confirmDisabled={!valid}
    >
      <div className="tt-form">
        <label className="tt-field">
          <span>{t('timetable.courseName')}</span>
          <input
            type="text"
            value={draft.name}
            onChange={e => setDraft({ ...draft, name: e.target.value })}
            placeholder={t('timetable.courseNamePlaceholder')}
          />
        </label>
        <div className="tt-field-row">
          <label className="tt-field">
            <span>{t('timetable.place')}</span>
            <input
              type="text"
              value={draft.place}
              onChange={e => setDraft({ ...draft, place: e.target.value })}
              placeholder={t('timetable.placePlaceholder')}
            />
          </label>
          <label className="tt-field">
            <span>{t('timetable.teachers')}</span>
            <input
              type="text"
              value={draft.teachers}
              onChange={e => setDraft({ ...draft, teachers: e.target.value })}
              placeholder={t('timetable.teachersPlaceholder')}
            />
          </label>
        </div>
        <div className="tt-field-row">
          <label className="tt-field">
            <span>{t('timetable.day')}</span>
            <CategoryDropdown
              popover
              value={draft.day}
              onChange={v => setDraft({ ...draft, day: v })}
              options={WEEKDAY_LABELS.map((w, i) => ({ value: i, label: w }))}
              hideClear
              closeOnSelect
            />
          </label>
          <label className="tt-field">
            <span>{t('timetable.weekType')}</span>
            <CategoryDropdown
              popover
              value={draft.weekType}
              onChange={v => setDraft({ ...draft, weekType: v })}
              options={WEEK_TYPE_OPTIONS}
              hideClear
              closeOnSelect
            />
          </label>
        </div>
        <label className="tt-field">
          <span>{t('timetable.slot')}</span>
          <div className="tt-slot-inputs">
            <CategoryDropdown
              popover
              value={draft.slotStart}
              onChange={v => setDraft({ ...draft, slotStart: v })}
              options={SLOT_TIMES.map((_, i) => ({ value: i, label: `${i + 1}${t('timetable.slotUnit')}` }))}
              hideClear
              closeOnSelect
            />
            <span className="tt-slot-sep">{t('timetable.to')}</span>
            <CategoryDropdown
              popover
              value={draft.slotEnd}
              onChange={v => setDraft({ ...draft, slotEnd: v })}
              options={SLOT_TIMES.map((_, i) => ({ value: i, label: `${i + 1}${t('timetable.slotUnit')}` }))}
              hideClear
              closeOnSelect
            />
          </div>
        </label>
        {draft.slotEnd === 3 && (
          <label className="tt-field">
            <span>{t('timetable.noonEnd')}</span>
            <CategoryDropdown
              popover
              value={draft.endAt || ''}
              onChange={v => setDraft({ ...draft, endAt: v })}
              options={[
                { value: '', label: t('timetable.noonEndEarly') },
                { value: '11:55', label: t('timetable.noonEndLate') },
              ]}
              hideClear
              closeOnSelect
            />
          </label>
        )}
        <label className="tt-field">
          <span>{t('timetable.weekRange')}</span>
          <div className="tt-slot-inputs">
            <input
              type="number" min="1" max={weekCount}
              value={draft.weekStart}
              onChange={e => setDraft({ ...draft, weekStart: Number(e.target.value) })}
            />
            <span className="tt-slot-sep">{t('timetable.to')}</span>
            <input
              type="number" min="1" max={weekCount}
              value={draft.weekEnd}
              onChange={e => setDraft({ ...draft, weekEnd: Number(e.target.value) })}
            />
          </div>
        </label>
      </div>
    </Modal>
  )
}

export function CourseDetailModal({ open, course, sessions, onEdit, onDelete, onClose }) {
  return (
    <Modal
      open={open}
      title={course ? course.name : ''}
      showConfirm={false}
      showCancel={false}
      onCancel={onClose}
    >
      {course && (
        <div className="tt-detail">
          {sessions.map(c => (
            <div key={c.id} className="tt-detail-item">
              <span className="tt-detail-time" data-hue={courseHue(c.name)}>
                {WEEKDAY_LABELS[c.day]} · {t('timetable.slotLabel', { a: c.slotStart + 1, b: c.slotEnd + 1 })}
                <i>{SLOT_TIMES[c.slotStart][0]}–{SLOT_TIMES[c.slotEnd][1]}</i>
              </span>
              <span className="tt-detail-meta">
                {c.place}
                {c.place && c.teachers ? ' · ' : ''}
                {c.teachers}
              </span>
              {(c.code || c.clazz) && (
                <span className="tt-detail-extras">
                  {[c.code && `${t('timetable.courseCode')} ${c.code}`, c.clazz && `${t('timetable.courseClass')} ${c.clazz}`].filter(Boolean).join(' · ')}
                </span>
              )}
              <span className="tt-detail-weeks">{weekRangeLabel(c, WEEK_TYPE_LABELS)}</span>
            </div>
          ))}
          <div className="modal-actions tt-detail-actions">
            <ActionButton onClick={() => onEdit(course)}>{t('timetable.edit')}</ActionButton>
            <ActionButton variant="danger" onClick={() => onDelete(course)}>{t('timetable.delete')}</ActionButton>
          </div>
          {course.imported && <p className="tt-imported-hint">{t('timetable.importedHint')}</p>}
        </div>
      )}
    </Modal>
  )
}

// ── 日程（自由时间，非节次）──
export function EventFormModal({ open, editing, onSave, onClose }) {
  const [draft, setDraft] = useState(emptyEventDraft())
  useEffect(() => {
    if (open) setDraft(editing ? { ...editing } : emptyEventDraft())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const valid = draft.name.trim()
    && draft.start && draft.end
    && minutesOf(draft.start) < minutesOf(draft.end)

  const save = () => {
    onSave({
      ...draft,
      id: editing ? editing.id : undefined,
      name: draft.name.trim(),
      place: draft.place.trim(),
    })
  }

  return (
    <Modal
      open={open}
      title={editing ? t('timetable.editEvent') : t('timetable.addEvent')}
      confirmText={t('modal.save')}
      onConfirm={save}
      onCancel={onClose}
      confirmDisabled={!valid}
    >
      <div className="tt-form">
        <label className="tt-field">
          <span>{t('timetable.eventName')}</span>
          <input
            type="text"
            value={draft.name}
            onChange={e => setDraft({ ...draft, name: e.target.value })}
            placeholder={t('timetable.eventNamePlaceholder')}
          />
        </label>
        <label className="tt-field">
          <span>{t('timetable.place')}</span>
          <input
            type="text"
            value={draft.place}
            onChange={e => setDraft({ ...draft, place: e.target.value })}
            placeholder={t('timetable.placePlaceholder')}
          />
        </label>
        <div className="tt-field-row">
          <label className="tt-field">
            <span>{t('timetable.eventDate')}</span>
            <input
              type="date"
              value={draft.date}
              onChange={e => setDraft({ ...draft, date: e.target.value })}
            />
          </label>
          <label className="tt-field">
            <span>{t('timetable.eventDay')}</span>
            <CategoryDropdown
              popover
              value={draft.day}
              onChange={v => setDraft({ ...draft, day: v })}
              options={WEEKDAY_LABELS.map((w, i) => ({ value: i, label: w }))}
              hideClear
              closeOnSelect
            />
          </label>
        </div>
        <p className="tt-field-hint">{t('timetable.eventDateHint')}</p>
        <label className="tt-field">
          <span>{t('timetable.eventTime')}</span>
          <div className="tt-slot-inputs">
            <TimePicker
              value={draft.start}
              onChange={v => setDraft({ ...draft, start: v })}
            />
            <span className="tt-slot-sep">{t('timetable.to')}</span>
            <TimePicker
              value={draft.end}
              onChange={v => setDraft({ ...draft, end: v })}
            />
          </div>
        </label>
        <label className="tt-field">
          <span>{t('timetable.eventNote')}</span>
          <textarea
            value={draft.note}
            onChange={e => setDraft({ ...draft, note: e.target.value })}
            placeholder={t('timetable.eventNotePlaceholder')}
          />
        </label>
      </div>
    </Modal>
  )
}

export function EventDetailModal({ open, event, onEdit, onDelete, onClose }) {
  if (!open || !event) return null
  const dateText = event.date
    ? `${Number(event.date.slice(0, 4))}年${Number(event.date.slice(5, 7))}月${Number(event.date.slice(8, 10))}日`
    : `${t('timetable.everyWeek')} · ${WEEKDAY_LABELS[event.day] || ''}`
  return (
    <Modal
      open={open}
      title={event.name}
      showConfirm={false}
      showCancel={false}
      onCancel={onClose}
    >
      <div className="tt-detail">
        <div className="tt-detail-item">
          <span className="tt-detail-time">
            {dateText}
            <i>{event.start}–{event.end}</i>
          </span>
          {event.place && <span className="tt-detail-meta">{event.place}</span>}
          {event.note && <span className="tt-detail-note">{event.note}</span>}
          <span className="tt-detail-weeks">{t('timetable.eventTag')}</span>
        </div>
        <div className="modal-actions tt-detail-actions">
          <ActionButton onClick={() => onEdit(event)}>{t('timetable.edit')}</ActionButton>
          <ActionButton variant="danger" onClick={() => onDelete(event)}>{t('timetable.delete')}</ActionButton>
        </div>
      </div>
    </Modal>
  )
}

// ── 调休设置：放假 / 按周X上课规则列表，支持校历图片 AI 提取（识别不落库，确认后随课表 JSON 保存）──
const emptyAdjustDraft = () => ({ date: '', endDate: '', type: 'off', day: 0 })

// 按日期去重合并（新条目覆盖同日期旧条目）并升序排列
const mergeAdjustments = (prev, entries) => {
  const dateSet = new Set(entries.map(a => a.date))
  return [...prev.filter(a => !dateSet.has(a.date)), ...entries]
    .sort((a, b) => (a.date < b.date ? -1 : 1))
}

export function AdjustModal({ open, timetable, onSave, onClose }) {
  const [list, setList] = useState([])
  const [draft, setDraft] = useState(emptyAdjustDraft())
  const [parsing, setParsing] = useState(false)
  const [parseErr, setParseErr] = useState('')
  // 校历识别的思考深度（独立于 AI 设置里识图模型的全局配置）；visionOpts 为空=未配置识图模型
  const [visionOpts, setVisionOpts] = useState(null)
  const [thinkLevel, setThinkLevel] = useState('')

  useEffect(() => {
    if (open) {
      setList([...(timetable.adjustments || [])].sort((a, b) => (a.date < b.date ? -1 : 1)))
      setDraft(emptyAdjustDraft())
      setParsing(false)
      setParseErr('')
      setThinkLevel(() => { try { return localStorage.getItem('tt.holidayThink') || '' } catch { return '' } })
      // 识图模型的厂商/模型档位（后端按 AI 设置解析；未配置时返回 vision:null，隐藏思考选项）
      // 未登录跳过：apiFetch 收到 401 会跳 /auth，而课程表未登录也可本地使用
      if (localStorage.getItem('token')) {
        apiFetch('/api/timetable/holiday/options')
          .then(r => (r.ok ? r.json() : null))
          .then(b => {
            if (!b || !b.ok || !b.vision) { setVisionOpts(null); return }
            setVisionOpts(b)
            // 记忆的档位不在当前模型可选范围（换过模型/厂商）时回退为跟随默认
            setThinkLevel(cur => {
              const ok = cur === '' || (b.vision.levels || []).some(l => l.value === cur)
              return ok ? cur : ''
            })
          })
          .catch(() => setVisionOpts(null))
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const changeThinkLevel = (v) => {
    setThinkLevel(v)
    try {
      if (v) localStorage.setItem('tt.holidayThink', v)
      else localStorage.removeItem('tt.holidayThink')
    } catch { /* 隐私模式忽略 */ }
  }

  const addRules = () => {
    if (!draft.date) return
    const dates = draft.endDate ? expandDateRange(draft.date, draft.endDate) : [draft.date]
    if (!dates.length) return
    const entries = dates.map(iso => (draft.type === 'off'
      ? { date: iso, type: 'off' }
      : { date: iso, type: 'follow', day: draft.day }))
    setList(prev => mergeAdjustments(prev, entries))
    setDraft(d => ({ ...d, date: '', endDate: '' }))
  }

  const parseImage = async (e) => {
    const file = e.target.files && e.target.files[0]
    e.target.value = '' // 允许重复选择同一文件
    if (!file || parsing) return
    setParsing(true)
    setParseErr('')
    try {
      const b64 = await new Promise((resolve, reject) => {
        const r = new FileReader()
        r.onload = () => resolve(String(r.result))
        r.onerror = () => reject(new Error('read failed'))
        r.readAsDataURL(file)
      })
      const res = await apiFetch('/api/timetable/holiday/parse', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          image_b64: b64,
          mime: file.type || 'image/png',
          start_date: timetable.startDate,
          week_count: timetable.weekCount,
          thinking: thinkLevel, // ''=跟随识图模型配置 / off=关闭 / 厂商档位
        }),
      })
      const b = await res.json().catch(() => null)
      if (!res.ok || !b || !b.ok) {
        const detail = b && b.detail
        setParseErr(typeof detail === 'string' ? detail : (detail && detail.message) || t('timetable.adjParseFail'))
        return
      }
      setList(prev => mergeAdjustments(prev, b.adjustments || []))
    } catch {
      setParseErr(t('timetable.adjParseFail'))
    } finally {
      setParsing(false)
    }
  }

  const adjLabel = (a) => (a.type === 'off'
    ? t('timetable.adjTypeOff')
    : t('timetable.adjTypeFollow', { day: WEEKDAY_LABELS[a.day] || '' }))
  const dateText = (iso) => {
    const d = new Date(`${iso}T00:00:00`)
    if (Number.isNaN(d.getTime())) return iso
    return `${d.getMonth() + 1}/${d.getDate()} 周${WEEKDAY_SHORT[(d.getDay() + 6) % 7]}`
  }

  return (
    <Modal
      open={open}
      title={t('timetable.adjustTitle')}
      confirmText={t('modal.save')}
      onConfirm={() => onSave(list)}
      onCancel={onClose}
    >
      <div className="tt-form">
        <div className="tt-adj-list">
          {list.length === 0 && <p className="tt-field-hint">{t('timetable.adjEmpty')}</p>}
          {list.map(a => (
            <div key={a.date} className="tt-adj-item">
              <span className="tt-adj-date">{dateText(a.date)}</span>
              <span className={`tt-adj-type${a.type === 'off' ? ' is-off' : ''}`}>{adjLabel(a)}</span>
              <button
                type="button"
                className="tt-adj-del"
                aria-label={t('timetable.delete')}
                onClick={() => setList(l => l.filter(x => x.date !== a.date))}
              >
                <UiIcon name="trash" size={13} />
              </button>
            </div>
          ))}
        </div>
        <div className="tt-field-row">
          <label className="tt-field">
            <span>{t('timetable.adjDate')}</span>
            <input
              type="date"
              value={draft.date}
              onChange={e => setDraft({ ...draft, date: e.target.value })}
            />
          </label>
          <label className="tt-field">
            <span>{t('timetable.adjEndDate')}</span>
            <input
              type="date"
              value={draft.endDate}
              onChange={e => setDraft({ ...draft, endDate: e.target.value })}
            />
          </label>
        </div>
        <div className="tt-field-row">
          <label className="tt-field">
            <span>{t('timetable.adjType')}</span>
            <CategoryDropdown
              popover
              value={draft.type}
              onChange={v => setDraft({ ...draft, type: v })}
              options={[
                { value: 'off', label: t('timetable.adjTypeOff') },
                { value: 'follow', label: t('timetable.adjTypeFollowSelect') },
              ]}
              hideClear
              closeOnSelect
            />
          </label>
          {draft.type === 'follow' && (
            <label className="tt-field">
              <span>{t('timetable.adjDay')}</span>
              <CategoryDropdown
                popover
                value={draft.day}
                onChange={v => setDraft({ ...draft, day: v })}
                options={WEEKDAY_LABELS.map((w, i) => ({ value: i, label: w }))}
                hideClear
                closeOnSelect
              />
            </label>
          )}
        </div>
        <p className="tt-field-hint">{t('timetable.adjRangeHint')}</p>
        <div className="tt-adj-actions">
          <button type="button" className="btn btn-secondary" onClick={addRules} disabled={!draft.date}>
            {t('timetable.adjAdd')}
          </button>
          {list.length > 0 && (
            <button type="button" className="btn btn-secondary" onClick={() => setList([])}>
              {t('timetable.adjClear')}
            </button>
          )}
        </div>
        <div className="tt-import-box">
          <p className="tt-import-box-hint">{t('timetable.adjParseHint')}</p>
          {visionOpts && visionOpts.vision && (
            <label className="tt-field">
              <span>{t('timetable.adjThink')}</span>
              <CategoryDropdown
                popover
                value={thinkLevel}
                onChange={changeThinkLevel}
                options={[
                  { value: '', label: t('timetable.adjThinkDefault') },
                  ...(visionOpts.vision.levels || []),
                ]}
                hideClear
                closeOnSelect
              />
            </label>
          )}
          <label className={`btn btn-secondary tt-import-box-btn${parsing ? ' disabled' : ''}`}>
            {parsing ? t('timetable.adjParsing') : t('timetable.adjParseBtn')}
            <input type="file" accept="image/*" hidden disabled={parsing} onChange={parseImage} />
          </label>
          {parseErr && <p className="tt-field-hint tt-adj-err">{parseErr}</p>}
        </div>
      </div>
    </Modal>
  )
}
