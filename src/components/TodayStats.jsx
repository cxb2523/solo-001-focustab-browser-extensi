import { useEffect, useState } from 'react'
import {
  getTodayStats,
  getDateKey,
  subscribeToStatsChanges,
} from '../utils/statsStorage.js'
import './TodayStats.css'

const EMPTY_STATS = {
  date: getDateKey(),
  completedPomodoros: 0,
  focusMinutes: 0,
  streak: 0,
  hasCompletedToday: false,
}

const formatFocusDuration = (minutes) => {
  if (!minutes) return '0 min'
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  if (hours && rest) return `${hours}h ${rest}m`
  if (hours) return `${hours}h`
  return `${rest}m`
}

const TodayStats = () => {
  const [stats, setStats] = useState(EMPTY_STATS)

  useEffect(() => {
    let disposed = false

    const refresh = async () => {
      const latest = await getTodayStats()
      if (!disposed) setStats(latest)
    }

    refresh()

    // Refresh instantly when stats change in this tab or any other tab.
    const unsubscribe = subscribeToStatsChanges(refresh)

    // Cross-midnight rollover: only the "today" view resets, history is kept.
    const midnightCheck = setInterval(() => {
      if (getDateKey() !== stats.date) refresh()
    }, 30000)

    return () => {
      disposed = true
      unsubscribe()
      clearInterval(midnightCheck)
    }
  }, [stats.date])

  const isEmpty = !stats.hasCompletedToday

  return (
    <section className="today-stats" aria-label="Today's focus statistics">
      <div className="today-stats__header">
        <span className="today-stats__title">Today</span>
        <span className="today-stats__date">{stats.date}</span>
      </div>

      {isEmpty ? (
        <p className="today-stats__empty">
          No completed focus sessions yet. Start a pomodoro and finish one to
          build your streak.
        </p>
      ) : null}

      <ul className="today-stats__grid">
        <li className="today-stats__item">
          <span className="today-stats__value">{stats.completedPomodoros}</span>
          <span className="today-stats__label">Pomodoros</span>
        </li>
        <li className="today-stats__item">
          <span className="today-stats__value">
            {formatFocusDuration(stats.focusMinutes)}
          </span>
          <span className="today-stats__label">Focus time</span>
        </li>
        <li className="today-stats__item">
          <span className="today-stats__value">{stats.streak}</span>
          <span className="today-stats__label">
            day{stats.streak === 1 ? '' : 's'} streak
          </span>
        </li>
      </ul>
    </section>
  )
}

export default TodayStats
