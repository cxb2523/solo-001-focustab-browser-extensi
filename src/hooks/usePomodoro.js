import { useEffect, useMemo, useRef, useState } from 'react'

const STATE_KEY = 'pomodoro_state'
const SETTINGS_KEY = 'pomodoro_settings'

const DEFAULT_SETTINGS = {
  work: 1500, // seconds
  shortBreak: 300,
  longBreak: 900,
  roundsBeforeLongBreak: 4,
  autoStart: false,
  sound: true,
  notifications: false,
}

const DEFAULT_STATE = (settings = DEFAULT_SETTINGS) => ({
  mode: 'work',
  remainingMs: settings.work * 1000,
  isRunning: false,
  cycleCount: 0, // completed work sessions
  startedAt: null,
  pendingCompletion: null,
})

const MODE_META = {
  work: { label: 'Work', subtitle: 'Focus now' },
  shortBreak: { label: 'Short Break', subtitle: 'Relax' },
  longBreak: { label: 'Long Break', subtitle: 'Recharge' },
}

export const formatMs = (ms) => {
  const totalSeconds = Math.max(0, Math.round(ms / 1000))
  const m = Math.floor(totalSeconds / 60)
  const s = totalSeconds % 60
  return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`
}

export const getNextMode = (mode, cycleCount, settings) => {
  if (mode === 'work') {
    const nextCycle = cycleCount + 1
    const isLong = nextCycle % settings.roundsBeforeLongBreak === 0
    return { nextMode: isLong ? 'longBreak' : 'shortBreak', nextCycle }
  }
  return { nextMode: 'work', nextCycle: cycleCount }
}

const safeParse = (key, fallback) => {
  try {
    const raw = localStorage.getItem(key)
    return raw ? { ...fallback, ...JSON.parse(raw) } : fallback
  } catch {
    return fallback
  }
}

const createCompletionId = () => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `completion-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

const resolveInitialState = (settings) => {
  const saved = safeParse(STATE_KEY, DEFAULT_STATE(settings))
  // If previously running, adjust remaining based on elapsed time
  if (saved.isRunning && saved.startedAt) {
    const elapsed = Date.now() - saved.startedAt
    const remaining = Math.max(saved.remainingMs - elapsed, 0)
    if (remaining <= 0) {
      // Expired while the page was closed: start a fresh session without
      // emitting a completion (it was never observed running to zero here).
      return DEFAULT_STATE(settings)
    }
    return {
      ...saved,
      remainingMs: remaining,
      isRunning: true,
      startedAt: Date.now(),
      remainingMsAtStart: remaining,
    }
  }
  return saved
}

// Simple chime with AudioContext (resumed to avoid autoplay blocking) plus HTMLAudio fallback.
const CHIME_DATA_URL =
  'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAIlYAAESsAAACABAAZGF0YQAAAAAA'

const playChime = async (enabled) => {
  if (!enabled) return
  try {
    const Ctor = window.AudioContext || window.webkitAudioContext
    if (Ctor) {
      const ctx = new Ctor()
      await ctx.resume()
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.type = 'sine'
      osc.frequency.value = 880
      gain.gain.setValueAtTime(0.0001, ctx.currentTime)
      gain.gain.exponentialRampToValueAtTime(0.12, ctx.currentTime + 0.02)
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.7)
      osc.connect(gain).connect(ctx.destination)
      osc.start()
      osc.stop(ctx.currentTime + 0.72)
      return
    }
  } catch {
    // fall through to HTMLAudio fallback
  }
  try {
    const audio = new Audio(CHIME_DATA_URL)
    await audio.play()
  } catch {
    // ignore audio errors (e.g., autoplay restrictions)
  }
}

const notify = async ({ title, body, enabled }) => {
  if (!enabled || typeof Notification === 'undefined') return
  if (Notification.permission === 'granted') {
    new Notification(title, { body })
    return
  }
  if (Notification.permission === 'default') {
    const perm = await Notification.requestPermission()
    if (perm === 'granted') {
      new Notification(title, { body })
    }
  }
}

const maybeVibrate = () => {
  if (navigator?.vibrate) {
    navigator.vibrate([80, 40, 80])
  }
}

export const usePomodoro = ({ onWorkComplete } = {}) => {
  const [settings, setSettings] = useState(() => safeParse(SETTINGS_KEY, DEFAULT_SETTINGS))
  const [state, setState] = useState(() => resolveInitialState(settings))
  const tickRef = useRef(null)
  const settingsRef = useRef(settings)
  settingsRef.current = settings
  const onWorkCompleteRef = useRef(onWorkComplete)
  onWorkCompleteRef.current = onWorkComplete
  const completionSideEffectsRef = useRef(new Set())
  const completionAdvancedRef = useRef(new Set())

  const sessionDurationMs = useMemo(() => {
    const seconds =
      state.mode === 'work'
        ? settings.work
        : state.mode === 'shortBreak'
        ? settings.shortBreak
        : settings.longBreak
    return seconds * 1000
  }, [state.mode, settings])

  // Persist settings
  useEffect(() => {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings))
  }, [settings])

  // Persist state
  useEffect(() => {
    localStorage.setItem(
      STATE_KEY,
      JSON.stringify({ ...state, sessionDurationMs })
    )
  }, [state, sessionDurationMs])


  const start = () => {
    const now = Date.now()
    setState((prev) => ({
      ...prev,
      isRunning: true,
      startedAt: now,
      remainingMsAtStart: prev.remainingMs,
    }))
  }

  const pause = () => {
    setState((prev) => {
      if (!prev.isRunning) return prev
      const now = Date.now()
      const baseRemaining =
        prev.remainingMsAtStart ?? prev.remainingMs
      const elapsed = prev.startedAt ? now - prev.startedAt : 0
      const remainingMs = Math.max(baseRemaining - elapsed, 0)
      return {
        ...prev,
        isRunning: false,
        remainingMs,
        startedAt: null,
        remainingMsAtStart: undefined,
      }
    })
  }

  const reset = () => {
    setState(DEFAULT_STATE(settings))
  }

  const toggleRun = () => (state.isRunning ? pause() : start())

  const applyNextMode = (nextMode, nextCycle, autoStart) => {
    const nextDuration =
      nextMode === 'work'
        ? settings.work
        : nextMode === 'shortBreak'
        ? settings.shortBreak
        : settings.longBreak
    const isRunning = autoStart
    setState({
      mode: nextMode,
      cycleCount: nextCycle,
      remainingMs: nextDuration * 1000,
      isRunning,
      startedAt: isRunning ? Date.now() : null,
      remainingMsAtStart: isRunning ? nextDuration * 1000 : undefined,
      pendingCompletion: null,
    })
  }

  const skip = () => {
    const { nextMode, nextCycle } = getNextMode(state.mode, state.cycleCount, settings)
    applyNextMode(nextMode, nextCycle, settings.autoStart)
  }

  // Timer loop
  useEffect(() => {
    if (!state.isRunning) {
      if (tickRef.current) {
        clearInterval(tickRef.current)
        tickRef.current = null
      }
      return
    }
    tickRef.current = setInterval(() => {
      // Functional update keeps the decrement correct even when several
      // interval callbacks fire before React flushes a render (background-tab
      // throttling or act() batching), and derive remaining from wall-clock
      // time vs startedAt so no stale render value is read.
      setState((prev) => {
        if (!prev.isRunning || prev.pendingCompletion) return prev
        const now = Date.now()
        const baseRemaining =
          prev.startedAt != null
            ? prev.remainingMsAtStart ?? prev.remainingMs
            : prev.remainingMs
        const elapsed = prev.startedAt != null ? now - prev.startedAt : 0
        const remainingMs = Math.max(baseRemaining - elapsed, 0)
        if (remainingMs > 0) {
          return { ...prev, remainingMs }
        }
        // Natural completion only. A unique completionId is minted exactly
        // once here; pause / reset / skip never create a pendingCompletion.
        const durationSeconds =
          prev.mode === 'work'
            ? settingsRef.current.work
            : prev.mode === 'shortBreak'
            ? settingsRef.current.shortBreak
            : settingsRef.current.longBreak
        return {
          ...prev,
          remainingMs: 0,
          isRunning: false,
          startedAt: null,
          remainingMsAtStart: undefined,
          pendingCompletion: {
            token: createCompletionId(),
            mode: prev.mode,
            durationSeconds,
          },
        }
      })
    }, 1000)
    return () => {
      if (tickRef.current) clearInterval(tickRef.current)
    }
  }, [state.isRunning])

  // Handle a work/break session that ran to zero naturally. Ref guards make
  // StrictMode's double effect invocation safe: the completion event (with its
  // unique completionId) and the mode advance each happen a single time.
  useEffect(() => {
    const pending = state.pendingCompletion
    if (!pending) return

    if (!completionSideEffectsRef.current.has(pending.token)) {
      completionSideEffectsRef.current.add(pending.token)
      if (completionSideEffectsRef.current.size > 50) {
        completionSideEffectsRef.current.delete(
          completionSideEffectsRef.current.values().next().value
        )
      }
      playChime(settingsRef.current.sound)
      maybeVibrate()
      notify({
        title: `${MODE_META[pending.mode].label} complete`,
        body: 'Switching to the next session',
        enabled: settingsRef.current.notifications,
      })
      if (
        pending.mode === 'work' &&
        typeof onWorkCompleteRef.current === 'function'
      ) {
        onWorkCompleteRef.current({
          completionId: pending.token,
          minutes: pending.durationSeconds / 60,
          mode: 'work',
          completedAt: Date.now(),
        })
      }
    }

    if (!completionAdvancedRef.current.has(pending.token)) {
      completionAdvancedRef.current.add(pending.token)
      const { nextMode, nextCycle } = getNextMode(
        state.mode,
        state.cycleCount,
        settingsRef.current
      )
      applyNextMode(nextMode, nextCycle, settingsRef.current.autoStart)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.pendingCompletion])

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e) => {
      if (['INPUT', 'TEXTAREA'].includes(e.target.tagName)) return
      if (e.key === ' ') {
        e.preventDefault()
        toggleRun()
      } else if (e.key.toLowerCase() === 'r') {
        reset()
      } else if (e.key.toLowerCase() === 'n') {
        skip()
      } else if (e.key.toLowerCase() === 'm') {
        setSettings((prev) => ({ ...prev, sound: !prev.sound }))
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  })

  const toggleAutoStart = () => setSettings((prev) => ({ ...prev, autoStart: !prev.autoStart }))
  const toggleSound = () => setSettings((prev) => ({ ...prev, sound: !prev.sound }))
  const toggleNotifications = () =>
    setSettings((prev) => ({ ...prev, notifications: !prev.notifications }))

    // Ask for notification permission when toggled on
    useEffect(() => {
      if (settings.notifications && typeof Notification !== 'undefined' && Notification.permission === 'default') {
        Notification.requestPermission().catch(() => {})
      }
    }, [settings.notifications])

  const percentComplete = useMemo(() => {
    if (!sessionDurationMs) return 0
    return Math.min(100, Math.max(0, 100 - (state.remainingMs / sessionDurationMs) * 100))
  }, [state.remainingMs, sessionDurationMs])

  const meta = MODE_META[state.mode]

  return {
    state: {
      mode: state.mode,
      remainingMs: state.remainingMs,
      isRunning: state.isRunning,
      cycleCount: state.cycleCount,
      sessionDurationMs,
      percentComplete,
      label: meta.label,
      subtitle: meta.subtitle,
      autoStart: settings.autoStart,
      soundEnabled: settings.sound,
      notificationsEnabled: settings.notifications,
      roundsBeforeLongBreak: settings.roundsBeforeLongBreak,
    },
    settings,
    start,
    pause,
    reset,
    skip,
    toggleRun,
    toggleAutoStart,
    toggleSound,
    toggleNotifications,
    setSettings,
    setState,
  }
}
