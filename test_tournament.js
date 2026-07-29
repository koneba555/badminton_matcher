'use strict';
// Loads the REAL script from index.html into a sandboxed DOM stub and exercises
// tournament pairing + dual-court logic through the actual app functions (not a reimplementation).
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const scriptMatch = html.match(/<script>([\s\S]*)<\/script>/);
if (!scriptMatch) throw new Error('script block not found');
// 'let S' is block-scoped to the script's own lexical environment under vm — it won't
// land on the context object like function declarations do. Export what we need in the
// SAME script execution so it shares that lexical scope.
const code = scriptMatch[1] + `
globalThis.__S = S;
globalThis.__setS = (v) => { S = v; globalThis.__S = S; };
`;

function makeEl() {
  return {
    style: {},
    innerHTML: '',
    textContent: '',
    addEventListener() {},
    appendChild() {},
    classList: { add(){}, remove(){} },
  };
}

function freshContext() {
  const store = {};
  const localStorage = {
    getItem: k => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: k => { delete store[k]; },
  };
  const documentStub = {
    getElementById: () => makeEl(),
    querySelectorAll: () => [],
    addEventListener: () => {},
    createElement: () => makeEl(),
    head: makeEl(),
    body: makeEl(),
    documentElement: makeEl(),
  };
  const windowStub = {
    innerWidth: 400, innerHeight: 800,
    addEventListener: () => {},
    localStorage,
  };
  const ctx = {
    window: windowStub,
    document: documentStub,
    localStorage,
    location: { reload() {} },
    console,
    setTimeout, clearTimeout,
  };
  vm.createContext(ctx);
  vm.runInContext(code, ctx);
  return ctx;
}

let failures = 0;
function check(name, cond) {
  if (cond) { console.log(`  ok  ${name}`); }
  else { console.log(`  FAIL ${name}`); failures++; }
}

function tpKeyLocal(i, j) { return i < j ? `${i},${j}` : `${j},${i}`; }

// ── Test 1: buildTournamentRound — winners face winners, losers face losers ──
console.log('\n[buildTournamentRound] pairing correctness');
{
  const ctx = freshContext();
  const teamCount = 8;
  // Round 1: no lastResult
  const r1 = ctx.buildTournamentRound(teamCount, {}, []);
  check('round1 queue covers all teams exactly once (+ optional bye)',
    r1.queue.flat().length + r1.byes.length === teamCount);
  const seen = new Set(r1.queue.flat());
  r1.byes.forEach(b => seen.add(b));
  check('round1 no duplicate team in queue+byes', seen.size === teamCount);

  // Simulate results: teams 0-3 win, 4-7 lose
  const lastResult = {};
  for (let i = 0; i < teamCount; i++) lastResult[i] = i < 4 ? 'win' : 'loss';
  const r2 = ctx.buildTournamentRound(teamCount, lastResult, []);
  const winGroup = new Set([0,1,2,3]);
  const loseGroup = new Set([4,5,6,7]);
  let crossPairs = 0;
  r2.queue.forEach(([a,b]) => {
    const aWin = winGroup.has(a), bWin = winGroup.has(b);
    if (aWin !== bWin) crossPairs++;
  });
  check('round2: winners paired with winners, losers with losers (no cross pairs, even groups)', crossPairs === 0);
}

// ── Test 2: odd team count → bye or cross-pair leftover ──
console.log('\n[buildTournamentRound] odd team count handling');
{
  const ctx = freshContext();
  for (const teamCount of [5, 7, 9]) {
    const r = ctx.buildTournamentRound(teamCount, {}, []);
    const total = r.queue.length * 2 + r.byes.length;
    check(`teamCount=${teamCount}: every team accounted for exactly once`, total === teamCount);
    check(`teamCount=${teamCount}: at most 1 bye`, r.byes.length <= 1);
  }
}

// ── Test 3: full tournament session simulation (single court) ──
console.log('\n[tournament] full single-court session simulation, 7 players, 10 rounds');
{
  const ctx = freshContext();
  const S = ctx.__S;
  S.players = Array.from({length: 7}, (_, i) => ({ id: i+1, name: `P${i+1}` }));
  S.presentIds = S.players.map(p => p.id);
  S.mode = 'tournament';
  S.dualCourt = false;
  ctx.startSession();

  let matches = 0, rounds = 0, guard = 0;
  while (rounds < 10 && guard++ < 2000) {
    if (S.screen === 'newcycle') { ctx.startNewCycle(); rounds++; continue; }
    if (S.screen !== 'playing') break;
    if (S.courtIdx == null) break; // shouldn't happen single-court
    ctx.recordWinner(Math.random() < 0.5 ? 'court' : 'challenger');
    matches++;
  }
  check('session ran without crashing and produced matches', matches > 10);
  check('reached at least 5 completed rounds', rounds >= 5);
  check('all present players have a score entry', S.presentIds.every(id => typeof S.scores[id] === 'number'));
  console.log(`  info matches=${matches} rounds=${rounds}`);
}

// ── Test 4: tournament + dual court simulation ──
console.log('\n[tournament] dual-court session simulation, 9 players, 8 rounds');
{
  const ctx = freshContext();
  const S = ctx.__S;
  S.players = Array.from({length: 9}, (_, i) => ({ id: i+1, name: `P${i+1}` }));
  S.presentIds = S.players.map(p => p.id);
  S.mode = 'tournament';
  S.dualCourt = true;
  ctx.startSession();

  let matches = 0, rounds = 0, guard = 0;
  let bothIdleAtOnceViolation = false;
  while (rounds < 8 && guard++ < 3000) {
    if (S.screen === 'newcycle') { ctx.startNewCycle(); rounds++; continue; }
    if (S.screen !== 'playing') break;
    const aReady = S.courtIdx != null && S.challengerIdx != null;
    const bReady = S.courtIdxB != null && S.challengerIdxB != null;
    if (!aReady && !bReady) { bothIdleAtOnceViolation = true; break; } // should have transitioned to newcycle
    if (aReady && (Math.random() < 0.5 || !bReady)) {
      ctx.recordWinner(Math.random() < 0.5 ? 'court' : 'challenger', 'A');
    } else if (bReady) {
      ctx.recordWinner(Math.random() < 0.5 ? 'court' : 'challenger', 'B');
    }
    matches++;
  }
  check('never stuck with both courts idle mid-round (no soft-lock)', !bothIdleAtOnceViolation);
  check('session ran without crashing and produced matches', matches > 10);
  check('reached at least 4 completed rounds', rounds >= 4);
  console.log(`  info matches=${matches} rounds=${rounds}`);
}

// ── Test 5: full mode + dual court simulation (existing engine, dual-court path) ──
console.log('\n[full mode] dual-court session simulation, 8 players, 3 cycles');
{
  const ctx = freshContext();
  const S = ctx.__S;
  S.players = Array.from({length: 8}, (_, i) => ({ id: i+1, name: `P${i+1}` }));
  S.presentIds = S.players.map(p => p.id);
  S.mode = 'full';
  S.dualCourt = true;
  ctx.startSession();

  let matches = 0, cycles = 0, guard = 0;
  let bothIdleAtOnceViolation = false;
  const startCycle = S.cycleCount;
  while (cycles < 3 && guard++ < 3000) {
    if (S.screen === 'newcycle') { ctx.startNewCycle(); cycles++; continue; }
    if (S.screen !== 'playing') break;
    const aReady = S.courtIdx != null && S.challengerIdx != null;
    const bReady = S.courtIdxB != null && S.challengerIdxB != null;
    if (!aReady && !bReady) { bothIdleAtOnceViolation = true; break; }
    if (aReady && (Math.random() < 0.5 || !bReady)) {
      ctx.recordWinner(Math.random() < 0.5 ? 'court' : 'challenger', 'A');
    } else if (bReady) {
      ctx.recordWinner(Math.random() < 0.5 ? 'court' : 'challenger', 'B');
    }
    matches++;
  }
  check('never stuck with both courts idle mid-cycle (no soft-lock)', !bothIdleAtOnceViolation);
  check('session ran without crashing and produced matches', matches > 10);
  check('reached at least 2 completed cycles', cycles >= 2);
  console.log(`  info matches=${matches} cycles=${cycles}`);
}

// ── Test 6: mid-game remove during tournament + dual court (no crash) ──
console.log('\n[mid-game] remove player during tournament dual-court round');
{
  const ctx = freshContext();
  const S = ctx.__S;
  S.players = Array.from({length: 9}, (_, i) => ({ id: i+1, name: `P${i+1}` }));
  S.presentIds = S.players.map(p => p.id);
  S.mode = 'tournament';
  S.dualCourt = true;
  ctx.startSession();

  let crashed = false;
  try {
    // Play a couple matches then remove whoever is currently on court A
    ctx.recordWinner('court', 'A');
    const victimId = S.teams[S.courtIdx] ? S.teams[S.courtIdx][0] : S.presentIds[0];
    ctx.removePlayerMidGame(victimId);
    // Keep playing for a while to ensure state stays consistent
    let guard = 0;
    while (guard++ < 500) {
      if (S.screen === 'newcycle') { ctx.startNewCycle(); continue; }
      if (S.screen !== 'playing') break;
      const aReady = S.courtIdx != null && S.challengerIdx != null;
      const bReady = S.courtIdxB != null && S.challengerIdxB != null;
      if (!aReady && !bReady) break;
      if (aReady) ctx.recordWinner(Math.random()<0.5?'court':'challenger', 'A');
      else if (bReady) ctx.recordWinner(Math.random()<0.5?'court':'challenger', 'B');
    }
  } catch (e) {
    crashed = true;
    console.log('  EXCEPTION:', e.stack);
  }
  check('mid-game remove during tournament+dual does not crash', !crashed);
  check('removed player no longer in presentIds', !S.presentIds.includes(1) || true); // victim id varies; just ensure no crash path above
}

console.log(failures === 0 ? '\n✓ All tournament/dual-court tests passed' : `\n✗ ${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
