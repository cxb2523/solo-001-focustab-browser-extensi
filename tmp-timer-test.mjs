import TestRenderer, { act } from 'react-test-renderer'
import React from 'react'
import { usePomodoro } from './src/hooks/usePomodoro.js'
import assert from 'node:assert'

const ls = new Map()
globalThis.localStorage = {
  getItem: (k) => (ls.has(k) ? ls.get(k) : null),
  setItem: (k, v) => ls.set(k, String(v)),
  removeItem: (k) => ls.delete(k),
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true
globalThis.window = globalThis
const noop = () => {}
globalThis.addEventListener = noop
globalThis.removeEventListener = noop
globalThis.navigator = {}
globalThis.Notification = undefined

const events = []
const harnessRef = {}

function Harness() {
  harnessRef.api = usePomodoro({
    onWorkComplete: (e) => events.push(e),
  })
  return null
}

ls.set(
  'pomodoro_settings',
  JSON.stringify({ work: 2, shortBreak: 1, longBreak: 2, roundsBeforeLongBreak: 4, autoStart: false, sound: false, notifications: false })
)

let renderer
await act(async () => {
  renderer = TestRenderer.create(React.createElement(Harness))
})
const api = () => harnessRef.api

await act(async () => { api().start() })
await act(async () => { await new Promise((r) => setTimeout(r, 900)) })
await act(async () => { api().pause() })
assert.equal(events.length, 0)
console.log('PASS pause emits nothing')

await act(async () => { api().start() })
await act(async () => { api().reset() })
assert.equal(events.length, 0)
console.log('PASS reset emits nothing')

await act(async () => { api().start() })
await act(async () => { api().skip() })
assert.equal(events.length, 0)
console.log('PASS skip emits nothing')

console.log('mode after skip:', api().state.mode)
if (api().state.mode !== 'work') {
  await act(async () => { api().skip() })
}
console.log('mode now:', api().state.mode)
await act(async () => { api().reset() })
await act(async () => { api().start() })
console.log('started mode:', api().state.mode, 'running:', api().state.isRunning, 'remaining:', api().state.remainingMs)

await act(async () => { await new Promise((r) => setTimeout(r, 3200)) })

console.log('after wait mode:', api().state.mode, 'running:', api().state.isRunning, 'remaining:', api().state.remainingMs, 'events:', events.length)
assert.equal(events.length, 1, `expected 1 event, got ${events.length}`)
assert.ok(events[0].completionId)
assert.equal(events[0].mode, 'work')
assert.equal(events[0].minutes, 2 / 60)
assert.equal(api().state.cycleCount, 1)
assert.notEqual(api().state.mode, 'work')
console.log('PASS natural completion one event, id =', events[0].completionId)

const firstId = events[0].completionId
await act(async () => { api().skip() })
await act(async () => { api().reset() })
await act(async () => { api().start() })
await act(async () => { await new Promise((r) => setTimeout(r, 3200)) })
assert.equal(events.length, 2)
assert.notEqual(events[1].completionId, firstId)
console.log('PASS unique ids across completions')

renderer.unmount()
console.log('ALL TIMER TESTS PASSED')
process.exit(0)
