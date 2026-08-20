/* ============================================================
   NULLVAULT — training log
   Vanilla JS, offline-first, localStorage-backed.
   ============================================================ */
(function(){
'use strict';

const STORAGE_KEY = 'gymtracker_data_v1';
const LB_PER_KG = 2.20462;

/* ---------------- STATE ---------------- */
let state = loadState();
let currentView = 'home';
let activeWorkout = null; // {startedAt, exercises:[{exId, name, sets:[{weight,reps,done}], notes}]}
let pickerMode = 'session'; // 'session' = adding to activeWorkout, 'template' = adding to editingTemplateExIds
let workoutTimerInterval = null;
let calCursor = new Date(); // month being viewed in calendar
let customExercises = [];

function defaultState(){
  return {
    sessions: [],          // {id, date(ISO), exercises:[{exId,name,sets,notes}], durationMin, kcal, type}
    settings: {
      bodyWeightKg: 75,
      weeklyGoal: 4,
      useLbs: false,
      lastBackupAt: null
    },
    customExercises: [],
    templates: []           // {id, name, exIds:[...], createdAt}
  };
}

function loadState(){
  try{
    const raw = localStorage.getItem(STORAGE_KEY);
    if(!raw) return defaultState();
    const parsed = JSON.parse(raw);
    return Object.assign(defaultState(), parsed, {
      settings: Object.assign(defaultState().settings, parsed.settings || {})
    });
  }catch(e){
    console.error('Failed to load state', e);
    return defaultState();
  }
}

function saveState(){
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  if(window.GymSync) window.GymSync.push(state);
}

/* ---------------- ACTIVE WORKOUT PERSISTENCE ----------------
   activeWorkout lives in memory during a session, but must survive page
   refreshes/crashes, so every mutation is mirrored to localStorage under
   its own key and restored on load.
------------------------------------------------- */
const ACTIVE_WORKOUT_KEY = 'gymtracker_active_workout_v1';

function persistActiveWorkout(){
  try{
    if(activeWorkout){
      localStorage.setItem(ACTIVE_WORKOUT_KEY, JSON.stringify(activeWorkout));
    } else {
      localStorage.removeItem(ACTIVE_WORKOUT_KEY);
    }
  }catch(e){
    console.error('Failed to persist active workout', e);
  }
}

function loadActiveWorkout(){
  try{
    const raw = localStorage.getItem(ACTIVE_WORKOUT_KEY);
    if(!raw) return null;
    const parsed = JSON.parse(raw);
    if(!parsed || !Array.isArray(parsed.exercises) || !parsed.date || !parsed.startedAt) return null;
    return parsed;
  }catch(e){
    console.error('Failed to load active workout', e);
    return null;
  }
}

/* ---------------- HELPERS ---------------- */
function uid(){ return Date.now().toString(36) + Math.random().toString(36).slice(2,8); }
function fmtDateISO(d){
  const y = d.getFullYear();
  const m = (d.getMonth()+1).toString().padStart(2,'0');
  const day = d.getDate().toString().padStart(2,'0');
  return `${y}-${m}-${day}`;
}
function todayISO(){ return fmtDateISO(new Date()); }
function parseISO(iso){ const [y,m,d]=iso.split('-').map(Number); return new Date(y,m-1,d); }
function sameDay(a,b){ return a.getFullYear()===b.getFullYear() && a.getMonth()===b.getMonth() && a.getDate()===b.getDate(); }
function allExercises(){ return EXERCISE_DB.concat(state.customExercises); }
function findExercise(id){ return allExercises().find(e=>e.id===id); }
function kgToDisplay(kg){ return state.settings.useLbs ? Math.round(kg*LB_PER_KG*10)/10 : kg; }
function displayToKg(val){ return state.settings.useLbs ? val/LB_PER_KG : val; }
function unitLabel(){ return state.settings.useLbs ? 'lb' : 'kg'; }

function toast(msg){
  const t = document.getElementById('toast');
  document.getElementById('toastText').textContent = msg;
  t.classList.add('show');
  clearTimeout(toast._h);
  toast._h = setTimeout(()=>t.classList.remove('show'), 2200);
}

/* ---------------- KCAL ESTIMATION ----------------
   Strength: kcal = MET * bodyWeightKg * (setTime_hr) — approximated using
   ~30s effective work time per set at moderate intensity.
   Cardio/incline walk: standard treadmill MET formula (ACSM walking) adjusted for grade.
------------------------------------------------- */
function estimateSetKcal(met, bodyWeightKg, seconds){
  // kcal = MET * 3.5 * weight(kg) / 200 * minutes
  const minutes = seconds/60;
  return met * 3.5 * bodyWeightKg / 200 * minutes;
}

function estimateStrengthExerciseKcal(exercise, sets, bodyWeightKg){
  const met = exercise.met || 4.5;
  // Count any set with logged weight or reps as one unit of work, not just
  // ones explicitly checked "done" — checking off a set is optional, so kcal
  // shouldn't depend on it.
  const workSeconds = sets.filter(s=>s.done || s.weight || s.reps).length * 35; // ~35s time-under-tension per set
  return estimateSetKcal(met, bodyWeightKg, workSeconds);
}

// ACSM walking MET estimate: VO2 (ml/kg/min) = 0.1*speed(m/min) + 1.8*speed(m/min)*grade + 3.5
function estimateInclineWalkKcal(speedKmh, inclinePct, minutes, bodyWeightKg){
  const speedMmin = (speedKmh*1000)/60;
  const grade = inclinePct/100;
  const vo2 = 0.1*speedMmin + 1.8*speedMmin*grade + 3.5;
  const met = vo2/3.5;
  return estimateSetKcal(met, bodyWeightKg, minutes*60);
}

function estimateCardioKcal(exercise, minutes, bodyWeightKg){
  return estimateSetKcal(exercise.met, bodyWeightKg, minutes*60);
}

function sessionTotalKcal(session){
  return session.kcal || 0;
}

/* ---------------- NAVIGATION ---------------- */
function showView(name){
  currentView = name;
  document.querySelectorAll('.view').forEach(v=>v.classList.remove('active'));
  document.getElementById('view-'+name).classList.add('active');
  document.querySelectorAll('.tab-btn').forEach(b=>{
    b.classList.toggle('active', b.dataset.view===name);
  });

  const tabbar = document.querySelector('.tabbar');
  if(name==='workout'){
    tabbar.classList.add('hidden');
    document.body.classList.add('workout-active');
    if(activeWorkout) ensureFinishBar();
  } else {
    tabbar.classList.remove('hidden');
    document.body.classList.remove('workout-active');
    removeFinishBar();
  }
  syncFabState();

  if(name==='home') renderHome();
  if(name==='calendar') renderCalendar();
  if(name==='log') renderExerciseLibrary();
  if(name==='progress') renderProgressList();
  if(name==='templates') renderTemplatesFullList();
  window.scrollTo(0,0);
}

function syncFabState(){
  const fab = document.getElementById('btnFabStart');
  if(!fab) return;
  fab.classList.toggle('active-session', !!activeWorkout);
  fab.setAttribute('aria-label', activeWorkout ? 'Resume session' : 'Start session');
}

document.querySelectorAll('.tab-btn').forEach(btn=>{
  btn.addEventListener('click', ()=>{
    showView(btn.dataset.view);
  });
});

document.getElementById('btnFabStart').addEventListener('click', ()=>{
  pickerMode = 'session';
  startWorkout(todayISO());
});

document.getElementById('btnSettings').addEventListener('click', ()=>{
  showView('settings');
  loadSettingsIntoForm();
});

/* ---------------- HOME VIEW ---------------- */
function renderHome(){
  const now = new Date();
  document.getElementById('todayDateLabel').textContent = now.toLocaleDateString(undefined,{weekday:'long', month:'long', day:'numeric'});

  const todaySession = state.sessions.find(s=>s.date===todayISO());
  document.getElementById('todayStatusLabel').textContent = todaySession
    ? `Logged: ${todaySession.exercises.length} exercise${todaySession.exercises.length!==1?'s':''}`
    : 'Ready when you are.';

  // streak
  const streak = computeStreak();
  document.getElementById('streakText').innerHTML = `<b>${streak}</b> day streak`;

  // week stats
  const weekSessions = sessionsInLastNDays(7);
  const weekKcal = Math.round(weekSessions.reduce((a,s)=>a+sessionTotalKcal(s),0));
  document.getElementById('statWeekSessions').textContent = weekSessions.length;
  document.getElementById('statWeekKcal').textContent = weekKcal;
  document.getElementById('statTotalSessions').textContent = state.sessions.length;

  // week ring
  const goal = state.settings.weeklyGoal || 4;
  const pct = Math.min(1, weekSessions.length/goal);
  const circumference = 201;
  document.getElementById('weekRingFg').style.strokeDashoffset = circumference*(1-pct);
  document.getElementById('weekRingPct').textContent = Math.round(pct*100)+'%';

  // week days strip (Mon-Sun of current week)
  const strip = document.getElementById('weekDaysStrip');
  strip.innerHTML = '';
  const dow = ['M','T','W','T','F','S','S'];
  const monday = startOfWeek(now);
  for(let i=0;i<7;i++){
    const d = new Date(monday); d.setDate(monday.getDate()+i);
    const iso = fmtDateISO(d);
    const has = state.sessions.some(s=>s.date===iso);
    const el = document.createElement('div');
    el.className = 'week-day' + (has?' done':'') + (sameDay(d,now)?' today':'');
    el.textContent = dow[i];
    strip.appendChild(el);
  }

  renderRecentSessions();
  renderTemplatesQuickRow();
}

function renderTemplatesQuickRow(){
  const wrap = document.getElementById('templatesQuickRow');
  const list = document.getElementById('templatesQuickList');
  if(!state.templates || state.templates.length===0){
    wrap.style.display = 'none';
    return;
  }
  wrap.style.display = 'block';
  const sorted = [...state.templates].sort((a,b)=>b.createdAt-a.createdAt);
  list.innerHTML = sorted.map(t=>`
    <div class="template-item" data-template="${t.id}">
      <div class="template-icon">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>
      </div>
      <div class="template-info">
        <div class="template-title">${t.name}</div>
        <div class="template-meta">${t.exIds.length} exercise${t.exIds.length!==1?'s':''}</div>
      </div>
      <button class="template-delete" data-delete-template="${t.id}">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6h14z"/></svg>
      </button>
    </div>
  `).join('');

  list.querySelectorAll('[data-delete-template]').forEach(btn=>{
    btn.addEventListener('click', (e)=>{
      e.stopPropagation();
      const id = e.currentTarget.dataset.deleteTemplate;
      const t = state.templates.find(x=>x.id===id);
      if(t && confirm(`Delete routine "${t.name}"?`)){
        state.templates = state.templates.filter(x=>x.id!==id);
        saveState();
        renderTemplatesQuickRow();
        toast('Routine deleted');
      }
    });
  });
  list.querySelectorAll('.template-item').forEach(item=>{
    item.addEventListener('click', ()=>{
      startWorkoutFromTemplate(item.dataset.template);
    });
  });
}

function startWorkoutFromTemplate(templateId){
  const template = state.templates.find(t=>t.id===templateId);
  if(!template) return;
  if(!activeWorkout){
    activeWorkout = {startedAt: Date.now(), date: todayISO(), exercises:[], restDuration: 90};
    startWorkoutTimer();
  }
  template.exIds.forEach(exId=>{
    const def = findExercise(exId);
    if(!def) return; // exercise may have been removed since template was saved
    activeWorkout.exercises.push({
      exId: def.id,
      name: def.name,
      sets: [{weight:'', reps:'', difficulty:'medium', done:false}],
      notes:''
    });
  });
  toast(`Loaded "${template.name}"`);
  showView('workout');
  renderWorkoutView();
}

/* ---------------- TEMPLATES TAB (full management) ---------------- */
function renderTemplatesFullList(){
  const container = document.getElementById('templatesFullList');
  if(!state.templates || state.templates.length===0){
    container.innerHTML = `<div class="empty-state">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>
      <p>No routines yet. Save one after finishing a session, or build one from scratch.</p>
    </div>`;
    return;
  }
  const sorted = [...state.templates].sort((a,b)=>b.createdAt-a.createdAt);
  container.innerHTML = sorted.map(t=>{
    const names = t.exIds.map(id=>{
      const def = findExercise(id);
      return def ? def.name : null;
    }).filter(Boolean);
    const preview = names.slice(0,3).join(' · ');
    const more = names.length>3 ? ` +${names.length-3} more` : '';
    return `<div class="card mb-12" data-template-card="${t.id}">
      <div class="row" style="align-items:flex-start;">
        <div style="flex:1; min-width:0;">
          <div class="settings-row-label">${t.name}</div>
          <div class="text-sm text-faint mt-4">${names.length} exercise${names.length!==1?'s':''}${preview? ' · '+preview+more : ''}</div>
        </div>
      </div>
      <div class="quick-actions mt-12" style="margin-bottom:0;">
        <button class="btn btn-primary btn-sm" style="flex:1;" data-start-template="${t.id}">Start</button>
        <button class="btn btn-secondary btn-sm" style="flex:1;" data-edit-template="${t.id}">Edit</button>
      </div>
    </div>`;
  }).join('');

  container.querySelectorAll('[data-start-template]').forEach(btn=>{
    btn.addEventListener('click', ()=>startWorkoutFromTemplate(btn.dataset.startTemplate));
  });
  container.querySelectorAll('[data-edit-template]').forEach(btn=>{
    btn.addEventListener('click', ()=>openTemplateEditor(btn.dataset.editTemplate));
  });
}

let editingTemplateId = null; // null = creating a new template from scratch

document.getElementById('btnNewTemplate').addEventListener('click', ()=>{
  openTemplateEditor(null);
});

function openTemplateEditor(templateId){
  editingTemplateId = templateId;
  const template = templateId ? state.templates.find(t=>t.id===templateId) : null;
  // working copy of exercise ids so cancelling (closing without saving) doesn't mutate state
  editingTemplateExIds = template ? [...template.exIds] : [];
  refreshTemplateEditorSheet(template ? template.name : '');
  openSheet('sheetEditTemplate');
}

function refreshTemplateEditorSheet(nameValue){
  document.getElementById('editTemplateTitle').textContent = editingTemplateId ? 'Edit template' : 'New template';
  if(nameValue !== undefined) document.getElementById('editTemplateNameInput').value = nameValue;
  document.getElementById('btnDeleteTemplateFromEditor').style.display = editingTemplateId ? 'flex' : 'none';
  renderTemplateEditorExerciseList();
}

let editingTemplateExIds = [];

function renderTemplateEditorExerciseList(){
  const list = document.getElementById('editTemplateExerciseList');
  if(editingTemplateExIds.length===0){
    list.innerHTML = `<p class="text-sm text-faint" style="padding:8px 2px;">No exercises added yet.</p>`;
    return;
  }
  list.innerHTML = editingTemplateExIds.map((exId,idx)=>{
    const def = findExercise(exId);
    if(!def) return '';
    const isFirst = idx===0, isLast = idx===editingTemplateExIds.length-1;
    return `<div class="reorder-item" data-reorder-idx="${idx}">
      <div class="reorder-handle" data-drag-handle="${idx}" aria-label="Drag to reorder">
        <svg viewBox="0 0 24 24" fill="currentColor"><circle cx="9" cy="6" r="1.6"/><circle cx="15" cy="6" r="1.6"/><circle cx="9" cy="12" r="1.6"/><circle cx="15" cy="12" r="1.6"/><circle cx="9" cy="18" r="1.6"/><circle cx="15" cy="18" r="1.6"/></svg>
      </div>
      <div class="ex-icon">${def.icon}</div>
      <div class="ex-info">
        <div class="ex-name">${def.name}</div>
        <div class="ex-meta">${capitalize(def.muscle)}</div>
      </div>
      <div class="reorder-nudge-group">
        <button class="reorder-nudge-btn" data-nudge="${idx}:up" ${isFirst?'disabled':''} aria-label="Move up">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M18 15l-6-6-6 6"/></svg>
        </button>
        <button class="reorder-nudge-btn" data-nudge="${idx}:down" ${isLast?'disabled':''} aria-label="Move down">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>
        </button>
      </div>
      <button class="template-delete" data-remove-template-ex="${idx}">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6h14z"/></svg>
      </button>
    </div>`;
  }).join('');

  list.querySelectorAll('[data-remove-template-ex]').forEach(btn=>{
    btn.addEventListener('click', (e)=>{
      const idx = +e.currentTarget.dataset.removeTemplateEx;
      editingTemplateExIds.splice(idx,1);
      renderTemplateEditorExerciseList();
    });
  });
  list.querySelectorAll('[data-nudge]').forEach(btn=>{
    btn.addEventListener('click', (e)=>{
      const [idxStr,dir] = e.currentTarget.dataset.nudge.split(':');
      const idx = +idxStr;
      const targetIdx = dir==='up' ? idx-1 : idx+1;
      if(targetIdx<0 || targetIdx>=editingTemplateExIds.length) return;
      const [moved] = editingTemplateExIds.splice(idx,1);
      editingTemplateExIds.splice(targetIdx,0,moved);
      renderTemplateEditorExerciseList();
    });
  });
  list.querySelectorAll('[data-drag-handle]').forEach(handle=>{
    handle.addEventListener('pointerdown', onReorderPointerDown);
  });
}

/* ---------------- DRAG TO REORDER (touch + mouse via Pointer Events) ----------------
   The dragged item's DOM node follows the pointer directly via a transform
   (no re-rendering mid-drag, so there's nothing to get out of sync). All
   other items in the list get a sibling transform to open/close a gap,
   purely visual. The underlying array is only mutated once, on release,
   then the whole list re-renders cleanly from that final order.
------------------------------------------------- */
let reorderDrag = null; // {startIdx, currentIdx, itemEl, siblings[], itemHeight, startY}

function onReorderPointerDown(e){
  const handle = e.currentTarget;
  const startIdx = +handle.dataset.dragHandle;
  const itemEl = handle.closest('.reorder-item');
  const listEl = document.getElementById('editTemplateExerciseList');
  if(!itemEl || !listEl) return;

  e.preventDefault();
  const itemRect = itemEl.getBoundingClientRect();
  const styles = getComputedStyle(itemEl);
  const itemHeight = itemRect.height + parseFloat(styles.marginBottom || 0);

  const siblings = Array.from(listEl.querySelectorAll('.reorder-item')).filter(el=>el!==itemEl);

  reorderDrag = {
    startIdx,
    currentIdx: startIdx,
    itemEl,
    siblings,
    itemHeight,
    startY: e.clientY
  };

  itemEl.classList.add('dragging');
  itemEl.style.width = itemRect.width + 'px';
  if(navigator.vibrate) navigator.vibrate(15);

  handle.setPointerCapture(e.pointerId);
  handle.addEventListener('pointermove', onReorderPointerMove);
  handle.addEventListener('pointerup', onReorderPointerUp);
  handle.addEventListener('pointercancel', onReorderPointerUp);
}

function onReorderPointerMove(e){
  if(!reorderDrag) return;
  const dy = e.clientY - reorderDrag.startY;
  reorderDrag.itemEl.style.transform = `translateY(${dy}px)`;

  const steps = Math.round(dy / reorderDrag.itemHeight);
  let targetIdx = reorderDrag.startIdx + steps;
  targetIdx = Math.max(0, Math.min(reorderDrag.siblings.length, targetIdx));

  if(targetIdx !== reorderDrag.currentIdx){
    if(navigator.vibrate) navigator.vibrate(8);
    reorderDrag.currentIdx = targetIdx;
  }

  // shift siblings to open a gap at targetIdx: items between the drag's
  // start slot and the current target slot slide by one item-height to
  // make visual room, everything else stays put
  reorderDrag.siblings.forEach((sib, sibIdx)=>{
    // sibIdx is the sibling's position among siblings only (dragged item excluded);
    // its "real" position in the full list is sibIdx if sibIdx<startIdx, else sibIdx+1
    const realIdx = sibIdx < reorderDrag.startIdx ? sibIdx : sibIdx+1;
    let shift = 0;
    if(realIdx > reorderDrag.startIdx && realIdx <= targetIdx){
      shift = -reorderDrag.itemHeight; // slides up to fill the gap the dragged item left
    } else if(realIdx < reorderDrag.startIdx && realIdx >= targetIdx){
      shift = reorderDrag.itemHeight; // slides down
    }
    sib.style.transform = shift ? `translateY(${shift}px)` : '';
  });
}

function onReorderPointerUp(e){
  if(!reorderDrag) return;
  const handle = e.currentTarget;
  handle.removeEventListener('pointermove', onReorderPointerMove);
  handle.removeEventListener('pointerup', onReorderPointerUp);
  handle.removeEventListener('pointercancel', onReorderPointerUp);
  try{ handle.releasePointerCapture(e.pointerId); }catch(err){}

  const { startIdx, currentIdx } = reorderDrag;
  reorderDrag = null;

  if(currentIdx !== startIdx){
    const [moved] = editingTemplateExIds.splice(startIdx, 1);
    editingTemplateExIds.splice(currentIdx, 0, moved);
  }
  renderTemplateEditorExerciseList(); // clean re-render clears all inline transforms/dragging state
}

document.getElementById('btnAddExerciseToTemplate').addEventListener('click', ()=>{
  // reuse the exercise library picker in "template" mode
  pickerMode = 'template';
  closeSheet('sheetEditTemplate');
  showView('log');
  renderExerciseLibrary();
});

document.getElementById('btnSaveTemplateEdits').addEventListener('click', ()=>{
  const name = (document.getElementById('editTemplateNameInput').value||'').trim();
  if(!name){ toast('Enter a routine name'); return; }
  if(editingTemplateExIds.length===0){ toast('Add at least one exercise'); return; }

  if(editingTemplateId){
    const t = state.templates.find(x=>x.id===editingTemplateId);
    if(t){ t.name = name; t.exIds = [...editingTemplateExIds]; }
  } else {
    state.templates.push({
      id: uid(),
      name,
      exIds: [...editingTemplateExIds],
      createdAt: Date.now()
    });
  }
  saveState();
  closeSheet('sheetEditTemplate');
  toast(editingTemplateId ? 'Routine updated' : 'Routine created');
  renderTemplatesFullList();
  renderTemplatesQuickRow();
});

document.getElementById('btnDeleteTemplateFromEditor').addEventListener('click', ()=>{
  if(!editingTemplateId) return;
  const t = state.templates.find(x=>x.id===editingTemplateId);
  if(!t) return;
  if(confirm(`Delete routine "${t.name}"? This cannot be undone.`)){
    state.templates = state.templates.filter(x=>x.id!==editingTemplateId);
    saveState();
    closeSheet('sheetEditTemplate');
    toast('Routine deleted');
    renderTemplatesFullList();
    renderTemplatesQuickRow();
  }
});

function startOfWeek(d){
  const date = new Date(d);
  const day = (date.getDay()+6)%7; // 0=Mon
  date.setDate(date.getDate()-day);
  date.setHours(0,0,0,0);
  return date;
}

function sessionsInLastNDays(n){
  const cutoff = new Date(); cutoff.setDate(cutoff.getDate()-n); cutoff.setHours(0,0,0,0);
  return state.sessions.filter(s=>parseISO(s.date) >= cutoff);
}

function computeStreak(){
  if(state.sessions.length===0) return 0;
  const dates = new Set(state.sessions.map(s=>s.date));
  let streak = 0;
  let cursor = new Date(); cursor.setHours(0,0,0,0);
  // if no session today, check if yesterday continues streak (grace)
  if(!dates.has(fmtDateISO(cursor))){
    cursor.setDate(cursor.getDate()-1);
  }
  while(dates.has(fmtDateISO(cursor))){
    streak++;
    cursor.setDate(cursor.getDate()-1);
  }
  return streak;
}

function renderRecentSessions(){
  const list = document.getElementById('recentSessionsList');
  const sorted = [...state.sessions].sort((a,b)=>b.date.localeCompare(a.date)).slice(0,8);
  if(sorted.length===0){
    list.innerHTML = `<div class="empty-state">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M6 4v16M18 4v16M2 9h4M2 15h4M18 9h4M18 15h4M6 12h12"/></svg>
      <p>No sessions logged yet. Start your first session to begin building your log.</p>
    </div>`;
    return;
  }
  list.innerHTML = sorted.map(s=>{
    const d = parseISO(s.date);
    const exNames = s.exercises.slice(0,3).map(e=>e.name).join(', ');
    const more = s.exercises.length>3 ? ` +${s.exercises.length-3}` : '';
    return `<div class="session-item" data-session="${s.id}">
      <div class="session-date-badge">
        <div class="d num">${d.getDate()}</div>
        <div class="m">${d.toLocaleDateString(undefined,{month:'short'})}</div>
      </div>
      <div class="session-info">
        <div class="session-title">${s.exercises.length} exercise${s.exercises.length!==1?'s':''}${s.type==='walk'?' · Walk':''}</div>
        <div class="session-meta">${exNames}${more || (s.exercises.length===0?'Cardio session':'')}</div>
      </div>
      <div class="session-kcal num">${Math.round(sessionTotalKcal(s))} kcal</div>
    </div>`;
  }).join('');
}

/* ---------------- START SESSION / WORKOUT LOGGING ---------------- */
document.getElementById('btnStartSession').addEventListener('click', ()=>{
  startWorkout(todayISO());
});

function startWorkout(dateISO){
  if(!activeWorkout){
    activeWorkout = {
      startedAt: Date.now(),
      date: dateISO || todayISO(),
      exercises: [],
      restDuration: 90
    };
    startWorkoutTimer();
  }
  showView('workout');
  renderWorkoutView();
}

function startWorkoutTimer(){
  clearInterval(workoutTimerInterval);
  workoutTimerInterval = setInterval(()=>{
    if(!activeWorkout) return;
    const el = document.getElementById('workoutTimerLabel');
    if(el && activeWorkout.date===todayISO()) el.textContent = formatElapsed(Date.now()-activeWorkout.startedAt);
  }, 1000);
}

function formatElapsed(ms){
  const totalSec = Math.floor(ms/1000);
  const m = Math.floor(totalSec/60).toString().padStart(2,'0');
  const s = (totalSec%60).toString().padStart(2,'0');
  return `${m}:${s}`;
}

document.getElementById('btnAddExercise').addEventListener('click', ()=>{
  pickerMode = 'session';
  showView('log');
  renderExerciseLibrary();
});

function renderWorkoutView(){
  if(!activeWorkout){
    document.getElementById('workoutExerciseCards').innerHTML='';
    document.getElementById('workoutEmptyState').style.display='block';
    return;
  }
  persistActiveWorkout();
  document.getElementById('workoutExCount').textContent = `${activeWorkout.exercises.length} exercise${activeWorkout.exercises.length!==1?'s':''}`;

  const isToday = activeWorkout.date===todayISO();
  const timerEl = document.getElementById('workoutTimerLabel');
  if(isToday){
    timerEl.textContent = formatElapsed(Date.now()-activeWorkout.startedAt);
  } else {
    const d = parseISO(activeWorkout.date);
    timerEl.textContent = d.toLocaleDateString(undefined,{weekday:'short', month:'short', day:'numeric'});
  }

  const banner = document.getElementById('backdateBanner');
  banner.style.display = isToday ? 'none' : 'block';
  if(!isToday){
    const durInput = document.getElementById('backdateDuration');
    if(document.activeElement !== durInput){
      durInput.value = activeWorkout.manualDurationMin || '';
    }
    durInput.oninput = (e)=>{
      const v = parseInt(e.target.value);
      activeWorkout.manualDurationMin = isNaN(v) ? undefined : v;
      debouncedPersistActiveWorkout();
    };
  }

  renderRestDurationChips();

  const wrap = document.getElementById('workoutExerciseCards');
  const empty = document.getElementById('workoutEmptyState');
  if(activeWorkout.exercises.length===0){
    wrap.innerHTML='';
    empty.style.display='block';
    // still need finish bar controls
    ensureFinishBar();
    return;
  }
  empty.style.display='none';

  wrap.innerHTML = activeWorkout.exercises.map((ex,exIdx)=>{
    const isWalk = ex.sets.length===1 && ex.sets[0].isWalk;

    if(isWalk){
      const w = ex.sets[0];
      const bw = state.settings.bodyWeightKg || 75;
      const kcal = Math.round(estimateInclineWalkKcal(w.speed, w.incline, w.duration, bw));
      return `<div class="logging-exercise-card" data-ex-idx="${exIdx}">
        <div class="logging-exercise-header">
          <h3>${ex.name}</h3>
          <button class="remove-ex-btn" data-remove-ex="${exIdx}">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6h14z"/></svg>
          </button>
        </div>
        <div class="stat-grid" style="grid-template-columns:repeat(4,1fr); margin-bottom:0;">
          <div class="stat-box"><div class="v num">${w.speed}</div><div class="l">km/h</div></div>
          <div class="stat-box"><div class="v num">${w.incline}%</div><div class="l">Incline</div></div>
          <div class="stat-box"><div class="v num">${w.duration}</div><div class="l">Minutes</div></div>
          <div class="stat-box"><div class="v num" style="color:var(--positive);">${kcal}</div><div class="l">Kcal</div></div>
        </div>
      </div>`;
    }

    const exDef = findExercise(ex.exId) || {name:ex.name, met:4.5};
    const isAssisted = !!exDef.assisted;
    const history = getExerciseHistory(ex.exId);
    const workingSets = ex.sets.filter(s=>!s.warmup);

    let isPR = false, best = 0, sparkPoints = [], oneRM = null, isOneRmPR = false;
    if(isAssisted){
      const bests = history.map(h=>h.minWeight);
      best = bests.length ? Math.min(...bests) : null;
      const currentAssistValues = workingSets.map(s=>parseFloat(s.weight)).filter(w=>!isNaN(w) && w>=0);
      const currentMin = currentAssistValues.length ? Math.min(...currentAssistValues) : null;
      isPR = best!==null && currentMin!==null && currentMin<best;
      sparkPoints = history.slice(-6).map(h=>h.minWeight);
    } else {
      best = history.length ? Math.max(...history.map(h=>h.maxWeight)) : 0;
      const currentMax = Math.max(0,...workingSets.map(s=>parseFloat(s.weight)||0));
      isPR = best>0 && currentMax>best;
      sparkPoints = history.slice(-6).map(h=>h.maxWeight);

      // 1RM estimate from the current session's heaviest working set
      const bestCurrentSet = workingSets.reduce((a,b)=>{
        const aw = parseFloat(a && a.weight)||0, bw = parseFloat(b.weight)||0;
        return bw>aw ? b : a;
      }, null);
      if(bestCurrentSet){
        oneRM = estimate1RM(parseFloat(bestCurrentSet.weight)||0, parseFloat(bestCurrentSet.reps)||0);
      }
      if(oneRM!==null && history.length){
        const historicalBest1RMs = history.map(h=>estimate1RM(h.bestSetWeight, h.bestSetReps)).filter(v=>v!==null);
        const best1RM = historicalBest1RMs.length ? Math.max(...historicalBest1RMs) : 0;
        isOneRmPR = best1RM>0 && oneRM>best1RM;
      }
    }

    const sparkline = sparkPoints.length>=2 ? buildSparkline(sparkPoints, isAssisted) : '';

    let lastTimeText = null;
    if(!isWalk && history.length){
      const last = history[history.length-1];
      if(last.bestSetWeight!=null && last.bestSetReps!=null){
        const assistLabel = isAssisted ? ' assist' : '';
        lastTimeText = `${kgToDisplay(last.bestSetWeight)}${unitLabel()}${assistLabel} × ${last.bestSetReps}`;
      }
    }

    return `<div class="logging-exercise-card" data-ex-idx="${exIdx}">
      <div class="logging-exercise-header">
        <h3>${ex.name}</h3>
        <button class="remove-ex-btn" data-remove-ex="${exIdx}">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6h14z"/></svg>
        </button>
      </div>
      ${isAssisted ? `<div class="pill" style="margin-bottom:10px; color:var(--cyan); border-color:#3ad6ff40; background:#3ad6ff14;">
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="margin-right:4px;"><path d="M12 5v14M5 12l7 7 7-7"/></svg>
        Lower assistance is better
      </div>` : ''}
      ${lastTimeText ? `<div class="last-time-label">Last time: <span class="num">${lastTimeText}</span></div>` : ''}
      ${sparkline ? `<div class="sparkline-row">${sparkline}<span class="sparkline-label">last ${sparkPoints.length} sessions</span>${isPR?'<span class="pr-badge">PR</span>':''}${oneRM!==null?`<span class="one-rm-badge ${isOneRmPR?'is-pr':''}">~${kgToDisplay(Math.round(oneRM*10)/10)}${unitLabel()} 1RM</span>`:''}</div>` : ''}
      <div class="set-headers">
        <span>#</span><span>${unitLabel()}${isAssisted?' assist':''}</span><span>Reps</span><span>Difficulty</span><span></span>
      </div>
      ${ex.sets.map((set,setIdx)=>`
        <div class="set-row ${set.warmup?'warmup':''}">
          <div class="set-num num" data-toggle-warmup="${exIdx}:${setIdx}" title="Tap to mark as warm-up">${set.warmup?'W':setIdx+1}</div>
          <input type="number" inputmode="decimal" placeholder="0" value="${set.weight===0?'0':(set.weight||'')}" data-set-field="weight" data-ex-idx="${exIdx}" data-set-idx="${setIdx}">
          <input type="number" inputmode="numeric" placeholder="0" value="${set.reps||''}" data-set-field="reps" data-ex-idx="${exIdx}" data-set-idx="${setIdx}">
          <div class="difficulty-group" data-ex-idx="${exIdx}" data-set-idx="${setIdx}">
            <button type="button" class="difficulty-btn ${(set.difficulty||'medium')==='easy'?'active':''}" data-diff="easy">E</button>
            <button type="button" class="difficulty-btn ${(set.difficulty||'medium')==='medium'?'active':''}" data-diff="medium">M</button>
            <button type="button" class="difficulty-btn ${(set.difficulty||'medium')==='hard'?'active':''}" data-diff="hard">H</button>
          </div>
          <button class="set-check ${set.done?'checked':''}" data-toggle-done="${exIdx}:${setIdx}">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>
          </button>
        </div>
      `).join('')}
      <button class="add-set-btn" data-add-set="${exIdx}">+ Add set</button>
      <textarea class="notes-input" rows="1" placeholder="Notes (optional)" data-notes-ex="${exIdx}">${ex.notes||''}</textarea>
    </div>`;
  }).join('');

  ensureFinishBar();
  attachWorkoutCardListeners();
}

/* ---------------- REST DURATION PICKER ---------------- */
function renderRestDurationChips(){
  const current = activeWorkout.restDuration || 90;
  document.querySelectorAll('#restDurationChips .rest-chip').forEach(chip=>{
    chip.classList.toggle('active', +chip.dataset.rest===current);
  });
}

document.getElementById('restDurationChips').addEventListener('click', (e)=>{
  const chip = e.target.closest('.rest-chip');
  if(!chip || !activeWorkout) return;
  activeWorkout.restDuration = +chip.dataset.rest;
  persistActiveWorkout();
  renderRestDurationChips();
});

/* ---------------- REST TIMER ----------------
   Starts automatically whenever a set is checked off. Runs independently
   of renderWorkoutView() re-renders (its own interval + DOM node) so
   typing in other fields or adding sets doesn't interrupt the countdown.
------------------------------------------------- */
let restTimer = {
  active: false,
  totalSeconds: 0,
  remainingSeconds: 0,
  intervalId: null,
  audioCtx: null
};

function startRestTimer(seconds){
  stopRestTimer(); // clear any existing one first
  primeAudioContext(); // must happen inside this user-gesture call stack so the
                        // browser allows audio playback later when the timer fires
  restTimer.active = true;
  restTimer.totalSeconds = seconds;
  restTimer.remainingSeconds = seconds;
  ensureRestTimerBar();
  renderRestTimerBar();
  restTimer.intervalId = setInterval(()=>{
    restTimer.remainingSeconds--;
    if(restTimer.remainingSeconds <= 0){
      restTimer.remainingSeconds = 0;
      renderRestTimerBar();
      onRestTimerComplete();
      return;
    }
    renderRestTimerBar();
  }, 1000);
}

function primeAudioContext(){
  try{
    if(!restTimer.audioCtx){
      restTimer.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    if(restTimer.audioCtx.state === 'suspended') restTimer.audioCtx.resume();
  }catch(e){
    console.warn('Could not initialize audio context', e);
  }
}

function stopRestTimer(){
  if(restTimer.intervalId) clearInterval(restTimer.intervalId);
  restTimer.intervalId = null;
  restTimer.active = false;
  removeRestTimerBar();
}

function addRestTime(deltaSeconds){
  if(!restTimer.active) return;
  restTimer.remainingSeconds = Math.max(0, restTimer.remainingSeconds + deltaSeconds);
  restTimer.totalSeconds = Math.max(restTimer.totalSeconds, restTimer.remainingSeconds);
  renderRestTimerBar();
}

function onRestTimerComplete(){
  clearInterval(restTimer.intervalId);
  restTimer.intervalId = null;
  playRestTimerAlert();
  const bar = document.getElementById('restTimerBar');
  if(bar) bar.classList.add('done');
  const title = document.getElementById('restTimerTitle');
  if(title) title.textContent = 'Rest complete';
  const sub = document.getElementById('restTimerSub');
  if(sub) sub.textContent = 'Tap to dismiss';
  // auto-dismiss a few seconds after completion if the user doesn't interact
  setTimeout(()=>{
    if(restTimer.active && restTimer.remainingSeconds<=0) stopRestTimer();
  }, 6000);
}

function ensureRestTimerBar(){
  if(document.getElementById('restTimerBar')) return;
  const bar = document.createElement('div');
  bar.className = 'rest-timer-bar';
  bar.id = 'restTimerBar';
  bar.innerHTML = `
    <div class="rest-timer-ring">
      <svg width="48" height="48" viewBox="0 0 48 48">
        <circle class="bg-ring" cx="24" cy="24" r="20" fill="none" stroke-width="4"/>
        <circle class="fg-ring" id="restRingFg" cx="24" cy="24" r="20" fill="none" stroke-width="4" stroke-dasharray="126" stroke-dashoffset="0"/>
      </svg>
      <div class="rest-timer-ring-label num" id="restRingLabel">0:00</div>
    </div>
    <div class="rest-timer-info">
      <div class="rest-timer-title" id="restTimerTitle">Resting</div>
      <div class="rest-timer-sub" id="restTimerSub">Next set coming up</div>
    </div>
    <div class="rest-timer-actions">
      <button class="rest-timer-btn" id="btnRestMinus15" aria-label="Subtract 15 seconds">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M5 12h14"/></svg>
      </button>
      <button class="rest-timer-btn" id="btnRestSkip" aria-label="Skip rest">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 4l10 8-10 8V4zM19 5v14"/></svg>
      </button>
    </div>
  `;
  document.body.appendChild(bar);
  document.getElementById('btnRestMinus15').addEventListener('click', ()=>addRestTime(-15));
  document.getElementById('btnRestSkip').addEventListener('click', stopRestTimer);
  bar.addEventListener('click', (e)=>{
    // tapping the bar itself (not the action buttons) dismisses once complete
    if(restTimer.remainingSeconds<=0 && !restTimer.intervalId) stopRestTimer();
  });
}

function removeRestTimerBar(){
  const bar = document.getElementById('restTimerBar');
  if(bar) bar.remove();
}

function renderRestTimerBar(){
  const label = document.getElementById('restRingLabel');
  const ring = document.getElementById('restRingFg');
  if(!label || !ring) return;
  const m = Math.floor(restTimer.remainingSeconds/60);
  const s = (restTimer.remainingSeconds%60).toString().padStart(2,'0');
  label.textContent = `${m}:${s}`;
  const circumference = 126;
  const pct = restTimer.totalSeconds>0 ? restTimer.remainingSeconds/restTimer.totalSeconds : 0;
  ring.style.strokeDashoffset = circumference*(1-pct);
}

function playRestTimerAlert(){
  // vibration for haptic feedback, if supported
  if(navigator.vibrate) navigator.vibrate([200,100,200,100,300]);
  // Web Audio tone so it's audible over music without needing an audio
  // asset file; three ascending beeps, distinct from typical notification sounds.
  try{
    if(!restTimer.audioCtx){
      restTimer.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    const ctx = restTimer.audioCtx;
    if(ctx.state === 'suspended') ctx.resume();
    const notes = [880, 1046.5, 1318.5]; // A5, C6, E6 — bright, cuts through mixes
    notes.forEach((freq, i)=>{
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      const startTime = ctx.currentTime + i*0.18;
      gain.gain.setValueAtTime(0, startTime);
      gain.gain.linearRampToValueAtTime(0.35, startTime+0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, startTime+0.32);
      osc.connect(gain).connect(ctx.destination);
      osc.start(startTime);
      osc.stop(startTime+0.35);
    });
  }catch(e){
    console.warn('Rest timer audio alert failed', e);
  }
}

function ensureFinishBar(){
  if(document.getElementById('finishBar')) return;
  const bar = document.createElement('div');
  bar.className = 'finish-bar';
  bar.id = 'finishBar';
  bar.innerHTML = `
    <button class="btn btn-ghost" id="btnCancelWorkout">Cancel</button>
    <button class="btn btn-primary" id="btnFinishWorkout">Finish session</button>
  `;
  document.body.appendChild(bar);
  document.getElementById('btnCancelWorkout').addEventListener('click', cancelWorkout);
  document.getElementById('btnFinishWorkout').addEventListener('click', finishWorkout);
}

function removeFinishBar(){
  const bar = document.getElementById('finishBar');
  if(bar) bar.remove();
}

function attachWorkoutCardListeners(){
  document.querySelectorAll('[data-set-field]').forEach(input=>{
    input.addEventListener('input', (e)=>{
      const exIdx = +e.target.dataset.exIdx, setIdx = +e.target.dataset.setIdx, field = e.target.dataset.setField;
      activeWorkout.exercises[exIdx].sets[setIdx][field] = e.target.value;
      debouncedPersistActiveWorkout();
    });
  });
  document.querySelectorAll('.difficulty-btn').forEach(btn=>{
    btn.addEventListener('click', (e)=>{
      const group = e.currentTarget.closest('.difficulty-group');
      const exIdx = +group.dataset.exIdx, setIdx = +group.dataset.setIdx;
      activeWorkout.exercises[exIdx].sets[setIdx].difficulty = e.currentTarget.dataset.diff;
      group.querySelectorAll('.difficulty-btn').forEach(b=>b.classList.toggle('active', b===e.currentTarget));
      persistActiveWorkout();
    });
  });
  document.querySelectorAll('[data-toggle-warmup]').forEach(el=>{
    el.addEventListener('click', (e)=>{
      const [exIdx,setIdx] = e.currentTarget.dataset.toggleWarmup.split(':').map(Number);
      const set = activeWorkout.exercises[exIdx].sets[setIdx];
      set.warmup = !set.warmup;
      renderWorkoutView();
    });
  });
  document.querySelectorAll('[data-toggle-done]').forEach(btn=>{
    btn.addEventListener('click', (e)=>{
      const [exIdx,setIdx] = e.currentTarget.dataset.toggleDone.split(':').map(Number);
      const set = activeWorkout.exercises[exIdx].sets[setIdx];
      set.done = !set.done;
      if(set.done){
        startRestTimer(activeWorkout.restDuration || 90);
      }
      renderWorkoutView();
    });
  });
  document.querySelectorAll('[data-add-set]').forEach(btn=>{
    btn.addEventListener('click', (e)=>{
      const exIdx = +e.currentTarget.dataset.addSet;
      const sets = activeWorkout.exercises[exIdx].sets;
      const last = sets[sets.length-1];
      sets.push({weight:last?last.weight:'', reps:last?last.reps:'', difficulty:'medium', done:false});
      renderWorkoutView();
    });
  });
  document.querySelectorAll('[data-remove-ex]').forEach(btn=>{
    btn.addEventListener('click', (e)=>{
      const exIdx = +e.currentTarget.dataset.removeEx;
      activeWorkout.exercises.splice(exIdx,1);
      renderWorkoutView();
    });
  });
  document.querySelectorAll('[data-notes-ex]').forEach(ta=>{
    ta.addEventListener('input',(e)=>{
      activeWorkout.exercises[+e.target.dataset.notesEx].notes = e.target.value;
      debouncedPersistActiveWorkout();
    });
  });
}

let persistDebounceTimer = null;
function debouncedPersistActiveWorkout(){
  clearTimeout(persistDebounceTimer);
  persistDebounceTimer = setTimeout(persistActiveWorkout, 400);
}

function buildSparkline(points, invert){
  const w=90,h=26,pad=3;
  const min = Math.min(...points), max = Math.max(...points);
  const range = (max-min)||1;
  const stepX = (w-pad*2)/(points.length-1);
  const coords = points.map((p,i)=>{
    const x = pad+i*stepX;
    // normal: higher value draws higher on the chart (lower y).
    // inverted (assisted exercises): lower value draws higher, since less
    // assistance is the improvement direction.
    const normalized = invert ? (max-p)/range : (p-min)/range;
    const y = h-pad-normalized*(h-pad*2);
    return [x,y];
  });
  const path = coords.map((c,i)=>(i===0?'M':'L')+c[0].toFixed(1)+' '+c[1].toFixed(1)).join(' ');
  const lastPoint = coords[coords.length-1];
  const color = invert ? '#3ad6ff' : '#39ff9a';
  return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
    <path d="${path}" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
    <circle cx="${lastPoint[0]}" cy="${lastPoint[1]}" r="2.5" fill="${color}"/>
  </svg>`;
}

function getExerciseHistory(exId){
  const out = [];
  const exDef = findExercise(exId);
  const isAssisted = exDef && exDef.assisted;
  const sorted = [...state.sessions].sort((a,b)=>a.date.localeCompare(b.date));
  sorted.forEach(s=>{
    const ex = s.exercises.find(e=>e.exId===exId);
    if(ex && ex.sets && ex.sets.length){
      // warm-up sets don't count toward PRs, "best", or 1RM estimates
      const workingSets = ex.sets.filter(st=>!st.warmup);
      // For assisted exercises, 0kg assistance is a real, meaningful value
      // (full bodyweight, no help) so it must not be filtered out. For normal
      // lifts, 0 means "not entered" and should be excluded.
      const validSets = workingSets.filter(st=>{
        const w = parseFloat(st.weight);
        return !isNaN(w) && (isAssisted ? w>=0 : w>0);
      });
      if(validSets.length){
        const weights = validSets.map(st=>parseFloat(st.weight));
        const maxWeight = Math.max(...weights);
        const minWeight = Math.min(...weights);
        // best set = heaviest (or least-assisted) working set, used for 1RM
        const bestSet = isAssisted
          ? validSets.reduce((a,b)=> parseFloat(b.weight)<parseFloat(a.weight) ? b : a)
          : validSets.reduce((a,b)=> parseFloat(b.weight)>parseFloat(a.weight) ? b : a);
        out.push({
          date:s.date,
          maxWeight,
          minWeight,
          bestSetWeight: parseFloat(bestSet.weight),
          bestSetReps: parseFloat(bestSet.reps)||0
        });
      }
    }
  });
  return out;
}

// Epley formula: 1RM = weight × (1 + reps/30). Reps of 1 returns the weight
// itself; accuracy degrades past ~12 reps but it's the standard estimate.
function estimate1RM(weight, reps){
  if(!weight || !reps || reps<=0) return null;
  if(reps===1) return weight;
  return weight * (1 + reps/30);
}

// Short "last time" summary for the exercise picker, e.g. "100kg × 10" or,
// for incline walk, "8% @ 5.5km/h · 30min". Returns null if never logged.
function getLastPerformance(exId){
  const def = findExercise(exId);
  if(!def) return null;

  if(def.special==='incline_walk'){
    const sorted = [...state.sessions].sort((a,b)=>b.date.localeCompare(a.date));
    for(const s of sorted){
      const ex = s.exercises.find(e=>e.exId===exId && e.sets && e.sets[0] && e.sets[0].isWalk);
      if(ex){
        const w = ex.sets[0];
        return `${w.incline}% @ ${w.speed}km/h · ${w.duration}min`;
      }
    }
    return null;
  }

  const history = getExerciseHistory(exId);
  if(!history.length) return null;
  const last = history[history.length-1];
  if(last.bestSetWeight==null || last.bestSetReps==null) return null;
  const displayWeight = kgToDisplay(last.bestSetWeight);
  const assistLabel = def.assisted ? ' assist' : '';
  return `${displayWeight}${unitLabel()}${assistLabel} × ${last.bestSetReps}`;
}

function cancelWorkout(){
  if(activeWorkout.exercises.length>0){
    if(!confirm('Discard this session? All logged sets will be lost.')) return;
  }
  activeWorkout = null;
  persistActiveWorkout();
  clearInterval(workoutTimerInterval);
  removeFinishBar();
  stopRestTimer();
  showView('home');
}

function finishWorkout(){
  if(activeWorkout.exercises.length===0){
    toast('Add at least one exercise first');
    return;
  }
  const isToday = activeWorkout.date===todayISO();
  const durationMin = isToday
    ? Math.max(1, Math.round((Date.now()-activeWorkout.startedAt)/60000))
    : (activeWorkout.manualDurationMin || 45);
  const bodyWeightKg = state.settings.bodyWeightKg || 75;

  let totalKcal = 0;
  const exercisesOut = activeWorkout.exercises.map(ex=>{
    const isWalk = ex.sets.length===1 && ex.sets[0].isWalk;

    if(isWalk){
      const w = ex.sets[0];
      const kcal = estimateInclineWalkKcal(w.speed, w.incline, w.duration, bodyWeightKg);
      totalKcal += kcal;
      return {
        exId: ex.exId,
        name: ex.name,
        sets: [{...w}],
        notes: ex.notes||''
      };
    }

    const def = findExercise(ex.exId) || {met:4.5};
    const kcal = estimateStrengthExerciseKcal(def, ex.sets, bodyWeightKg);
    totalKcal += kcal;
    return {
      exId: ex.exId,
      name: ex.name,
      sets: ex.sets.filter(s=>s.weight||s.reps||s.done).map(s=>({
        weight: displayToKgIfNeeded(s.weight),
        reps: s.reps||'',
        difficulty: s.difficulty||'medium',
        warmup: !!s.warmup,
        done: !!s.done
      })),
      notes: ex.notes||''
    };
  }).filter(ex=>ex.sets.length>0);

  if(exercisesOut.length===0){
    toast('Log at least one set before finishing');
    return;
  }

  const session = {
    id: uid(),
    date: activeWorkout.date,
    exercises: exercisesOut,
    durationMin,
    kcal: Math.round(totalKcal),
    type: 'strength'
  };

  // merge with existing session on that date if present
  const existingIdx = state.sessions.findIndex(s=>s.date===session.date && s.type==='strength');
  if(existingIdx>=0){
    const existing = state.sessions[existingIdx];
    existing.exercises = existing.exercises.concat(exercisesOut);
    existing.kcal += session.kcal;
    existing.durationMin += durationMin;
  } else {
    state.sessions.push(session);
  }
  saveState();

  activeWorkout = null;
  persistActiveWorkout();
  clearInterval(workoutTimerInterval);
  removeFinishBar();
  stopRestTimer();
  showSessionSummary(session);
}

function displayToKgIfNeeded(val){
  if(val==='' || val==null) return val;
  const n = parseFloat(val);
  if(isNaN(n)) return val;
  return state.settings.useLbs ? Math.round((n/LB_PER_KG)*100)/100 : n;
}

let lastFinishedSession = null;

function showSessionSummary(session){
  lastFinishedSession = session;
  const content = document.getElementById('summaryContent');
  const totalSets = session.exercises.reduce((a,e)=>a+e.sets.length,0);
  const d = parseISO(session.date);
  const isToday = session.date===todayISO();
  content.innerHTML = `
    ${!isToday ? `<p class="text-sm text-muted mb-12">Logged for ${d.toLocaleDateString(undefined,{weekday:'long', month:'long', day:'numeric'})}</p>` : ''}
    <div class="stat-grid" style="grid-template-columns:repeat(3,1fr);">
      <div class="stat-box"><div class="v num">${session.exercises.length}</div><div class="l">Exercises</div></div>
      <div class="stat-box"><div class="v num">${totalSets}</div><div class="l">Sets</div></div>
      <div class="stat-box"><div class="v num" style="color:var(--positive);">${session.kcal}</div><div class="l">Kcal burned</div></div>
    </div>
    <div class="mt-16">
      ${session.exercises.map(e=>`<div class="row" style="padding:8px 2px; border-bottom:1px solid var(--border-soft);">
        <span class="text-sm">${e.name}</span>
        <span class="text-sm text-faint num">${e.sets.length} sets</span>
      </div>`).join('')}
    </div>
  `;
  document.getElementById('sheetSessionSummary').dataset.returnDate = session.date;
  openSheet('sheetSessionSummary');
}

document.getElementById('btnCloseSummary').addEventListener('click', ()=>{
  closeSheet('sheetSessionSummary');
  const returnDate = document.getElementById('sheetSessionSummary').dataset.returnDate;
  if(returnDate && returnDate!==todayISO()){
    calCursor = parseISO(returnDate);
    showView('calendar');
  } else {
    showView('home');
  }
});

document.getElementById('btnSaveAsTemplate').addEventListener('click', ()=>{
  if(!lastFinishedSession) return;
  closeSheet('sheetSessionSummary');
  document.getElementById('templateNameInput').value = suggestTemplateName();
  openSheet('sheetSaveTemplate');
});

function suggestTemplateName(){
  if(!lastFinishedSession) return '';
  const d = parseISO(lastFinishedSession.date);
  const weekday = d.toLocaleDateString(undefined,{weekday:'long'});
  return `${weekday} session`;
}

document.getElementById('btnConfirmSaveTemplate').addEventListener('click', ()=>{
  if(!lastFinishedSession) return;
  const name = (document.getElementById('templateNameInput').value||'').trim();
  if(!name){ toast('Enter a routine name'); return; }

  // dedupe exercise IDs while preserving order; skip walk-type entries
  // since they capture live session data (speed/incline/duration), not a
  // repeatable set structure.
  const exIds = [];
  lastFinishedSession.exercises.forEach(ex=>{
    const isWalk = ex.sets.length===1 && ex.sets[0].isWalk;
    if(isWalk) return;
    if(!exIds.includes(ex.exId)) exIds.push(ex.exId);
  });

  if(exIds.length===0){
    toast('Nothing to save — no strength exercises in this session');
    closeSheet('sheetSaveTemplate');
    return;
  }

  state.templates.push({
    id: uid(),
    name,
    exIds,
    createdAt: Date.now()
  });
  saveState();
  closeSheet('sheetSaveTemplate');
  toast(`Routine "${name}" saved`);
  showView('home');
});

/* ---------------- EXERCISE LIBRARY (picker) ---------------- */
let activeMuscleFilter = 'all';

function renderMuscleFilters(){
  const wrap = document.getElementById('muscleFilterScroll');
  wrap.innerHTML = MUSCLE_GROUPS.map(g=>
    `<button class="chip ${g.id===activeMuscleFilter?'active':''}" data-muscle="${g.id}">${g.label}</button>`
  ).join('');
  wrap.querySelectorAll('.chip').forEach(chip=>{
    chip.addEventListener('click', ()=>{
      activeMuscleFilter = chip.dataset.muscle;
      renderExerciseLibrary();
    });
  });
}

function renderExerciseLibrary(){
  renderMuscleFilters();
  const barWrap = document.getElementById('activeSessionBarWrap');
  if(pickerMode==='template'){
    barWrap.innerHTML = `<div class="pill pill-accent mb-12">Building routine — tap an exercise to add it</div>`;
  } else {
    barWrap.innerHTML = activeWorkout ? `<div class="pill pill-accent mb-12">Session active — adding to current workout</div>` : '';
  }

  const query = (document.getElementById('exerciseSearchInput').value||'').toLowerCase().trim();
  let list = allExercises().filter(e=>{
    const matchesMuscle = activeMuscleFilter==='all' || e.muscle===activeMuscleFilter;
    const matchesQuery = !query || e.name.toLowerCase().includes(query);
    // incline walk has no meaningful set structure, so exclude it from template building
    if(pickerMode==='template' && e.special==='incline_walk') return false;
    return matchesMuscle && matchesQuery;
  });

  const container = document.getElementById('exerciseLibraryList');
  if(list.length===0){
    container.innerHTML = `<div class="empty-state">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>
      <p>No exercises match "${query}".</p>
    </div>`;
    return;
  }

  container.innerHTML = list.map(e=>{
    const lastPerf = getLastPerformance(e.id);
    return `
    <div class="exercise-list-item" data-ex-id="${e.id}">
      <div class="ex-icon">${e.icon}</div>
      <div class="ex-info">
        <div class="ex-name">${e.name}${e.assisted ? ' <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#3ad6ff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:1px;"><path d="M12 5v14M5 12l7 7 7-7"/></svg>' : ''}</div>
        <div class="ex-meta">${capitalize(e.muscle)} · ${capitalize(e.type)}${e.assisted ? ' · Assisted' : ''}</div>
        ${lastPerf ? `<div class="ex-last-perf num">Last: ${lastPerf}</div>` : ''}
      </div>
      <button class="ex-add-btn" data-add-ex="${e.id}">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>
      </button>
    </div>
  `;
  }).join('');

  const handleTap = (exId)=>{
    if(pickerMode==='template'){
      addExerciseToTemplateDraft(exId);
    } else {
      addExerciseToWorkout(exId);
    }
  };
  container.querySelectorAll('[data-add-ex]').forEach(btn=>{
    btn.addEventListener('click', (e)=>{
      e.stopPropagation();
      handleTap(btn.dataset.addEx);
    });
  });
  container.querySelectorAll('.exercise-list-item').forEach(item=>{
    item.addEventListener('click', ()=>{
      handleTap(item.dataset.exId);
    });
  });
}

function addExerciseToTemplateDraft(exId){
  const def = findExercise(exId);
  if(!def) return;
  if(editingTemplateExIds.includes(exId)){
    toast(`${def.name} already in routine`);
    return;
  }
  editingTemplateExIds.push(exId);
  toast(`Added ${def.name}`);
  pickerMode = 'session';
  showView('templates');
  refreshTemplateEditorSheet(); // preserves name input, since nameValue is undefined
  openSheet('sheetEditTemplate');
}

function capitalize(s){ return s.charAt(0).toUpperCase()+s.slice(1); }

function addExerciseToWorkout(exId){
  const def = findExercise(exId);
  if(!def) return;
  if(def.special==='incline_walk'){
    openWalkSheet('session');
    return;
  }
  if(!activeWorkout){
    activeWorkout = {startedAt: Date.now(), date: todayISO(), exercises:[], restDuration: 90};
    startWorkoutTimer();
  }
  activeWorkout.exercises.unshift({
    exId: def.id,
    name: def.name,
    sets: [{weight:'', reps:'', difficulty:'medium', done:false}],
    notes:''
  });
  toast(`Added ${def.name}`);
  showView('workout');
  renderWorkoutView();
}

document.getElementById('exerciseSearchInput').addEventListener('input', renderExerciseLibrary);

/* ---------------- QUICK WALK LOGGING ---------------- */
let walkSheetMode = 'standalone'; // 'standalone' saves directly; 'session' adds to activeWorkout

document.getElementById('btnQuickWalk').addEventListener('click', ()=>{
  openWalkSheet('standalone');
});

function openWalkSheet(mode){
  walkSheetMode = mode;
  document.getElementById('walkDuration').value = 30;
  document.getElementById('walkSpeed').value = 5.5;
  document.getElementById('walkIncline').value = 8;
  document.getElementById('btnSaveWalk').textContent = mode==='session' ? 'Add to session' : "Save to today's log";
  updateWalkPreview();
  openSheet('sheetQuickWalk');
}

['walkDuration','walkSpeed','walkIncline'].forEach(id=>{
  document.getElementById(id).addEventListener('input', updateWalkPreview);
});

function updateWalkPreview(){
  const dur = parseFloat(document.getElementById('walkDuration').value)||0;
  const speed = parseFloat(document.getElementById('walkSpeed').value)||0;
  const incline = parseFloat(document.getElementById('walkIncline').value)||0;
  const bw = state.settings.bodyWeightKg || 75;
  const kcal = estimateInclineWalkKcal(speed, incline, dur, bw);
  document.getElementById('walkKcalPreview').textContent = Math.round(kcal);
}

document.getElementById('btnSaveWalk').addEventListener('click', ()=>{
  const dur = parseFloat(document.getElementById('walkDuration').value)||0;
  const speed = parseFloat(document.getElementById('walkSpeed').value)||0;
  const incline = parseFloat(document.getElementById('walkIncline').value)||0;
  if(dur<=0){ toast('Enter a duration'); return; }
  const bw = state.settings.bodyWeightKg || 75;
  const kcal = Math.round(estimateInclineWalkKcal(speed, incline, dur, bw));

  const walkExercise = {
    exId: 'incline-walk',
    name: `Incline Walk (${incline}% @ ${speed} km/h)`,
    sets: [{weight:incline, reps:dur, done:true, isWalk:true, speed, incline, duration:dur}],
    notes: ''
  };

  if(walkSheetMode==='session'){
    if(!activeWorkout){
      activeWorkout = {startedAt: Date.now(), date: todayISO(), exercises:[], restDuration: 90};
      startWorkoutTimer();
    }
    activeWorkout.exercises.unshift(walkExercise);
    closeSheet('sheetQuickWalk');
    toast(`Added · ${kcal} kcal`);
    showView('workout');
    renderWorkoutView();
    return;
  }

  const session = {
    id: uid(),
    date: todayISO(),
    exercises: [walkExercise],
    durationMin: dur,
    kcal,
    type: 'walk'
  };

  const existingIdx = state.sessions.findIndex(s=>s.date===session.date && s.type==='walk');
  if(existingIdx>=0){
    state.sessions[existingIdx].exercises.push(session.exercises[0]);
    state.sessions[existingIdx].kcal += kcal;
    state.sessions[existingIdx].durationMin += dur;
  } else {
    state.sessions.push(session);
  }
  saveState();
  closeSheet('sheetQuickWalk');
  toast(`Saved · ${kcal} kcal`);
  renderHome();
});

/* ---------------- CALENDAR VIEW ---------------- */
function renderCalendar(){
  const year = calCursor.getFullYear(), month = calCursor.getMonth();
  document.getElementById('calMonthLabel').textContent = calCursor.toLocaleDateString(undefined,{month:'long', year:'numeric'});

  const dowRow = document.getElementById('calDowRow');
  dowRow.innerHTML = ['M','T','W','T','F','S','S'].map(d=>`<div class="cal-dow">${d}</div>`).join('');

  const grid = document.getElementById('calGrid');
  const firstDay = new Date(year, month, 1);
  const startOffset = (firstDay.getDay()+6)%7; // Monday=0
  const daysInMonth = new Date(year, month+1, 0).getDate();
  const today = new Date();

  let cells = [];
  for(let i=0;i<startOffset;i++) cells.push(null);
  for(let d=1; d<=daysInMonth; d++) cells.push(d);

  const sessionDatesInMonth = {};
  state.sessions.forEach(s=>{
    const sd = parseISO(s.date);
    if(sd.getFullYear()===year && sd.getMonth()===month){
      sessionDatesInMonth[sd.getDate()] = (sessionDatesInMonth[sd.getDate()]||0) + sessionTotalKcal(s);
    }
  });

  grid.innerHTML = cells.map(d=>{
    if(d===null) return `<div class="cal-cell empty"></div>`;
    const trained = sessionDatesInMonth[d]!==undefined;
    const cellDate = new Date(year,month,d);
    const isToday = sameDay(cellDate, today);
    const iso = fmtDateISO(cellDate);
    return `<div class="cal-cell ${trained?'trained':''} ${isToday?'today':''}" data-day="${d}" data-date="${iso}">
      <span class="num">${d}</span>
      ${trained?'<span class="dot"></span>':''}
    </div>`;
  }).join('');
  grid.querySelectorAll('.cal-cell[data-date]').forEach(cell=>{
    cell.addEventListener('click', ()=>onCalendarDayTap(cell.dataset.date));
  });

  // month summary
  const monthSessions = state.sessions.filter(s=>{
    const sd = parseISO(s.date);
    return sd.getFullYear()===year && sd.getMonth()===month;
  });
  document.getElementById('monthSessions').textContent = monthSessions.length;
  document.getElementById('monthKcal').textContent = Math.round(monthSessions.reduce((a,s)=>a+sessionTotalKcal(s),0));

  const list = document.getElementById('calSessionsList');
  if(monthSessions.length===0){
    list.innerHTML = `<div class="empty-state">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg>
      <p>No sessions logged this month yet.</p>
    </div>`;
  } else {
    const sorted = [...monthSessions].sort((a,b)=>b.date.localeCompare(a.date));
    list.innerHTML = sorted.map(s=>{
      const d = parseISO(s.date);
      return `<div class="session-item" data-session="${s.id}">
        <div class="session-date-badge">
          <div class="d num">${d.getDate()}</div>
          <div class="m">${d.toLocaleDateString(undefined,{weekday:'short'})}</div>
        </div>
        <div class="session-info">
          <div class="session-title">${s.exercises.length} exercise${s.exercises.length!==1?'s':''}${s.type==='walk'?' · Walk':''}</div>
          <div class="session-meta">${s.durationMin} min</div>
        </div>
        <div class="session-kcal num">${Math.round(sessionTotalKcal(s))} kcal</div>
      </div>`;
    }).join('');
  }
}

document.getElementById('calPrevMonth').addEventListener('click', ()=>{
  calCursor = new Date(calCursor.getFullYear(), calCursor.getMonth()-1, 1);
  renderCalendar();
});
document.getElementById('calNextMonth').addEventListener('click', ()=>{
  calCursor = new Date(calCursor.getFullYear(), calCursor.getMonth()+1, 1);
  renderCalendar();
});

function onCalendarDayTap(dateISO){
  const daySessions = state.sessions.filter(s=>s.date===dateISO);
  if(daySessions.length>0){
    // multiple sessions possible (strength + walk) — show the first, user can
    // also tap individual rows in the "Sessions this month" list below.
    showSessionDetail(daySessions[0]);
    return;
  }
  openAddPastSessionPrompt(dateISO);
}

function openAddPastSessionPrompt(dateISO){
  const d = parseISO(dateISO);
  const isFuture = d > new Date(new Date().setHours(23,59,59,999));
  const label = d.toLocaleDateString(undefined,{weekday:'long', month:'long', day:'numeric', year:'numeric'});
  const content = document.getElementById('exerciseDetailContent');
  content.innerHTML = `
    <div class="sheet-title">${label}</div>
    <p class="text-sm text-muted mb-12">${isFuture ? 'No session logged yet.' : 'Nothing logged for this day.'}</p>
    <button class="btn btn-primary btn-block" id="btnStartPastSession">+ Log a session for this day</button>
  `;
  openSheet('sheetExerciseDetail');
  document.getElementById('btnStartPastSession').addEventListener('click', ()=>{
    closeSheet('sheetExerciseDetail');
    startWorkout(dateISO);
  });
}

/* ---------------- PROGRESS VIEW ---------------- */
function renderProgressList(){
  const query = (document.getElementById('progressSearchInput').value||'').toLowerCase().trim();

  // build map of exId -> {name, sessions[]}
  const map = {};
  state.sessions.forEach(s=>{
    s.exercises.forEach(ex=>{
      if(!ex.sets || !ex.sets.length) return;
      if(ex.sets[0].isWalk) return; // walks tracked separately, not in strength progression
      const exDef = findExercise(ex.exId);
      const isAssisted = !!(exDef && exDef.assisted);
      if(!map[ex.exId]) map[ex.exId] = {name:ex.name, entries:[], assisted:isAssisted};
      // warm-up sets don't count toward best/PR/1RM tracking
      const workingSets = ex.sets.filter(st=>!st.warmup);
      // for assisted exercises 0kg assistance is a real, meaningful value
      // (no help at all) and must not be filtered out like a blank entry.
      const validSets = workingSets.filter(st=>{
        const w = parseFloat(st.weight);
        return !isNaN(w) && (isAssisted ? w>=0 : w>0);
      });
      const weights = validSets.map(st=>parseFloat(st.weight));
      const maxW = weights.length ? Math.max(...weights) : null;
      const minW = weights.length ? Math.min(...weights) : null;
      const bestSet = validSets.length
        ? (isAssisted
            ? validSets.reduce((a,b)=> parseFloat(b.weight)<parseFloat(a.weight) ? b : a)
            : validSets.reduce((a,b)=> parseFloat(b.weight)>parseFloat(a.weight) ? b : a))
        : null;
      const totalReps = workingSets.reduce((a,st)=>a+(parseFloat(st.reps)||0),0);
      map[ex.exId].entries.push({
        date:s.date, maxWeight:maxW, minWeight:minW,
        bestSetWeight: bestSet ? parseFloat(bestSet.weight) : null,
        bestSetReps: bestSet ? (parseFloat(bestSet.reps)||0) : null,
        sets:workingSets.length, totalReps
      });
    });
  });

  let entries = Object.entries(map);
  if(query){
    entries = entries.filter(([id,v])=>v.name.toLowerCase().includes(query));
  }
  entries.sort((a,b)=>b[1].entries.length-a[1].entries.length);

  const container = document.getElementById('progressList');
  if(entries.length===0){
    container.innerHTML = `<div class="empty-state">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M3 3v18h18"/><path d="M18 8l-5 5-3-3-4 4"/></svg>
      <p>${query? 'No matching exercises logged yet.' : 'Log a few sessions to see your strength progress here.'}</p>
    </div>`;
    return;
  }

  container.innerHTML = entries.map(([exId,v])=>{
    const sorted = v.entries.sort((a,b)=>a.date.localeCompare(b.date));
    const isAssisted = v.assisted;
    const points = isAssisted
      ? sorted.map(e=>e.minWeight).filter(w=>w!==null)
      : sorted.map(e=>e.maxWeight).filter(w=>w!==null && w>0);
    const best = points.length ? (isAssisted ? Math.min(...points) : Math.max(...points)) : null;
    const latest = sorted[sorted.length-1];
    const spark = points.length>=2 ? buildSparkline(points.slice(-10), isAssisted) : '<span class="text-faint text-sm">Not enough data</span>';
    const displayBest = best!==null ? kgToDisplay(best) : null;

    let best1RM = null;
    if(!isAssisted){
      const oneRMs = sorted.map(e=>estimate1RM(e.bestSetWeight, e.bestSetReps)).filter(v=>v!==null);
      best1RM = oneRMs.length ? Math.max(...oneRMs) : null;
    }

    return `<div class="progress-ex-card">
      <div class="progress-ex-header">
        <h3>${v.name}</h3>
        <span class="pill">${sorted.length} session${sorted.length!==1?'s':''}</span>
      </div>
      ${isAssisted ? `<div class="pill" style="margin-top:8px; color:var(--cyan); border-color:#3ad6ff40; background:#3ad6ff14;">
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="margin-right:4px;"><path d="M12 5v14M5 12l7 7 7-7"/></svg>
        Lower assistance is better
      </div>` : ''}
      <div class="sparkline-row mt-8">${spark}<span class="sparkline-label">progression</span>${best1RM!==null?`<span class="one-rm-badge">~${kgToDisplay(Math.round(best1RM*10)/10)}${unitLabel()} 1RM</span>`:''}</div>
      <div class="progress-ex-stats">
        <div class="progress-ex-stat"><div class="v num">${displayBest!==null ? displayBest : '–'}</div><div class="l">${isAssisted ? 'Least assist' : 'Best'} ${unitLabel()}</div></div>
        <div class="progress-ex-stat"><div class="v num">${latest.sets}</div><div class="l">Last sets</div></div>
        <div class="progress-ex-stat"><div class="v num">${latest.totalReps}</div><div class="l">Last reps</div></div>
      </div>
    </div>`;
  }).join('');
}

document.getElementById('progressSearchInput').addEventListener('input', renderProgressList);

/* ---------------- SETTINGS ---------------- */
function loadSettingsIntoForm(){
  document.getElementById('settingBodyWeight').value = state.settings.bodyWeightKg;
  document.getElementById('settingWeeklyGoal').value = state.settings.weeklyGoal;
  document.getElementById('toggleUnits').classList.toggle('on', state.settings.useLbs);
  updateLastBackupLabel();
}

/* ---------------- CLOUD SYNC (Firebase) ---------------- */
function initCloudSync(){
  if(!window.GymSync) return; // firebase-sync.js not loaded yet or not configured
  window.GymSync.init(handleAuthChange, handleRemoteChange);
}

function handleAuthChange({signedIn, user, remoteState}){
  const signedOutCard = document.getElementById('syncSignedOutCard');
  const signedInCard = document.getElementById('syncSignedInCard');
  if(!signedOutCard || !signedInCard) return; // settings view not in DOM yet, fine

  if(signedIn){
    signedOutCard.style.display = 'none';
    signedInCard.style.display = 'block';
    document.getElementById('syncUserName').textContent = user.name || user.email || 'Signed in';
    document.getElementById('syncUserPhoto').src = user.photo || '';
    document.getElementById('syncStatusLabel').textContent = 'Synced';

    if(remoteState){
      // merge remote into local by id, additive and non-destructive, same
      // strategy as manual backup import so no data is silently dropped
      mergeState(remoteState);
      if(remoteState.settings){
        state.settings = Object.assign({}, state.settings, remoteState.settings);
      }
      saveState();
      renderHome();
      loadSettingsIntoForm();
    } else {
      // first time this account has synced — push current local data up
      saveState();
    }
    toast('Signed in — syncing across devices');
  } else {
    signedOutCard.style.display = 'block';
    signedInCard.style.display = 'none';
  }
}

function handleRemoteChange(remoteState){
  // fired when another device pushes changes; merge additively and re-render
  if(!remoteState) return;
  mergeState(remoteState);
  if(remoteState.settings){
    state.settings = Object.assign({}, state.settings, remoteState.settings);
  }
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); // local write only, don't re-push
  if(currentView==='home') renderHome();
  if(currentView==='calendar') renderCalendar();
  if(currentView==='progress') renderProgressList();
  if(currentView==='templates') renderTemplatesFullList();
  loadSettingsIntoForm();
  toast('Synced from another device');
}

document.getElementById('btnGoogleSignIn').addEventListener('click', ()=>{
  if(window.GymSync) window.GymSync.signIn();
});
document.getElementById('btnGoogleSignOut').addEventListener('click', ()=>{
  if(window.GymSync) window.GymSync.signOut();
});

document.getElementById('settingBodyWeight').addEventListener('input', (e)=>{
  const v = parseFloat(e.target.value);
  if(!isNaN(v) && v>0){ state.settings.bodyWeightKg = v; saveState(); }
});
document.getElementById('settingWeeklyGoal').addEventListener('input', (e)=>{
  const v = parseInt(e.target.value);
  if(!isNaN(v) && v>0){ state.settings.weeklyGoal = v; saveState(); }
});
document.getElementById('toggleUnits').addEventListener('click', (e)=>{
  state.settings.useLbs = !state.settings.useLbs;
  e.target.classList.toggle('on', state.settings.useLbs);
  saveState();
  toast(state.settings.useLbs ? 'Switched to lbs' : 'Switched to kg');
});

function updateLastBackupLabel(){
  const el = document.getElementById('lastBackupLabel');
  if(state.settings.lastBackupAt){
    const d = new Date(state.settings.lastBackupAt);
    el.textContent = `Last backup exported ${d.toLocaleDateString()} at ${d.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})}`;
  } else {
    el.textContent = 'No backup exported yet.';
  }
}

/* ---------------- BACKUP / RESTORE ---------------- */
document.getElementById('btnExportBackup').addEventListener('click', ()=>{
  const payload = {
    app: 'gym-tracker',
    version: 1,
    exportedAt: new Date().toISOString(),
    data: state
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], {type:'application/json'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const stamp = todayISO();
  a.href = url;
  a.download = `gym-tracker-backup-${stamp}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);

  state.settings.lastBackupAt = Date.now();
  saveState();
  updateLastBackupLabel();
  toast('Backup exported');
});

document.getElementById('btnImportBackup').addEventListener('click', ()=>{
  document.getElementById('fileImportInput').click();
});

document.getElementById('fileImportInput').addEventListener('change', (e)=>{
  const file = e.target.files[0];
  if(!file) return;
  const reader = new FileReader();
  reader.onload = (evt)=>{
    try{
      const parsed = JSON.parse(evt.target.result);
      const incoming = parsed.data || parsed; // support raw state too
      if(!incoming.sessions || !Array.isArray(incoming.sessions)){
        toast('Invalid backup file');
        return;
      }
      const doMerge = confirm(
        `This backup contains ${incoming.sessions.length} session(s).\n\nOK = Merge with current data\nCancel = Replace current data entirely`
      );
      if(doMerge){
        mergeState(incoming);
      } else {
        state = Object.assign(defaultState(), incoming, {
          settings: Object.assign(defaultState().settings, incoming.settings||{})
        });
      }
      saveState();
      toast('Backup restored');
      renderHome();
      loadSettingsIntoForm();
    }catch(err){
      console.error(err);
      toast('Could not read backup file');
    }
  };
  reader.readAsText(file);
  e.target.value = '';
});

function mergeState(incoming){
  const existingIds = new Set(state.sessions.map(s=>s.id));
  incoming.sessions.forEach(s=>{
    if(!existingIds.has(s.id)){
      state.sessions.push(s);
    }
  });
  if(incoming.customExercises){
    const existingCustomIds = new Set(state.customExercises.map(e=>e.id));
    incoming.customExercises.forEach(e=>{
      if(!existingCustomIds.has(e.id)) state.customExercises.push(e);
    });
  }
  if(incoming.templates){
    if(!state.templates) state.templates = [];
    const existingTemplateIds = new Set(state.templates.map(t=>t.id));
    incoming.templates.forEach(t=>{
      if(!existingTemplateIds.has(t.id)) state.templates.push(t);
    });
  }
}

document.getElementById('btnResetAll').addEventListener('click', ()=>{
  if(!confirm('This will permanently erase all sessions and settings on this device. This cannot be undone. Continue?')) return;
  if(!confirm('Are you absolutely sure? Consider exporting a backup first.')) return;
  state = defaultState();
  saveState();
  toast('All data erased');
  showView('home');
});

/* ---------------- SHEETS ---------------- */
function openSheet(id){
  document.getElementById('sheetBackdrop').classList.add('open');
  document.getElementById(id).classList.add('open');
  document.body.classList.add('sheet-open');
}
function closeSheet(id){
  document.getElementById('sheetBackdrop').classList.remove('open');
  document.getElementById(id).classList.remove('open');
  document.body.classList.remove('sheet-open');
}
document.getElementById('sheetBackdrop').addEventListener('click', ()=>{
  document.querySelectorAll('.sheet.open').forEach(s=>s.classList.remove('open'));
  document.getElementById('sheetBackdrop').classList.remove('open');
  document.body.classList.remove('sheet-open');
});

/* ---------------- SWIPE-DOWN-TO-DISMISS (generic, works on any .sheet via its handle) ---------------- */
let sheetSwipe = null; // {sheetEl, startY, lastY, lastT, velocity}

function initSheetSwipeToDismiss(){
  document.querySelectorAll('.sheet-handle-hitarea').forEach(handle=>{
    handle.addEventListener('pointerdown', onSheetSwipeStart);
  });
}

function onSheetSwipeStart(e){
  const sheetEl = e.currentTarget.closest('.sheet');
  if(!sheetEl) return;
  e.preventDefault();

  sheetSwipe = {
    sheetEl,
    startY: e.clientY,
    lastY: e.clientY,
    lastT: performance.now(),
    velocity: 0
  };
  sheetEl.classList.add('dragging');

  const handle = e.currentTarget;
  handle.setPointerCapture(e.pointerId);
  handle.addEventListener('pointermove', onSheetSwipeMove);
  handle.addEventListener('pointerup', onSheetSwipeEnd);
  handle.addEventListener('pointercancel', onSheetSwipeEnd);
}

function onSheetSwipeMove(e){
  if(!sheetSwipe) return;
  const dy = e.clientY - sheetSwipe.startY;
  const clamped = Math.max(0, dy); // only allow dragging downward, not past the open position
  sheetSwipe.sheetEl.style.transform = `translateY(${clamped}px)`;

  const now = performance.now();
  const dt = now - sheetSwipe.lastT;
  if(dt>0){
    sheetSwipe.velocity = (e.clientY - sheetSwipe.lastY) / dt; // px/ms, positive = moving down
  }
  sheetSwipe.lastY = e.clientY;
  sheetSwipe.lastT = now;
}

function onSheetSwipeEnd(e){
  if(!sheetSwipe) return;
  const handle = e.currentTarget;
  handle.removeEventListener('pointermove', onSheetSwipeMove);
  handle.removeEventListener('pointerup', onSheetSwipeEnd);
  handle.removeEventListener('pointercancel', onSheetSwipeEnd);
  try{ handle.releasePointerCapture(e.pointerId); }catch(err){}

  const { sheetEl, velocity } = sheetSwipe;
  const draggedDown = Math.max(0, e.clientY - sheetSwipe.startY);
  const sheetHeight = sheetEl.getBoundingClientRect().height;
  const pastThreshold = draggedDown > sheetHeight*0.25 || draggedDown > 120;
  const fastFlick = velocity > 0.6; // quick downward flick, even if short distance

  sheetEl.classList.remove('dragging');
  sheetEl.style.transform = ''; // let the CSS class-driven transform (open/closed) take back over

  if(pastThreshold || fastFlick){
    sheetEl.classList.remove('open');
    // if no other sheet is open, also hide the shared backdrop
    if(!document.querySelector('.sheet.open')){
      document.getElementById('sheetBackdrop').classList.remove('open');
      document.body.classList.remove('sheet-open');
    }
  }
  // else: removing the inline transform naturally snaps it back to .open's translateY(0)

  sheetSwipe = null;
}

initSheetSwipeToDismiss();

/* ---------------- SESSION DETAIL (tap from list) ---------------- */
document.addEventListener('click', (e)=>{
  const item = e.target.closest('[data-session]');
  if(!item) return;
  const session = state.sessions.find(s=>s.id===item.dataset.session);
  if(!session) return;
  showSessionDetail(session);
});

function showSessionDetail(session){
  const content = document.getElementById('exerciseDetailContent');
  const d = parseISO(session.date);
  content.innerHTML = `
    <div class="sheet-title">${d.toLocaleDateString(undefined,{weekday:'long', month:'long', day:'numeric'})}</div>
    <div class="stat-grid" style="grid-template-columns:repeat(3,1fr); margin-bottom:16px;">
      <div class="stat-box"><div class="v num">${session.exercises.length}</div><div class="l">Exercises</div></div>
      <div class="stat-box"><div class="v num">${session.durationMin}</div><div class="l">Minutes</div></div>
      <div class="stat-box"><div class="v num" style="color:var(--positive);">${Math.round(sessionTotalKcal(session))}</div><div class="l">Kcal</div></div>
    </div>
    ${session.exercises.map(ex=>{
      const exDef = findExercise(ex.exId);
      const isAssisted = !!(exDef && exDef.assisted);
      return `
      <div class="mb-12">
        <div class="settings-row-label mb-8">${ex.name}${isAssisted ? ' <span class="text-faint text-sm">(assisted — lower is better)</span>' : ''}</div>
        ${ex.sets.map((s,i)=>{
          if(s.isWalk){
            return `<div class="text-sm text-muted">${s.duration} min @ ${s.speed} km/h, ${s.incline}% incline</div>`;
          }
          const wNum = parseFloat(s.weight);
          const w = kgToDisplay(isNaN(wNum) ? 0 : wNum);
          const wDisplay = (s.weight===0 || s.weight==='0' || w>0) ? w : '–';
          const diffLabel = {easy:'Easy', medium:'Medium', hard:'Hard'}[s.difficulty] || 'Medium';
          return `<div class="text-sm text-muted num">Set ${i+1}: ${wDisplay} ${unitLabel()}${isAssisted?' assist':''} × ${s.reps||'–'} reps · ${diffLabel}${s.warmup?' · <span style="color:var(--cyan);">Warm-up</span>':''}</div>`;
        }).join('')}
        ${ex.notes ? `<div class="text-sm text-faint mt-4">"${ex.notes}"</div>` : ''}
      </div>
    `;}).join('')}
    <button class="btn btn-danger btn-block mt-16" id="btnDeleteSession" data-del="${session.id}">Delete this session</button>
  `;
  openSheet('sheetExerciseDetail');
  document.getElementById('btnDeleteSession').addEventListener('click', (e)=>{
    if(confirm('Delete this session? This cannot be undone.')){
      state.sessions = state.sessions.filter(s=>s.id!==e.target.dataset.del);
      saveState();
      closeSheet('sheetExerciseDetail');
      renderHome();
      renderCalendar();
      toast('Session deleted');
    }
  });
}

/* ---------------- SERVICE WORKER / PWA ---------------- */
if('serviceWorker' in navigator){
  window.addEventListener('load', ()=>{
    navigator.serviceWorker.register('sw.js').catch(err=>console.warn('SW registration failed', err));
  });
}

/* ---------------- INIT ---------------- */
function init(){
  const restored = loadActiveWorkout();
  if(restored){
    activeWorkout = restored;
    startWorkoutTimer();
  }
  showView('home');
  loadSettingsIntoForm();
  waitForGymSyncThenInit();
}

function waitForGymSyncThenInit(attempts){
  attempts = attempts || 0;
  if(window.GymSync){
    initCloudSync();
    return;
  }
  if(attempts > 100) return; // give up after ~10s, sync module likely failed to load
  setTimeout(()=>waitForGymSyncThenInit(attempts+1), 100);
}

init();

})();
