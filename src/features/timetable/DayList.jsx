// 日视图 —— 星期 tab + 按时间排列的课程/日程行
// 时段标题（上午/下午/晚上）与午餐/晚餐分隔按当天实际课程计算：
// 分隔线显示「上一节课下课 → 下一节上课」的真实时间，不同的课中午下课时间不同时会自适应
import { t } from '../../i18n'
import {
  SLOT_TIMES, SECTIONS, WEEKDAY_SHORT, WEEKDAY_LABELS,
  dateOfWeekDay, dateISOOf, coursesOfDay, courseHue, lessonPassed, weekRangeLabel,
  minutesOf, fmtMin, sectionOfSlot, eventOnDay, courseEndMin, adjustmentOnDate,
} from './model'

const WEEK_TYPE_LABELS = {
  all: t('timetable.weekTypeAll'),
  odd: t('timetable.weekTypeOdd'),
  even: t('timetable.weekTypeEven'),
}

// 条目所属时段：课程按起始节次；日程按开始时间与时段分界（13:00 / 18:00）比较
function sectionOfItem(item) {
  if (item.kind === 'course') return sectionOfSlot(item.c.slotStart)
  const noonStart = minutesOf(SLOT_TIMES[4][0])
  const eveningStart = minutesOf(SLOT_TIMES[8][0])
  if (item.startMin < noonStart) return SECTIONS[0]
  if (item.startMin < eveningStart) return SECTIONS[1]
  return SECTIONS[2]
}

export default function DayList({ timetable, week, day, today, now, onSetDay, onPick, onPickEvent, swipe }) {
  const items = []
  const colDate = dateOfWeekDay(timetable.startDate, week, day)
  const colISO = colDate ? dateISOOf(colDate) : ''
  // 调休：off=放假无课；follow=按指定星期取课（置灰仍按当天真实日期判断）
  const adj = adjustmentOnDate(timetable.adjustments, colISO)
  const effDay = adj ? (adj.type === 'off' ? null : adj.day) : day
  if (timetable.startDate && effDay != null) {
    for (const c of coursesOfDay(timetable, week, effDay)) {
      items.push({ kind: 'course', c, startMin: minutesOf(SLOT_TIMES[c.slotStart][0]), endMin: courseEndMin(c) })
    }
  }
  for (const ev of timetable.events || []) {
    if (adj && adj.type === 'off' && !ev.date) continue // 放假：按星期重复的日程当天不显示
    if (eventOnDay(ev, colISO, day)) {
      items.push({ kind: 'event', ev, startMin: minutesOf(ev.start), endMin: minutesOf(ev.end) })
    }
  }
  items.sort((a, b) => a.startMin - b.startMin)

  const rows = []
  let prevSecIndex = -1
  let prevEndMin = null
  for (const it of items) {
    const sec = sectionOfItem(it)
    if (prevSecIndex === -1) {
      rows.push(
        <div key={`sec-${sec.key}`} className="tt-sechead">
          <span>{t(`timetable.${sec.labelKey}`)}</span>
        </div>,
      )
    } else if (sec.index > prevSecIndex) {
      // 跨时段：分隔线标注时段名与真实空档（上一节下课 → 这一节上课）
      const mealKey = sec.key === 'afternoon' ? 'timetable.lunch' : 'timetable.dinner'
      const range = prevEndMin != null ? ` ${fmtMin(prevEndMin)}–${fmtMin(it.startMin)}` : ''
      rows.push(
        <div key={`sec-${sec.key}`} className="tt-meal">
          <span className="tt-secname">{t(`timetable.${sec.labelKey}`)}</span>
          <span>{t(mealKey)}{range}</span>
        </div>,
      )
    }
    prevSecIndex = sec.index
    prevEndMin = it.endMin

    if (it.kind === 'course') {
      const c = it.c
      const past = lessonPassed(timetable.startDate, week, day, c, now)
      rows.push(
        <button type="button" key={c.id} className={`tt-dayrow${past ? ' past' : ''}`} onClick={() => onPick(c)}>
          <span className="tt-dayrow-time" data-hue={courseHue(c.name)}>
            <b>{SLOT_TIMES[c.slotStart][0]}</b>
            <i>{fmtMin(courseEndMin(c))}</i>
          </span>
          <span className="tt-dayrow-card" data-hue={courseHue(c.name)}>
            <span className="tt-dayrow-name">
              {c.name}
              <em>{t('timetable.slotLabel', { a: c.slotStart + 1, b: c.slotEnd + 1 })}</em>
            </span>
            <span className="tt-dayrow-meta">
              {c.place}
              {c.place && c.teachers ? ' · ' : ''}
              {c.teachers}
            </span>
          </span>
          <span className="tt-dayrow-weeks">{weekRangeLabel(c, WEEK_TYPE_LABELS)}</span>
        </button>,
      )
    } else {
      const ev = it.ev
      rows.push(
        <button type="button" key={ev.id} className="tt-dayrow is-event" onClick={() => onPickEvent(ev)}>
          <span className="tt-dayrow-time">
            <b>{ev.start}</b>
            <i>{ev.end}</i>
          </span>
          <span className="tt-dayrow-card">
            <span className="tt-dayrow-name">
              {ev.name}
              <em>{t('timetable.eventTag')}</em>
            </span>
            {ev.place && <span className="tt-dayrow-meta">{ev.place}</span>}
          </span>
          <span className="tt-dayrow-weeks">
            {ev.date ? `${Number(ev.date.slice(5, 7))}/${Number(ev.date.slice(8, 10))}` : t('timetable.weeklyTag')}
          </span>
        </button>,
      )
    }
  }

  return (
    <div className="tt-dayview" {...swipe}>
      <div className="tt-daytabs">
        {WEEKDAY_SHORT.map((w, i) => (
          <button
            type="button"
            key={w}
            className={`tt-daytab${i === day ? ' active' : ''}${today && today.week === week && today.dayIndex === i ? ' today' : ''}`}
            onClick={() => onSetDay(i)}
          >
            {w}
          </button>
        ))}
        <span className="tt-daydate">
          {colDate ? `${colDate.getMonth() + 1}月${colDate.getDate()}日` : ''}
        </span>
      </div>
      {adj && (
        <p className={`tt-dayhint${adj.type === 'off' ? ' is-off' : ''}`}>
          {adj.type === 'off' ? t('timetable.adjOffHint') : t('timetable.adjFollowHint', { day: WEEKDAY_LABELS[adj.day] })}
        </p>
      )}
      {rows.length > 0 ? rows : <p className="tt-dayempty">{t('timetable.dayEmpty')}</p>}
    </div>
  )
}
