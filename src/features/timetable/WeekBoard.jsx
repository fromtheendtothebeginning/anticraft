// 周视图网格 —— 纯展示：给定学期/周次渲染 11 节 × 7 天格子和课程/日程卡
// 时段（上午 1-4 / 下午 5-8 / 晚上 9-11）用贯穿整行的浅色色带分隔；第 4 节后有一条 11:55 细线
// 每节静默分成 10 份（不可见），仅日程按真实时间落到份数上（subRow = 份数下标 → 网格行），
// 课程仍按整节跨行，卡片盖住内部的份数线
import { UiIcon } from '../../components/Icons'
import { t } from '../../i18n'
import {
  SLOT_TIMES, SECTIONS, WEEKDAY_SHORT, SUBS_PER_SLOT,
  dateOfWeekDay, dateISOOf, courseMatchesWeek, courseHue, lessonPassed,
  eventOnDay, minutesOf, minutesToSub, adjustmentOnDate,
} from './model'

// 份数下标 a（0-109）→ 网格行号：表头 1 行 + 之前经过的色带（上午必经、下午/晚上按节次）+ 11:55 线
function subRow(a) {
  const slot = Math.floor(a / SUBS_PER_SLOT)
  const bandsBefore = 1 + Math.floor(slot / 4) + (slot >= 4 ? 1 : 0)
  return 2 + bandsBefore + a
}

export default function WeekBoard({ timetable, week, today, now, showTimes, onPick, onPickEvent, swipe }) {
  const weekCourses = timetable.courses.filter(c => courseMatchesWeek(week, c))
  const events = timetable.events || []
  // 每列（天）的日期 ISO，用于判断带日期的日程是否落在当周当天
  const colISOs = WEEKDAY_SHORT.map((_, di) => {
    const d = dateOfWeekDay(timetable.startDate, week, di)
    return d ? dateISOOf(d) : ''
  })
  // 调休映射：off 列放假清空；follow 列显示被借那天的课（同一门课可能在两列各出现一次）
  const colAdj = colISOs.map(iso => adjustmentOnDate(timetable.adjustments, iso))
  const colEff = colAdj.map((adj, di) => (adj ? (adj.type === 'off' ? null : adj.day) : di))
  const colCourses = colEff.map(eff => (eff == null ? [] : weekCourses.filter(c => c.day === eff)))
  // 已被课程占用的 (列-节) 格子，只给空格子补底
  const covered = new Set()
  colCourses.forEach((list, di) => {
    for (const c of list) {
      for (let s = c.slotStart; s <= c.slotEnd; s++) covered.add(`${di}-${s}`)
    }
  })

  return (
    <div className="tt-weekwrap" {...swipe}>
      <div className="tt-weekgrid">
        <div className="tt-corner">{(() => {
          const monday = dateOfWeekDay(timetable.startDate, week, 0)
          return monday ? `${monday.getMonth() + 1}月` : ''
        })()}</div>
        {WEEKDAY_SHORT.map((w, i) => {
          const d = dateOfWeekDay(timetable.startDate, week, i)
          const isToday = today && today.week === week && today.dayIndex === i
          const adj = colAdj[i]
          return (
            <div key={w} className={`tt-dayhead${isToday ? ' today' : ''}`} style={{ gridColumn: i + 2 }}>
              <span className="tt-dayhead-w">{w}</span>
              <span className="tt-dayhead-d">{d ? `${d.getMonth() + 1}/${d.getDate()}` : ''}</span>
              {adj && (
                <span className={`tt-dayhead-adj${adj.type === 'off' ? ' is-off' : ''}`}>
                  {adj.type === 'off' ? t('timetable.adjOffBadge') : t('timetable.adjFollowBadge', { day: WEEKDAY_SHORT[adj.day] })}
                </span>
              )}
            </div>
          )
        })}
        {/* 时段色带：贯穿整行，浅底 + 细线，视觉分组上午/下午/晚上（紧贴该时段第一节上方） */}
        {SECTIONS.map((sec, si) => (
          <div key={sec.key} className="tt-secrow" style={{ gridRow: subRow(sec.from * SUBS_PER_SLOT) - 1 }}>
            <span>{t(`timetable.${sec.labelKey}`)}</span>
          </div>
        ))}
        {/* 11:55 细线：另一套中午作息的下班边界，选了 11:55 的课会延伸到这里 */}
        <div className="tt-noonline" style={{ gridRow: subRow(3 * SUBS_PER_SLOT - 1) + 1 }}>
          <span>11:55</span>
        </div>
        {SLOT_TIMES.map((_, i) => (
          <div key={`s${i}`} className={`tt-slotnum${i % 4 === 0 ? ' first' : ''}`} style={{ gridColumn: 1, gridRow: `${subRow(i * SUBS_PER_SLOT)} / span ${SUBS_PER_SLOT}` }}>
            <span className="tt-slotnum-n">{i + 1}</span>
            {showTimes && (
              <>
                <span className="tt-slotnum-t">{SLOT_TIMES[i][0]}</span>
                <span className="tt-slotnum-t end">{SLOT_TIMES[i][1]}</span>
              </>
            )}
          </div>
        ))}
        {colCourses.flatMap((list, di) => list.map(c => {
          // 末节=第 4 节且选了 11:55：卡片向下延伸盖过 11:55 细线
          const span = subRow((c.slotEnd + 1) * SUBS_PER_SLOT - 1) - subRow(c.slotStart * SUBS_PER_SLOT) + 1
            + (c.slotEnd === 3 && c.endAt ? 1 : 0)
          return (
            <button
              type="button"
              key={`${di}-${c.id}`}
              className={`tt-course${lessonPassed(timetable.startDate, week, di, c, now) ? ' past' : ''}`}
              data-hue={courseHue(c.name)}
              style={{ gridColumn: di + 2, gridRow: `${subRow(c.slotStart * SUBS_PER_SLOT)} / span ${span}` }}
              onClick={() => onPick(c)}
            >
              <span className="tt-course-name">{c.name}</span>
              {c.place && <span className="tt-course-place">{c.place}</span>}
              {c.teachers && <span className="tt-course-teacher">{c.teachers}</span>}
            </button>
          )
        }))}
        {events.map(ev => {
          const aS = minutesToSub(minutesOf(ev.start))
          const aE = minutesToSub(minutesOf(ev.end), true)
          // 落在节次空隙（午休等）的日程两端会收敛到同一份，给最小可见高度而不是丢弃；
          // 最短 5 份（约半节）保证「课名 + 时间」两行都读得出来
          const aEnd = Math.max(aE, aS + 5)
          const span = Math.max(5, subRow(aEnd) - subRow(aS) + 1)
          return (
            WEEKDAY_SHORT.map((_, di) => {
              if (!eventOnDay(ev, colISOs[di], di)) return null
              // 放假列：按星期重复的日程当天不显示（带日期的日程照常）
              if (colAdj[di] && colAdj[di].type === 'off' && !ev.date) return null
              return (
                <button
                  type="button"
                  key={ev.id}
                  className="tt-event"
                  title={[ev.name, ev.start && `${ev.start}–${ev.end}`, ev.place].filter(Boolean).join(' · ')}
                  style={{ gridColumn: di + 2, gridRow: `${subRow(aS)} / span ${span}` }}
                  onClick={() => onPickEvent(ev)}
                >
                  <span className="tt-event-name">{ev.name}</span>
                  <span className="tt-event-time">
                    <UiIcon name="calendar" size={9} /> {ev.start}–{ev.end}
                  </span>
                </button>
              )
            })
          )
        })}
        {WEEKDAY_SHORT.map((_, d) => (
          SLOT_TIMES.map((__, i) => (
            covered.has(`${d}-${i}`)
              ? null
              : <div key={`b${d}-${i}`} className={`tt-blank${i % 4 === 0 ? ' first' : ''}`} style={{ gridColumn: d + 2, gridRow: `${subRow(i * SUBS_PER_SLOT)} / span ${SUBS_PER_SLOT}` }} />
          ))
        ))}
      </div>
    </div>
  )
}
