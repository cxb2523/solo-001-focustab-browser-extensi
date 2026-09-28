import { recordWorkCompletion, getTodayStats, getDateKey, STORAGE_KEY } from './src/utils/statsStorage.js'
import assert from 'node:assert'

const mem = new Map()
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k),
}
globalThis.window = { addEventListener(){}, removeEventListener(){}, dispatchEvent(){} }

const iso = (d) => {
  const y = d.getFullYear()
  const m = String(d.getMonth()+1).padStart(2,'0')
  const day = String(d.getDate()).padStart(2,'0')
  return `${y}-${m}-${day}`
}

// Scenario 1: first completion today
let r = await recordWorkCompletion({ completionId: 'id-1', minutes: 25 })
assert.equal(r.recorded, true)
let t = await getTodayStats()
assert.equal(t.completedPomodoros, 1)
assert.equal(t.focusMinutes, 25)
assert.equal(t.streak, 1)
console.log('PASS first completion:', JSON.stringify(t))

// Scenario 2: duplicate completionId must not double count
r = await recordWorkCompletion({ completionId: 'id-1', minutes: 25 })
assert.equal(r.recorded, false)
t = await getTodayStats()
assert.equal(t.completedPomodoros, 1)
assert.equal(t.focusMinutes, 25)
console.log('PASS dedupe')

// Scenario 3: second pomodoro accumulates
await recordWorkCompletion({ completionId: 'id-2', minutes: 25 })
t = await getTodayStats()
assert.equal(t.completedPomodoros, 2)
assert.equal(t.focusMinutes, 50)
assert.equal(t.streak, 1)
console.log('PASS accumulate:', t.completedPomodoros, t.focusMinutes)

// Scenario 4: streak continues from yesterday
{
  const data = JSON.parse(mem.get(STORAGE_KEY))
  const y = new Date(); y.setDate(y.getDate() - 1)
  const yk = iso(y)
  data.days = { [yk]: { count: 3, focusMinutes: 75, streak: 4, ids: ['y1'] } }
  mem.set(STORAGE_KEY, JSON.stringify(data))
  const r2 = await recordWorkCompletion({ completionId: 'id-3', minutes: 25 })
  assert.equal(r2.stats.days[getDateKey()].streak, 5)
  console.log('PASS streak continues ->', r2.stats.days[getDateKey()].streak)
}

// Scenario 5: gap of 2+ days resets streak to 1
{
  const data = JSON.parse(mem.get(STORAGE_KEY))
  const old = new Date(); old.setDate(old.getDate() - 3)
  data.days = { [iso(old)]: { count: 1, focusMinutes: 25, streak: 9, ids: ['o1'] } }
  mem.set(STORAGE_KEY, JSON.stringify(data))
  const r2 = await recordWorkCompletion({ completionId: 'id-4', minutes: 25 })
  assert.equal(r2.stats.days[getDateKey()].streak, 1)
  console.log('PASS broken streak reset -> 1')
}

// Scenario 6: future-day record cannot inflate streak
{
  const data = JSON.parse(mem.get(STORAGE_KEY))
  const fut = new Date(); fut.setDate(fut.getDate() + 1)
  data.days[iso(fut)] = { count: 5, focusMinutes: 125, streak: 99, ids: ['f1'] }
  mem.set(STORAGE_KEY, JSON.stringify(data))
  const r2 = await recordWorkCompletion({ completionId: 'id-5', minutes: 25 })
  assert.equal(r2.stats.days[getDateKey()].streak, 1)
  console.log('PASS future record cannot fake streak ->', r2.stats.days[getDateKey()].streak)
}

// Scenario 7: empty / other-day view shows zeros but history kept
{
  const data = JSON.parse(mem.get(STORAGE_KEY))
  const past = new Date(); past.setDate(past.getDate() - 10)
  data.days[iso(past)] = { count: 2, focusMinutes: 50, streak: 1, ids: ['p1'] }
  mem.set(STORAGE_KEY, JSON.stringify(data))
  const empty = await getTodayStats(new Date(past.getFullYear(), past.getMonth(), past.getDate() - 1))
  assert.deepEqual([empty.completedPomodoros, empty.streak], [0, 0])
  const hist = JSON.parse(mem.get(STORAGE_KEY)).days
  assert.equal(hist[iso(past)].count, 2)
  console.log('PASS cross-day view zeroes, history retained')
}

// Scenario 8: versioned payload
const data = JSON.parse(mem.get(STORAGE_KEY))
assert.equal(data.version, 1)
console.log('PASS version =', data.version)
console.log('ALL STORAGE TESTS PASSED')
