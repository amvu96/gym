/* ============================================================
   EXERCISE DATABASE
   met = metabolic equivalent, used for calorie estimation
   type: 'strength' (sets x reps x weight) | 'cardio' (duration based) | 'bodyweight'
   ============================================================ */
const EXERCISE_DB = [
  // ---- CHEST ----
  {id:'bench-press-barbell', name:'Barbell Bench Press', muscle:'chest', icon:'🏋️', type:'strength', met:5.0, videoUrl:'https://www.youtube.com/watch?v=gRVjAtPip0Y', bodyMap:['chest', 'triceps', 'shoulders']},
  {id:'bench-press-dumbbell', name:'Dumbbell Bench Press', muscle:'chest', icon:'🏋️', type:'strength', met:5.0, bodyMap:['chest', 'triceps', 'shoulders'], videoUrl:'https://www.youtube.com/watch?v=J-gWN5hYwRU'},
  {id:'incline-bench-press', name:'Incline Bench Press', muscle:'chest', icon:'🏋️', type:'strength', met:5.0, bodyMap:['chest', 'shoulders', 'triceps'], videoUrl:'https://www.youtube.com/watch?v=SrqOu55lrYU'},
  {id:'decline-bench-press', name:'Decline Bench Press', muscle:'chest', icon:'🏋️', type:'strength', met:5.0, bodyMap:['chest', 'triceps'], videoUrl:'https://www.youtube.com/watch?v=LfyQBUKR8SE'},
  {id:'chest-fly-dumbbell', name:'Dumbbell Chest Fly', muscle:'chest', icon:'🏋️', type:'strength', met:4.5, bodyMap:['chest'], videoUrl:'https://www.youtube.com/watch?v=QENKPHhQVi4'},
  {id:'cable-crossover', name:'Cable Crossover', muscle:'chest', icon:'🏋️', type:'strength', met:4.5, bodyMap:['chest'], videoUrl:'https://www.youtube.com/watch?v=XY6JrX1wyxk'},
  {id:'push-up', name:'Push-Up', muscle:'chest', icon:'💪', type:'bodyweight', met:3.8, bodyMap:['chest', 'triceps', 'shoulders'], videoUrl:'https://www.youtube.com/watch?v=WDIpL0pjun0'},
  {id:'dips-chest', name:'Chest Dips', muscle:'chest', icon:'💪', type:'bodyweight', met:5.5, bodyMap:['chest', 'triceps'], videoUrl:'https://www.youtube.com/watch?v=yN6Q1UI_xkE'},
  {id:'dips-assisted', name:'Assisted Dips', muscle:'chest', icon:'💪', type:'strength', met:4.5, assisted:true, videoUrl:'https://www.youtube.com/watch?v=P9CkuhCc0TE', bodyMap:['chest', 'triceps']},
  {id:'pec-deck', name:'Pec Deck Machine', muscle:'chest', icon:'🏋️', type:'strength', met:4.0, bodyMap:['chest'], videoUrl:'https://www.youtube.com/watch?v=ybi3NPUK47M'},
  {id:'chest-press-machine', name:'Chest Press Machine', muscle:'chest', icon:'🏋️', type:'strength', met:4.5, videoUrl:'https://www.youtube.com/watch?v=pLofEAcfsO8', bodyMap:['chest', 'triceps', 'shoulders']},

  // ---- BACK ----
  {id:'deadlift', name:'Deadlift', muscle:'back', icon:'🏋️', type:'strength', met:6.0, videoUrl:'https://www.youtube.com/watch?v=p2OPUi4xGrM', bodyMap:['lower_back', 'glutes', 'hamstrings', 'lats']},
  {id:'pull-up', name:'Pull-Up', muscle:'back', icon:'💪', type:'bodyweight', met:8.0, bodyMap:['lats', 'biceps'], videoUrl:'https://www.youtube.com/watch?v=TMnxKjdYcME'},
  {id:'chin-up', name:'Chin-Up', muscle:'back', icon:'💪', type:'bodyweight', met:8.0, bodyMap:['lats', 'biceps'], videoUrl:'https://www.youtube.com/watch?v=liebDvbcdow'},
  {id:'pull-up-assisted', name:'Assisted Pull-Up', muscle:'back', icon:'💪', type:'strength', met:5.5, assisted:true, videoUrl:'https://www.youtube.com/watch?v=wFj808u2HWU', bodyMap:['lats', 'biceps']},
  {id:'lat-pulldown', name:'Lat Pulldown', muscle:'back', icon:'🏋️', type:'strength', met:5.0, videoUrl:'https://www.youtube.com/watch?v=Z_3xHwuO8Tk', bodyMap:['lats', 'biceps']},
  {id:'barbell-row', name:'Barbell Row', muscle:'back', icon:'🏋️', type:'strength', met:5.5, videoUrl:'https://www.youtube.com/watch?v=ML1L5ytxLMY', bodyMap:['lats', 'upper_back', 'biceps']},
  {id:'dumbbell-row', name:'Single-Arm Dumbbell Row', muscle:'back', icon:'🏋️', type:'strength', met:5.5, bodyMap:['lats', 'upper_back', 'biceps'], videoUrl:'https://www.youtube.com/watch?v=tLnlWj7LQ34'},
  {id:'seated-cable-row', name:'Seated Cable Row', muscle:'back', icon:'🏋️', type:'strength', met:5.0, videoUrl:'https://www.youtube.com/watch?v=f_r95UajQcg', bodyMap:['upper_back', 'lats', 'biceps']},
  {id:'mid-row', name:'Mid Row', muscle:'back', icon:'🏋️', type:'strength', met:5.0, bodyMap:['upper_back', 'lats'], videoUrl:'https://www.youtube.com/watch?v=bfz20jpAegk'},
  {id:'t-bar-row', name:'T-Bar Row', muscle:'back', icon:'🏋️', type:'strength', met:5.5, bodyMap:['upper_back', 'lats', 'biceps'], videoUrl:'https://www.youtube.com/watch?v=rvbjGSQ2tVE'},
  {id:'face-pull', name:'Face Pull', muscle:'back', icon:'🏋️', type:'strength', met:3.5, bodyMap:['upper_back', 'shoulders'], videoUrl:'https://www.youtube.com/watch?v=eTCBSFlCJ_s'},
  {id:'hyperextension', name:'Back Extension', muscle:'back', icon:'💪', type:'bodyweight', met:4.0, bodyMap:['lower_back', 'glutes'], videoUrl:'https://www.youtube.com/watch?v=gLT-WLH84B4'},
  {id:'good-morning', name:'Good Morning', muscle:'back', icon:'🏋️', type:'strength', met:5.0, bodyMap:['lower_back', 'hamstrings', 'glutes'], videoUrl:'https://www.youtube.com/watch?v=nWyx81AfTos'},
  {id:'shrugs', name:'Barbell Shrugs', muscle:'back', icon:'🏋️', type:'strength', met:3.5, bodyMap:['upper_back'], videoUrl:'https://www.youtube.com/watch?v=KbsQ1E8Hg0o'},

  // ---- LEGS ----
  {id:'squat-barbell', name:'Barbell Back Squat', muscle:'legs', icon:'🦵', type:'strength', met:6.0, videoUrl:'https://www.youtube.com/watch?v=8PMjqgR8Wa8', bodyMap:['quads', 'glutes', 'hamstrings']},
  {id:'front-squat', name:'Front Squat', muscle:'legs', icon:'🦵', type:'strength', met:6.0, bodyMap:['quads', 'glutes'], videoUrl:'https://www.youtube.com/watch?v=wyDbagKS7Rg'},
  {id:'leg-press', name:'Leg Press', muscle:'legs', icon:'🦵', type:'strength', met:5.0, videoUrl:'https://www.youtube.com/watch?v=ETOAyWM6i6A', bodyMap:['quads', 'glutes', 'hamstrings']},
  {id:'lunges', name:'Walking Lunges', muscle:'legs', icon:'🦵', type:'bodyweight', met:5.0, bodyMap:['quads', 'glutes', 'hamstrings'], videoUrl:'https://www.youtube.com/watch?v=Pbmj6xPo-Hw'},
  {id:'bulgarian-split-squat', name:'Bulgarian Split Squat', muscle:'legs', icon:'🦵', type:'strength', met:5.5, bodyMap:['quads', 'glutes', 'hamstrings'], videoUrl:'https://www.youtube.com/watch?v=DeCnHqrN22U'},
  {id:'leg-extension', name:'Leg Extension', muscle:'legs', icon:'🦵', type:'strength', met:4.0, bodyMap:['quads'], videoUrl:'https://www.youtube.com/watch?v=tTbJBUKnWU8'},
  {id:'leg-curl', name:'Leg Curl', muscle:'legs', icon:'🦵', type:'strength', met:4.0, bodyMap:['hamstrings'], videoUrl:'https://www.youtube.com/watch?v=hqI59xXChFk'},
  {id:'romanian-deadlift', name:'Romanian Deadlift', muscle:'legs', icon:'🦵', type:'strength', met:5.5, bodyMap:['hamstrings', 'glutes', 'lower_back']},
  {id:'hip-thrust', name:'Barbell Hip Thrust', muscle:'legs', icon:'🦵', type:'strength', met:5.0, bodyMap:['glutes', 'hamstrings']},
  {id:'calf-raise', name:'Standing Calf Raise', muscle:'legs', icon:'🦵', type:'strength', met:3.5, bodyMap:['calves']},
  {id:'seated-calf-raise', name:'Seated Calf Raise', muscle:'legs', icon:'🦵', type:'strength', met:3.5, bodyMap:['calves']},
  {id:'hack-squat', name:'Hack Squat', muscle:'legs', icon:'🦵', type:'strength', met:6.0, bodyMap:['quads', 'glutes']},
  {id:'goblet-squat', name:'Goblet Squat', muscle:'legs', icon:'🦵', type:'strength', met:5.5, bodyMap:['quads', 'glutes']},
  {id:'box-jump', name:'Box Jump', muscle:'legs', icon:'🦵', type:'bodyweight', met:8.0, bodyMap:['quads', 'glutes', 'calves']},

  // ---- SHOULDERS ----
  {id:'overhead-press', name:'Overhead Press', muscle:'shoulders', icon:'🏋️', type:'strength', met:5.0, videoUrl:'https://www.youtube.com/watch?v=ZXpdJOLNoWw', bodyMap:['shoulders', 'triceps']},
  {id:'dumbbell-shoulder-press', name:'Dumbbell Shoulder Press', muscle:'shoulders', icon:'🏋️', type:'strength', met:5.0, bodyMap:['shoulders', 'triceps']},
  {id:'lateral-raise', name:'Lateral Raise', muscle:'shoulders', icon:'🏋️', type:'strength', met:3.5, bodyMap:['shoulders']},
  {id:'front-raise', name:'Front Raise', muscle:'shoulders', icon:'🏋️', type:'strength', met:3.5, bodyMap:['shoulders']},
  {id:'rear-delt-fly', name:'Rear Delt Fly', muscle:'shoulders', icon:'🏋️', type:'strength', met:3.5, bodyMap:['shoulders', 'upper_back']},
  {id:'arnold-press', name:'Arnold Press', muscle:'shoulders', icon:'🏋️', type:'strength', met:5.0, bodyMap:['shoulders', 'triceps']},
  {id:'upright-row', name:'Upright Row', muscle:'shoulders', icon:'🏋️', type:'strength', met:4.5, bodyMap:['shoulders', 'upper_back']},
  {id:'shoulder-press-machine', name:'Shoulder Press Machine', muscle:'shoulders', icon:'🏋️', type:'strength', met:4.5, videoUrl:'https://www.youtube.com/watch?v=TnhIyp4kmO8', bodyMap:['shoulders', 'triceps']},

  // ---- ARMS ----
  {id:'bicep-curl-barbell', name:'Barbell Bicep Curl', muscle:'arms', icon:'💪', type:'strength', met:3.5, bodyMap:['biceps']},
  {id:'bicep-curl-dumbbell', name:'Dumbbell Bicep Curl', muscle:'arms', icon:'💪', type:'strength', met:3.5, videoUrl:'https://www.youtube.com/watch?v=6DeLZ6cbgWQ', bodyMap:['biceps']},
  {id:'hammer-curl', name:'Hammer Curl', muscle:'arms', icon:'💪', type:'strength', met:3.5, bodyMap:['biceps', 'forearms']},
  {id:'preacher-curl', name:'Preacher Curl', muscle:'arms', icon:'💪', type:'strength', met:3.5, bodyMap:['biceps']},
  {id:'tricep-pushdown', name:'Tricep Pushdown', muscle:'arms', icon:'💪', type:'strength', met:3.5, videoUrl:'https://www.youtube.com/watch?v=LXkCrxn3caQ', bodyMap:['triceps']},
  {id:'tricep-dip', name:'Tricep Dip', muscle:'arms', icon:'💪', type:'bodyweight', met:5.0, bodyMap:['triceps', 'chest']},
  {id:'skull-crusher', name:'Skull Crusher', muscle:'arms', icon:'💪', type:'strength', met:3.5, bodyMap:['triceps']},
  {id:'overhead-tricep-extension', name:'Overhead Tricep Extension', muscle:'arms', icon:'💪', type:'strength', met:3.5, bodyMap:['triceps']},
  {id:'close-grip-bench', name:'Close-Grip Bench Press', muscle:'arms', icon:'🏋️', type:'strength', met:4.5, bodyMap:['triceps', 'chest']},
  {id:'cable-curl', name:'Cable Bicep Curl', muscle:'arms', icon:'💪', type:'strength', met:3.5, bodyMap:['biceps']},

  // ---- CORE ----
  {id:'plank', name:'Plank', muscle:'core', icon:'🧘', type:'bodyweight', met:3.5, bodyMap:['abs']},
  {id:'crunches', name:'Crunches', muscle:'core', icon:'🧘', type:'bodyweight', met:3.5, bodyMap:['abs']},
  {id:'hanging-leg-raise', name:'Hanging Leg Raise', muscle:'core', icon:'🧘', type:'bodyweight', met:4.5, bodyMap:['abs']},
  {id:'russian-twist', name:'Russian Twist', muscle:'core', icon:'🧘', type:'bodyweight', met:4.0, bodyMap:['obliques', 'abs']},
  {id:'cable-woodchopper', name:'Cable Woodchopper', muscle:'core', icon:'🧘', type:'strength', met:4.0, bodyMap:['obliques']},
  {id:'ab-wheel', name:'Ab Wheel Rollout', muscle:'core', icon:'🧘', type:'bodyweight', met:4.5, bodyMap:['abs']},
  {id:'mountain-climbers', name:'Mountain Climbers', muscle:'core', icon:'🧘', type:'bodyweight', met:6.0, bodyMap:['abs']},
  {id:'side-plank', name:'Side Plank', muscle:'core', icon:'🧘', type:'bodyweight', met:3.5, bodyMap:['obliques']},

  // ---- CARDIO ----
  {id:'incline-walk', name:'Incline Treadmill Walk', muscle:'cardio', icon:'🚶', type:'cardio', met:0, special:'incline_walk', bodyMap:[]},
  {id:'treadmill-run', name:'Treadmill Run', muscle:'cardio', icon:'🏃', type:'cardio', met:9.8, bodyMap:['quads', 'calves']},
  {id:'stationary-bike', name:'Stationary Bike', muscle:'cardio', icon:'🚴', type:'cardio', met:7.0, bodyMap:['quads']},
  {id:'rowing-machine', name:'Rowing Machine', muscle:'cardio', icon:'🚣', type:'cardio', met:7.0, bodyMap:['lats', 'biceps', 'quads']},
  {id:'elliptical', name:'Elliptical Trainer', muscle:'cardio', icon:'🏃', type:'cardio', met:5.0, bodyMap:['quads', 'glutes']},
  {id:'stairmaster', name:'StairMaster', muscle:'cardio', icon:'🪜', type:'cardio', met:8.8, bodyMap:['quads', 'glutes', 'calves']},
  {id:'jump-rope', name:'Jump Rope', muscle:'cardio', icon:'🪢', type:'cardio', met:11.0, bodyMap:['calves']},
  {id:'swimming', name:'Swimming (freestyle)', muscle:'cardio', icon:'🏊', type:'cardio', met:8.0, bodyMap:['lats', 'shoulders']},
  {id:'cycling-outdoor', name:'Outdoor Cycling', muscle:'cardio', icon:'🚴', type:'cardio', met:8.0, bodyMap:['quads']},
  {id:'flat-walk', name:'Flat Walk', muscle:'cardio', icon:'🚶', type:'cardio', met:3.5, bodyMap:[]},

  // ---- OLYMPIC / FUNCTIONAL ----
  {id:'clean-and-jerk', name:'Clean and Jerk', muscle:'fullbody', icon:'🏋️', type:'strength', met:7.0, bodyMap:['quads', 'glutes', 'shoulders', 'upper_back']},
  {id:'snatch', name:'Snatch', muscle:'fullbody', icon:'🏋️', type:'strength', met:7.0, bodyMap:['quads', 'glutes', 'shoulders', 'upper_back']},
  {id:'kettlebell-swing', name:'Kettlebell Swing', muscle:'fullbody', icon:'🏋️', type:'strength', met:6.5, bodyMap:['glutes', 'hamstrings', 'lower_back']},
  {id:'farmers-walk', name:"Farmer's Walk", muscle:'fullbody', icon:'🏋️', type:'strength', met:5.5, bodyMap:['forearms', 'upper_back']},
  {id:'burpees', name:'Burpees', muscle:'fullbody', icon:'💪', type:'bodyweight', met:8.0, bodyMap:['chest', 'quads', 'shoulders']},
  {id:'thruster', name:'Thruster', muscle:'fullbody', icon:'🏋️', type:'strength', met:7.0, bodyMap:['quads', 'glutes', 'shoulders']},
  {id:'battle-ropes', name:'Battle Ropes', muscle:'fullbody', icon:'🏋️', type:'cardio', met:7.5, bodyMap:['shoulders', 'forearms']},
];

const MUSCLE_GROUPS = [
  {id:'all', label:'All'},
  {id:'chest', label:'Chest'},
  {id:'back', label:'Back'},
  {id:'legs', label:'Legs'},
  {id:'shoulders', label:'Shoulders'},
  {id:'arms', label:'Arms'},
  {id:'core', label:'Core'},
  {id:'cardio', label:'Cardio'},
  {id:'fullbody', label:'Full Body'},
];
