/* ============================================================
   EXERCISE DATABASE
   met = metabolic equivalent, used for calorie estimation
   type: 'strength' (sets x reps x weight) | 'cardio' (duration based) | 'bodyweight'
   ============================================================ */
const EXERCISE_DB = [
  // ---- CHEST ----
  {id:'bench-press-barbell', name:'Barbell Bench Press', muscle:'chest', icon:'🏋️', type:'strength', met:5.0},
  {id:'bench-press-dumbbell', name:'Dumbbell Bench Press', muscle:'chest', icon:'🏋️', type:'strength', met:5.0},
  {id:'incline-bench-press', name:'Incline Bench Press', muscle:'chest', icon:'🏋️', type:'strength', met:5.0},
  {id:'decline-bench-press', name:'Decline Bench Press', muscle:'chest', icon:'🏋️', type:'strength', met:5.0},
  {id:'chest-fly-dumbbell', name:'Dumbbell Chest Fly', muscle:'chest', icon:'🏋️', type:'strength', met:4.5},
  {id:'cable-crossover', name:'Cable Crossover', muscle:'chest', icon:'🏋️', type:'strength', met:4.5},
  {id:'push-up', name:'Push-Up', muscle:'chest', icon:'💪', type:'bodyweight', met:3.8},
  {id:'dips-chest', name:'Chest Dips', muscle:'chest', icon:'💪', type:'bodyweight', met:5.5},
  {id:'dips-assisted', name:'Assisted Dips', muscle:'chest', icon:'💪', type:'strength', met:4.5, assisted:true},
  {id:'pec-deck', name:'Pec Deck Machine', muscle:'chest', icon:'🏋️', type:'strength', met:4.0},
  {id:'chest-press-machine', name:'Chest Press Machine', muscle:'chest', icon:'🏋️', type:'strength', met:4.5},

  // ---- BACK ----
  {id:'deadlift', name:'Deadlift', muscle:'back', icon:'🏋️', type:'strength', met:6.0},
  {id:'pull-up', name:'Pull-Up', muscle:'back', icon:'💪', type:'bodyweight', met:8.0},
  {id:'chin-up', name:'Chin-Up', muscle:'back', icon:'💪', type:'bodyweight', met:8.0},
  {id:'pull-up-assisted', name:'Assisted Pull-Up', muscle:'back', icon:'💪', type:'strength', met:5.5, assisted:true},
  {id:'lat-pulldown', name:'Lat Pulldown', muscle:'back', icon:'🏋️', type:'strength', met:5.0},
  {id:'barbell-row', name:'Barbell Row', muscle:'back', icon:'🏋️', type:'strength', met:5.5},
  {id:'dumbbell-row', name:'Single-Arm Dumbbell Row', muscle:'back', icon:'🏋️', type:'strength', met:5.5},
  {id:'seated-cable-row', name:'Seated Cable Row', muscle:'back', icon:'🏋️', type:'strength', met:5.0},
  {id:'mid-row', name:'Mid Row', muscle:'back', icon:'🏋️', type:'strength', met:5.0},
  {id:'t-bar-row', name:'T-Bar Row', muscle:'back', icon:'🏋️', type:'strength', met:5.5},
  {id:'face-pull', name:'Face Pull', muscle:'back', icon:'🏋️', type:'strength', met:3.5},
  {id:'hyperextension', name:'Back Extension', muscle:'back', icon:'💪', type:'bodyweight', met:4.0},
  {id:'good-morning', name:'Good Morning', muscle:'back', icon:'🏋️', type:'strength', met:5.0},
  {id:'shrugs', name:'Barbell Shrugs', muscle:'back', icon:'🏋️', type:'strength', met:3.5},

  // ---- LEGS ----
  {id:'squat-barbell', name:'Barbell Back Squat', muscle:'legs', icon:'🦵', type:'strength', met:6.0},
  {id:'front-squat', name:'Front Squat', muscle:'legs', icon:'🦵', type:'strength', met:6.0},
  {id:'leg-press', name:'Leg Press', muscle:'legs', icon:'🦵', type:'strength', met:5.0},
  {id:'lunges', name:'Walking Lunges', muscle:'legs', icon:'🦵', type:'bodyweight', met:5.0},
  {id:'bulgarian-split-squat', name:'Bulgarian Split Squat', muscle:'legs', icon:'🦵', type:'strength', met:5.5},
  {id:'leg-extension', name:'Leg Extension', muscle:'legs', icon:'🦵', type:'strength', met:4.0},
  {id:'leg-curl', name:'Leg Curl', muscle:'legs', icon:'🦵', type:'strength', met:4.0},
  {id:'romanian-deadlift', name:'Romanian Deadlift', muscle:'legs', icon:'🦵', type:'strength', met:5.5},
  {id:'hip-thrust', name:'Barbell Hip Thrust', muscle:'legs', icon:'🦵', type:'strength', met:5.0},
  {id:'calf-raise', name:'Standing Calf Raise', muscle:'legs', icon:'🦵', type:'strength', met:3.5},
  {id:'seated-calf-raise', name:'Seated Calf Raise', muscle:'legs', icon:'🦵', type:'strength', met:3.5},
  {id:'hack-squat', name:'Hack Squat', muscle:'legs', icon:'🦵', type:'strength', met:6.0},
  {id:'goblet-squat', name:'Goblet Squat', muscle:'legs', icon:'🦵', type:'strength', met:5.5},
  {id:'box-jump', name:'Box Jump', muscle:'legs', icon:'🦵', type:'bodyweight', met:8.0},

  // ---- SHOULDERS ----
  {id:'overhead-press', name:'Overhead Press', muscle:'shoulders', icon:'🏋️', type:'strength', met:5.0},
  {id:'dumbbell-shoulder-press', name:'Dumbbell Shoulder Press', muscle:'shoulders', icon:'🏋️', type:'strength', met:5.0},
  {id:'lateral-raise', name:'Lateral Raise', muscle:'shoulders', icon:'🏋️', type:'strength', met:3.5},
  {id:'front-raise', name:'Front Raise', muscle:'shoulders', icon:'🏋️', type:'strength', met:3.5},
  {id:'rear-delt-fly', name:'Rear Delt Fly', muscle:'shoulders', icon:'🏋️', type:'strength', met:3.5},
  {id:'arnold-press', name:'Arnold Press', muscle:'shoulders', icon:'🏋️', type:'strength', met:5.0},
  {id:'upright-row', name:'Upright Row', muscle:'shoulders', icon:'🏋️', type:'strength', met:4.5},
  {id:'shoulder-press-machine', name:'Shoulder Press Machine', muscle:'shoulders', icon:'🏋️', type:'strength', met:4.5},

  // ---- ARMS ----
  {id:'bicep-curl-barbell', name:'Barbell Bicep Curl', muscle:'arms', icon:'💪', type:'strength', met:3.5},
  {id:'bicep-curl-dumbbell', name:'Dumbbell Bicep Curl', muscle:'arms', icon:'💪', type:'strength', met:3.5},
  {id:'hammer-curl', name:'Hammer Curl', muscle:'arms', icon:'💪', type:'strength', met:3.5},
  {id:'preacher-curl', name:'Preacher Curl', muscle:'arms', icon:'💪', type:'strength', met:3.5},
  {id:'tricep-pushdown', name:'Tricep Pushdown', muscle:'arms', icon:'💪', type:'strength', met:3.5},
  {id:'tricep-dip', name:'Tricep Dip', muscle:'arms', icon:'💪', type:'bodyweight', met:5.0},
  {id:'skull-crusher', name:'Skull Crusher', muscle:'arms', icon:'💪', type:'strength', met:3.5},
  {id:'overhead-tricep-extension', name:'Overhead Tricep Extension', muscle:'arms', icon:'💪', type:'strength', met:3.5},
  {id:'close-grip-bench', name:'Close-Grip Bench Press', muscle:'arms', icon:'🏋️', type:'strength', met:4.5},
  {id:'cable-curl', name:'Cable Bicep Curl', muscle:'arms', icon:'💪', type:'strength', met:3.5},

  // ---- CORE ----
  {id:'plank', name:'Plank', muscle:'core', icon:'🧘', type:'bodyweight', met:3.5},
  {id:'crunches', name:'Crunches', muscle:'core', icon:'🧘', type:'bodyweight', met:3.5},
  {id:'hanging-leg-raise', name:'Hanging Leg Raise', muscle:'core', icon:'🧘', type:'bodyweight', met:4.5},
  {id:'russian-twist', name:'Russian Twist', muscle:'core', icon:'🧘', type:'bodyweight', met:4.0},
  {id:'cable-woodchopper', name:'Cable Woodchopper', muscle:'core', icon:'🧘', type:'strength', met:4.0},
  {id:'ab-wheel', name:'Ab Wheel Rollout', muscle:'core', icon:'🧘', type:'bodyweight', met:4.5},
  {id:'mountain-climbers', name:'Mountain Climbers', muscle:'core', icon:'🧘', type:'bodyweight', met:6.0},
  {id:'side-plank', name:'Side Plank', muscle:'core', icon:'🧘', type:'bodyweight', met:3.5},

  // ---- CARDIO ----
  {id:'incline-walk', name:'Incline Treadmill Walk', muscle:'cardio', icon:'🚶', type:'cardio', met:0, special:'incline_walk'},
  {id:'treadmill-run', name:'Treadmill Run', muscle:'cardio', icon:'🏃', type:'cardio', met:9.8},
  {id:'stationary-bike', name:'Stationary Bike', muscle:'cardio', icon:'🚴', type:'cardio', met:7.0},
  {id:'rowing-machine', name:'Rowing Machine', muscle:'cardio', icon:'🚣', type:'cardio', met:7.0},
  {id:'elliptical', name:'Elliptical Trainer', muscle:'cardio', icon:'🏃', type:'cardio', met:5.0},
  {id:'stairmaster', name:'StairMaster', muscle:'cardio', icon:'🪜', type:'cardio', met:8.8},
  {id:'jump-rope', name:'Jump Rope', muscle:'cardio', icon:'🪢', type:'cardio', met:11.0},
  {id:'swimming', name:'Swimming (freestyle)', muscle:'cardio', icon:'🏊', type:'cardio', met:8.0},
  {id:'cycling-outdoor', name:'Outdoor Cycling', muscle:'cardio', icon:'🚴', type:'cardio', met:8.0},
  {id:'flat-walk', name:'Flat Walk', muscle:'cardio', icon:'🚶', type:'cardio', met:3.5},

  // ---- OLYMPIC / FUNCTIONAL ----
  {id:'clean-and-jerk', name:'Clean and Jerk', muscle:'fullbody', icon:'🏋️', type:'strength', met:7.0},
  {id:'snatch', name:'Snatch', muscle:'fullbody', icon:'🏋️', type:'strength', met:7.0},
  {id:'kettlebell-swing', name:'Kettlebell Swing', muscle:'fullbody', icon:'🏋️', type:'strength', met:6.5},
  {id:'farmers-walk', name:"Farmer's Walk", muscle:'fullbody', icon:'🏋️', type:'strength', met:5.5},
  {id:'burpees', name:'Burpees', muscle:'fullbody', icon:'💪', type:'bodyweight', met:8.0},
  {id:'thruster', name:'Thruster', muscle:'fullbody', icon:'🏋️', type:'strength', met:7.0},
  {id:'battle-ropes', name:'Battle Ropes', muscle:'fullbody', icon:'🏋️', type:'cardio', met:7.5},
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
