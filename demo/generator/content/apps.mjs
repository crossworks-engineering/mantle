// APPS: three mini apps, one per folder level. Their source lives in
// demo/apps/<dir>/ and goes through the real pipeline (create, draft, build,
// publish) in the seeder, so a broken app fails the seed with the compiler's
// own error. Every app is a shell: its figures are constants that agree with
// the tables, so it can never contradict the brain behind it.
export function generate() {
  const apps = [
    {
      id: 'app-control-room', tier: 'client', dir: 'control-room', entry: 'App.tsx', offset: -15,
      name: 'PS3 Control Room', icon: '🎛️', tags: ['pumphouse'],
      description: 'Station overview for Pump Station 3: flow, the pump set and the overnight events.',
    },
    {
      id: 'app-loop-tracker', tier: 'team', dir: 'loop-tracker', entry: 'App.tsx', offset: -11,
      name: 'Loop check tracker', icon: '✅', tags: ['pumphouse', 'loop-check'],
      description: 'The twelve PS3 signals, what day 1 proved, and what is left for day 2.',
    },
    {
      id: 'app-autonomy', tier: 'private', dir: 'autonomy-calc', entry: 'App.tsx', offset: -14,
      name: 'Battery autonomy calculator', icon: '🔋', tags: ['island'],
      description: 'Move the sliders: nameplate, depth of discharge, load and solar. Hours of ride-through, against the four-hour target.',
    },
  ];
  return { apps };
}
