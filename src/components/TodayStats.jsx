import { useCallback, useEffect, useRef, useState } from 'react'
import { getTodayStats, getDateKey, subscribeToStats } from '../utils/statsStorage.js'
import './TodayStats.css'

const EMPTY_STATS = {
  pomodoros: 0,
  focusMinutes: 0,
  streak: 0,
  completed: false,
}

const formatMinutes = (minutes) => {
  if (!minutes) return '0m'
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  if (hours && rest) return `${hours}h ${rest}m`
  if (hours) return `${hours}h`
  return `${rest}m`
}

const TodayStats = () => {
  const [stats, setStats] = useState(EMPTY_STATS)
  const [dateKey, setDateKey] = useState(() => getDateKey())
  const dateKeyRef = useRef(dateKey)

  // All updates happen after an async tick (storage read / event), never
  // synchronously during the mount effect.
  const refresh = useCallback(() => {
    Promise.resolve()
      .then(getTodayStats)
      .then((nextStats) => {
        const key = getDateKey()
        dateKeyRef.current = key
        setDateKey(key)
        setStats(nextStats)
      })
      .catch(() => setStats(EMPTY_STATS))
  }, [])

  useEffect(() => {
    refresh()
    // Push updates as soon as storage changes (this tab or others).
    const unsubscribe = subscribeToStats((nextStats) => {
      const key = getDateKey()
      dateKeyRef.current = key
      setDateKey(key)
      setStats(nextStats)
    })

    // Re-read shortly after midnight so the view rolls over to a new day
    // (today zeroes out; history remains untouched in storage).
    const midnightTimer = setInterval(() => {
      const key = getDateKey()
      if (key !== dateKeyRef.current) refresh()
    }, 30000)
    const onVisible = () => {
      if (document.visibilityState === 'visible') refresh()
    }
    document.addEventListener('visibilitychange', onVisible)

    return () => {
      unsubscribe()
      clearInterval(midnightTimer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [refresh])

  const items = [
    {
      key: 'pomodoros',
      value: stats.pomodoros,
      label: 'Completed pomodoros',
    },
    {
      key: 'minutes',
      value: formatMinutes(stats.focusMinutes),
      label: 'Focus time today',
    },
    {
      key: 'streak',
      value: stats.streak,
      label: 'Day streak',
    },
  ]

  return (
    <section className="today-stats" aria-label="Today's focus statistics">
      <div className="today-stats__header">
        <span className="today-stats__title">Today</span>
        <span className="today-stats__date">{dateKey}</span>
      </div>
      {!stats.completed ? (
        <p className="today-stats__empty">
          No completed pomodoro yet today. Finish one focus session to start your streak!
        </p>
      ) : (
        <div className="today-stats__grid">
          {items.map((item) => (
            <div key={item.key} className="today-stats__item">
              <span className="today-stats__value">{item.value}</span>
              <span className="today-stats__label">{item.label}</span>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}

export default TodayStats
