import React, { useCallback, useEffect, useState } from 'react'
import './App.css'
import {images } from './db/images.js'
import Home from './pages/Home/Home.jsx'
import {useBrowser} from './contest/browser-context.jsx'
import Task from './pages/Task/Task.jsx'
import PomodoroPage from './pages/Pomodoro/Pomodoro.jsx'
import TodayStats from './components/TodayStats.jsx'
import { recordCompletion } from './utils/statsStorage.js'


  const img_index= Math.floor(Math.random() * images.length);
  const backgroundImage = images[img_index].image;
const App = () => {
  const [view, setView] = useState('task')
  const {name,browserDispatch}=useBrowser();

  useEffect(()=>{
    const userName=localStorage.getItem("name");
    browserDispatch({
      type:'NAME',
      payload:userName
    }); 
  },[])

  // A natural work completion is the *only* event that writes stats. It is
  // de-duplicated by completionId inside statsStorage, so double delivery
  // (StrictMode, storage listeners, timer ticks) never double-counts.
  const handleWorkComplete = useCallback(({ completionId, workMinutes } = {}) => {
    if (!completionId) return
    recordCompletion({ completionId, minutes: workMinutes }).catch(() => {
      // Stats are best-effort; a storage failure should not break the timer.
    })
  }, [])

  const renderView = () => {
    if (!name) return <Home />
    if (view === 'pomodoro') return <PomodoroPage onBack={() => setView('task')} onWorkComplete={handleWorkComplete} />
    return <Task onOpenPomodoro={() => setView('pomodoro')} />
  }

  return (
    <div className="app" style={{ backgroundImage: `url(${backgroundImage})` }}>
        {name && <TodayStats />}
        {renderView()}
    </div>
  )
}

export default App
