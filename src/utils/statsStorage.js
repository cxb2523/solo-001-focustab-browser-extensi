// Persistent storage for daily Pomodoro statistics.
// Primary backend is chrome.storage.local (versioned payload); in a plain
// browser/dev environment it transparently falls back to localStorage.

export const STORAGE_KEY = 'focustab_stats_v1'
export const DATA_VERSION = 1
const COMPLETION_INDEX_TTL_DAYS = 400

const createEmptyData = () => ({
  version: DATA_VERSION,
  // dateKey (YYYY-MM-DD, local timezone) -> day record
  days: {},
  // Newest calendar date we have ever stored. Used to reject clock-rollback
  // attempts at extending a streak.
  latestDate: null,
  // completionId -> dateKey, used for idempotent de-duplication
  completionIds: {},
  updatedAt: null,
})

const emptyStats = (dateKey) => ({
  date: dateKey,
  pomodoros: 0,
  focusMinutes: 0,
  streak: 0,
  completed: false,
})

const root = typeof globalThis !== 'undefined' ? globalThis : {}

const getChromeStore = () =>
  root.chrome &&
  root.chrome.storage &&
  root.chrome.storage.local &&
  typeof root.chrome.storage.local.get === 'function'
    ? root.chrome.storage.local
    : null

const getLocalStore = () =>
  typeof root.localStorage !== 'undefined' ? root.localStorage : null

const normalizeData = (raw) => {
  if (
    raw &&
    typeof raw === 'object' &&
    raw.version === DATA_VERSION &&
    raw.days &&
    typeof raw.days === 'object'
  ) {
    return {
      ...createEmptyData(),
      ...raw,
      days: { ...raw.days },
      completionIds: { ...(raw.completionIds || {}) },
    }
  }
  // Missing, corrupt, or from an incompatible schema version: start fresh.
  return createEmptyData()
}

const storageGet = async (key) => {
  const chromeStore = getChromeStore()
  if (chromeStore) {
    const result = await Promise.resolve(chromeStore.get(key))
    return result ? result[key] : null
  }
  const localStore = getLocalStore()
  if (localStore) {
    try {
      const raw = localStore.getItem(key)
      return raw ? JSON.parse(raw) : null
    } catch {
      return null
    }
  }
  return null
}

const notifyLocalChange = (key, value) => {
  if (typeof root.dispatchEvent === 'function' && typeof root.CustomEvent === 'function') {
    root.dispatchEvent(new root.CustomEvent('focustab:stats-changed', { detail: { key, value } }))
  }
}

const storageSet = async (key, value) => {
  const chromeStore = getChromeStore()
  if (chromeStore) {
    await Promise.resolve(chromeStore.set({ [key]: value }))
    return
  }
  const localStore = getLocalStore()
  if (localStore) {
    localStore.setItem(key, JSON.stringify(value))
    // window "storage" events only fire in *other* tabs, so emit a local event
    // to keep same-tab subscribers (this new tab page) in sync immediately.
    notifyLocalChange(key, value)
  }
}

// Local-timezone date key, e.g. 2026-09-28
export const getDateKey = (date = new Date()) => {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

const shiftDateKey = (dateKey, deltaDays) => {
  const [year, month, day] = dateKey.split('-').map(Number)
  const shifted = new Date(Date.UTC(year, month - 1, day) + deltaDays * 86400000)
  const y = shifted.getUTCFullYear()
  const m = String(shifted.getUTCMonth() + 1).padStart(2, '0')
  const d = String(shifted.getUTCDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

const toStats = (day, dateKey) =>
  day
    ? {
        date: day.date || dateKey,
        pomodoros: day.pomodoros || 0,
        focusMinutes: day.focusMinutes || 0,
        streak: day.streak || 0,
        completed: true,
      }
    : emptyStats(dateKey)

// Unique, collision-resistant id attached to a single natural work completion.
export const createCompletionId = () => {
  const cryptoApi = root.crypto
  if (cryptoApi && typeof cryptoApi.randomUUID === 'function') {
    return `pc_${cryptoApi.randomUUID()}`
  }
  if (cryptoApi && typeof cryptoApi.getRandomValues === 'function') {
    const bytes = cryptoApi.getRandomValues(new Uint8Array(16))
    const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
    return `pc_${Date.now().toString(36)}_${hex}`
  }
  return `pc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`
}

// Keep the de-duplication index bounded while retaining all daily history.
const pruneCompletionIds = (data) => {
  if (!data.latestDate) return
  const cutoff = shiftDateKey(data.latestDate, -COMPLETION_INDEX_TTL_DAYS)
  Object.keys(data.completionIds).forEach((id) => {
    if (data.completionIds[id] < cutoff) {
      delete data.completionIds[id]
    }
  })
}

// Serialize read-modify-write cycles so concurrent timer completions and
// storage listeners can never interleave and double-count.
let writeChain = Promise.resolve()

export const recordCompletion = ({ completionId, minutes, completedAt = new Date() }) => {
  const id = String(completionId)
  const task = writeChain.then(async () => {
    const data = normalizeData(await storageGet(STORAGE_KEY))
    const dateKey = getDateKey(completedAt)

    // Idempotent: the same completion is counted exactly once even if the
    // timer callback fires twice (e.g. React StrictMode double effects).
    if (Object.prototype.hasOwnProperty.call(data.completionIds, id)) {
      return { deduped: true, stats: toStats(data.days[dateKey], dateKey) }
    }

    const existingDay = data.days[dateKey]
    const yesterdayKey = shiftDateKey(dateKey, -1)
    const yesterday = data.days[yesterdayKey]

    // Streak is decided only by the first completion of the local day.
    // A continuation is legitimate solely when the immediately preceding
    // calendar day is both recorded and the most recent day ever seen.
    // Clock rollback (yesterday exists but a future day was recorded) and
    // jumping forward (yesterday missing) therefore reset the streak.
    let streak
    if (existingDay) {
      streak = existingDay.streak
    } else {
      const continues = Boolean(yesterday) && data.latestDate === yesterdayKey
      streak = continues ? yesterday.streak + 1 : 1
    }

    const focusMinutes = Math.max(0, Math.round(Number(minutes) || 0))
    data.days[dateKey] = {
      date: dateKey,
      pomodoros: (existingDay?.pomodoros || 0) + 1,
      focusMinutes: (existingDay?.focusMinutes || 0) + focusMinutes,
      streak,
    }
    data.completionIds[id] = dateKey
    if (!data.latestDate || dateKey > data.latestDate) {
      data.latestDate = dateKey
    }
    data.updatedAt = new Date().toISOString()
    pruneCompletionIds(data)

    await storageSet(STORAGE_KEY, data)
    return { deduped: false, stats: toStats(data.days[dateKey], dateKey) }
  })
  // Prevent one failed write from breaking the chain for later callers.
  writeChain = task.then(
    () => undefined,
    () => undefined
  )
  return task
}

// Read-only view of today; never mutates history ("cross-day" just shows zeros
// while past day records stay intact).
export const getTodayStats = async (today = new Date()) => {
  const data = normalizeData(await storageGet(STORAGE_KEY))
  const dateKey = getDateKey(today)
  return toStats(data.days[dateKey], dateKey)
}

// Subscribe to stats updates. Fires on chrome.storage.onChanged, cross-tab
// localStorage "storage" events, and same-tab custom fallback events.
export const subscribeToStats = (callback) => {
  if (typeof callback !== 'function') return () => {}

  const handleValue = (raw) => {
    try {
      const data = normalizeData(raw)
      const dateKey = getDateKey()
      callback(toStats(data.days[dateKey], dateKey))
    } catch {
      // Ignore malformed change payloads.
    }
  }

  const chromeStore = getChromeStore()
  if (chromeStore && root.chrome.storage.onChanged) {
    const listener = (changes, areaName) => {
      if (areaName && areaName !== 'local') return
      if (changes && Object.prototype.hasOwnProperty.call(changes, STORAGE_KEY)) {
        handleValue(changes[STORAGE_KEY].newValue)
      }
    }
    root.chrome.storage.onChanged.addListener(listener)
    return () => root.chrome.storage.onChanged.removeListener(listener)
  }

  const localStore = getLocalStore()
  if (localStore && typeof root.addEventListener === 'function') {
    const onStorage = (event) => {
      if (event.key === STORAGE_KEY) {
        try {
          handleValue(event.newValue ? JSON.parse(event.newValue) : null)
        } catch {
          // ignore
        }
      }
    }
    const onCustom = (event) => {
      if (event.detail && event.detail.key === STORAGE_KEY) {
        handleValue(event.detail.value)
      }
    }
    root.addEventListener('storage', onStorage)
    root.addEventListener('focustab:stats-changed', onCustom)
    return () => {
      root.removeEventListener('storage', onStorage)
      root.removeEventListener('focustab:stats-changed', onCustom)
    }
  }

  return () => {}
}

