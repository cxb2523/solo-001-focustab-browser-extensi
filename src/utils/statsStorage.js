/**
 * Daily focus stats storage.
 *
 * Data is versioned and persisted in chrome.storage.local when running as an
 * extension, with a localStorage fallback for local development. Every write
 * goes through a serialized read-modify-write queue and each completed pomodoro
 * carries a unique completionId, so concurrent timer callbacks / storage
 * listeners can never be counted twice.
 */

export const STORAGE_KEY = 'focusTab.stats'
export const STORAGE_VERSION = 1
const MAX_REMEMBERED_IDS = 100

const hasChromeStorage = () =>
  typeof chrome !== 'undefined' && !!chrome.storage && !!chrome.storage.local

const storageGet = () =>
  new Promise((resolve) => {
    try {
      if (hasChromeStorage()) {
        chrome.storage.local.get([STORAGE_KEY], (result) => {
          if (chrome.runtime && chrome.runtime.lastError) {
            resolve(null)
          } else {
            resolve(result && result[STORAGE_KEY] !== undefined ? result[STORAGE_KEY] : null)
          }
        })
        return
      }
      if (typeof localStorage !== 'undefined') {
        const raw = localStorage.getItem(STORAGE_KEY)
        resolve(raw ? JSON.parse(raw) : null)
        return
      }
    } catch {
      // fall through
    }
    resolve(null)
  })

const storageSet = (value) =>
  new Promise((resolve) => {
    try {
      if (hasChromeStorage()) {
        chrome.storage.local.set({ [STORAGE_KEY]: value }, () => {
          resolve(!chrome.runtime || !chrome.runtime.lastError)
        })
        return
      }
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(value))
        // chrome.storage does not fire storage.onChanged in the same tab; the
        // localStorage event behaves the same way, so emit a local event to
        // refresh cards mounted in the current document.
        window.dispatchEvent(new CustomEvent('focus-tab-stats-changed'))
        resolve(true)
        return
      }
    } catch {
      // fall through
    }
    resolve(false)
  })

const createEmptyStats = () => ({
  version: STORAGE_VERSION,
  lastDate: null,
  // days: { 'YYYY-MM-DD': { count, focusMinutes, streak, ids: string[] } }
  days: {},
})

const migrate = (raw) => {
  if (!raw || typeof raw !== 'object') return createEmptyStats()
  const stats = {
    ...createEmptyStats(),
    ...raw,
    days: raw.days && typeof raw.days === 'object' ? raw.days : {},
  }
  if (!stats.version) stats.version = STORAGE_VERSION
  return stats
}

/** Local-timezone date key, e.g. 2026-09-28. */
export const getDateKey = (date = new Date()) => {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

/** Whole-day difference between two YYYY-MM-DD keys (a - b). */
const diffDays = (keyA, keyB) => {
  const [ya, ma, da] = keyA.split('-').map(Number)
  const [yb, mb, db] = keyB.split('-').map(Number)
  return Math.round((Date.UTC(ya, ma - 1, da) - Date.UTC(yb, mb - 1, db)) / 86400000)
}

const newId = () => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

/**
 * Streak rules (resistant to clock manipulation):
 * - first completion ever / no prior days: 1
 * - yesterday has a record: continue yesterday's streak + 1
 * - a gap of 2+ days (time jump backwards or forwards): reset to 1
 * - an existing record for today keeps its original streak, so rolling the
 *   clock back cannot lower a streak already earned today.
 */
const resolveStreak = (stats, todayKey, priorStreak) => {
  // A record already existed for today (this is a later pomodoro of the day):
  // keep its streak so clock rollback cannot lower a streak earned today.
  if (priorStreak !== null && priorStreak !== undefined) return priorStreak

  const keys = Object.keys(stats.days).sort()
  let yesterdayStreak = 0
  let hasCloserDay = false
  for (const key of keys) {
    const delta = diffDays(todayKey, key)
    if (delta <= 0) continue
    if (delta === 1) yesterdayStreak = stats.days[key].streak || 0
    else if (delta > 1) hasCloserDay = true
  }
  if (!hasCloserDay && yesterdayStreak > 0) return yesterdayStreak + 1
  return 1
}

let writeChain = Promise.resolve()

/**
 * Record one naturally completed work session.
 *
 * @param {object} payload
 * @param {string} payload.completionId unique id for this completion
 * @param {number} payload.minutes planned work-session length for this round
 * @returns {Promise<{recorded: boolean, stats: object}>}
 */
export const recordWorkCompletion = (payload = {}) =>
  new Promise((resolve) => {
    const completionId = payload.completionId || newId()
    const minutes = Math.max(0, Math.round(Number(payload.minutes) || 0))

    writeChain = writeChain.then(async () => {
      const stats = migrate(await storageGet())
      const todayKey = getDateKey()

      const existingDay = stats.days[todayKey]
      const priorStreak =
        existingDay && Number.isInteger(existingDay.streak) ? existingDay.streak : null

      if (!stats.days[todayKey]) {
        stats.days[todayKey] = { count: 0, focusMinutes: 0, streak: 0, ids: [] }
      }
      const day = stats.days[todayKey]
      if (!Array.isArray(day.ids)) day.ids = []

      // completionId de-dupe: timer callbacks and storage listeners may fire
      // the same completion more than once, but it is counted a single time.
      if (day.ids.includes(completionId)) {
        resolve({ recorded: false, stats, todayKey, completionId })
        return
      }

      day.ids.push(completionId)
      if (day.ids.length > MAX_REMEMBERED_IDS) {
        day.ids = day.ids.slice(day.ids.length - MAX_REMEMBERED_IDS)
      }
      day.count += 1
      day.focusMinutes += minutes
      day.streak = resolveStreak(stats, todayKey, priorStreak)
      stats.lastDate = todayKey

      await storageSet(stats)
      resolve({ recorded: true, stats, todayKey, completionId })
    })
  })

export const getTodayStats = async (now = new Date()) => {
  const stats = migrate(await storageGet())
  const todayKey = getDateKey(now)
  const day = stats.days[todayKey]
  return {
    date: todayKey,
    completedPomodoros: day ? day.count : 0,
    focusMinutes: day ? day.focusMinutes : 0,
    streak: day ? day.streak : 0,
    hasCompletedToday: Boolean(day && day.count > 0),
  }
}

/**
 * Subscribe to stats changes from any tab (chrome.storage.onChanged), with a
 * local event fallback for the localStorage development path.
 */
export const subscribeToStatsChanges = (callback) => {
  const listeners = []

  if (hasChromeStorage() && chrome.storage.onChanged) {
    const handler = (changes, areaName) => {
      if (areaName === 'local' && changes[STORAGE_KEY]) callback()
    }
    chrome.storage.onChanged.addListener(handler)
    listeners.push(() => chrome.storage.onChanged.removeListener(handler))
  }

  if (typeof window !== 'undefined') {
    const handler = () => callback()
    window.addEventListener('focus-tab-stats-changed', handler)
    listeners.push(() => window.removeEventListener('focus-tab-stats-changed', handler))
  }

  return () => listeners.forEach((dispose) => dispose())
}
