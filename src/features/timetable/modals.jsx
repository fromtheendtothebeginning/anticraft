// 课程表弹窗：学期设置 / 课程编辑 / 课程详情 / 日程编辑 / 日程详情
// 草稿状态内聚在各弹窗里，open 时重置；保存时把数据交给页面 persist
// 弹窗内的选择器统一走 CategoryDropdown（popover 模式：fixed 菜单贴按钮弹出，不溢出弹窗底板）
import { useState, useEffect } from 'react'
import Modal from '../../components/Modal'
import ActionButton from '../../components/ActionButton'
import CategoryDropdown from '../../components/CategoryDropdown'
import { t } from '../../i18n'
import {
  SLOT_TIMES, DEFAULT_WEEK_COUNT, WEEKDAY_LABELS,
  emptyDraft, courseHue, weekRangeLabel, minutesOf,
} from './model'

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
    if (open) setDraft(editing ? { ...editing } : emptyDraft(weekCount))
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
              <span className="tt-detail-weeks">{weekRangeLabel(c, WEEK_TYPE_LABELS)}</span>
            </div>
          ))}
          <div className="modal-actions tt-detail-actions">
            {!course.imported && <ActionButton onClick={() => onEdit(course)}>{t('timetable.edit')}</ActionButton>}
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
            <input
              type="time"
              value={draft.start}
              onChange={e => setDraft({ ...draft, start: e.target.value })}
            />
            <span className="tt-slot-sep">{t('timetable.to')}</span>
            <input
              type="time"
              value={draft.end}
              onChange={e => setDraft({ ...draft, end: e.target.value })}
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
