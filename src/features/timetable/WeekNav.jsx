// 底部周切换悬浮条 —— 滑动切周之外的按钮入口；点周次标签回到今天（不在本周时带提示点）
import { UiIcon } from '../../components/Icons'
import { t } from '../../i18n'

export default function WeekNav({ week, weekCount, offToday, onPrev, onNext, onBackToday }) {
  return (
    <div className="tt-bottombar">
      <button
        type="button"
        className="tt-navbtn"
        aria-label={t('timetable.prevWeek')}
        onClick={onPrev}
        disabled={week <= 1}
      >
        <UiIcon name="chevron-left" size={16} />
      </button>
      <button
        type="button"
        className="tt-weeklabel"
        onClick={onBackToday}
        title={t('timetable.backToday')}
      >
        {t('timetable.week', { n: week })}
        {offToday && <i className="tt-today-dot" aria-hidden="true" />}
      </button>
      {offToday && (
        <button
          type="button"
          className="tt-navbtn tt-curweek"
          aria-label={t('timetable.backToday')}
          title={t('timetable.backToday')}
          onClick={onBackToday}
        >
          <UiIcon name="crosshair" size={16} />
        </button>
      )}
      <button
        type="button"
        className="tt-navbtn"
        aria-label={t('timetable.nextWeek')}
        onClick={onNext}
        disabled={week >= weekCount}
      >
        <UiIcon name="chevron-right" size={16} />
      </button>
    </div>
  )
}
