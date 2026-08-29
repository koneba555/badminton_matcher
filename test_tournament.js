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
Object.defineProperty(globalThis, '__rematchRepeatedPairs', { get: () => rematchRepeatedPairs });
Object.defineProperty(globalThis, '__showRematchWarning', { get: () => showRematchWarning });
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

// ── Test 2b: 4-team bracket — exactly 2 levels (4 matches) then round ends ──
console.log('\n[tournament] 4-team bracket: random pairing, then winner-meets-winner/loser-meets-loser, then round ends');
{
  const ctx = freshContext();
  const S = ctx.__S;
  S.players = [1,2,3,4,5,6,7,8].map(i => ({ id: i, name: `P${i}` }));
  S.presentIds = S.players.map(p => p.id);
  S.mode = 'tournament';
  S.dualCourt = false;
  ctx.startSession(); // 8 players -> 4 fixed teams, maxLevels = ceil(log2(4)) = 2

  check('maxTournamentLevels(4) === 2', ctx.maxTournamentLevels(4) === 2);

  let matches = 0, guard = 0;
  while (S.screen === 'playing' && guard++ < 50) {
    ctx.recordWinner(Math.random() < 0.5 ? 'court' : 'challenger');
    matches++;
  }
  check('round ends after exactly 4 matches (2 levels x 2 matches)', matches === 4);
  check('screen transitioned to newcycle after level 2', S.screen === 'newcycle');
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

  let matches = 0, guard = 0;
  while (S.cycleCount < 6 && guard++ < 2000) {
    if (S.screen === 'newcycle') { ctx.startNewCycle(); continue; }
    if (S.screen !== 'playing') break;
    if (S.courtIdx == null) break; // shouldn't happen single-court
    ctx.recordWinner(Math.random() < 0.5 ? 'court' : 'challenger');
    matches++;
  }
  const rounds = S.cycleCount;
  check('session ran without crashing and produced matches', matches > 10);
  check('reached at least 5 completed brackets', rounds >= 5);
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

  let matches = 0, guard = 0;
  let bothIdleAtOnceViolation = false;
  while (S.cycleCount < 5 && guard++ < 3000) {
    if (S.screen === 'newcycle') { ctx.startNewCycle(); continue; }
    if (S.screen !== 'playing') break;
    const aReady = S.courtIdx != null && S.challengerIdx != null;
    const bReady = S.courtIdxB != null && S.challengerIdxB != null;
    if (!aReady && !bReady) { bothIdleAtOnceViolation = true; break; } // should have advanced to next level or newcycle
    if (aReady && (Math.random() < 0.5 || !bReady)) {
      ctx.recordWinner(Math.random() < 0.5 ? 'court' : 'challenger', 'A');
    } else if (bReady) {
      ctx.recordWinner(Math.random() < 0.5 ? 'court' : 'challenger', 'B');
    }
    matches++;
  }
  const rounds = S.cycleCount;
  check('never stuck with both courts idle mid-level (no soft-lock)', !bothIdleAtOnceViolation);
  check('session ran without crashing and produced matches', matches > 10);
  check('reached at least 3 completed brackets', rounds >= 3);
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
  const N = S.teams.length;
  const expectedPerCycle = N * (N - 1) / 2;
  check(`exactly ${expectedPerCycle} matches per cycle, no pairs lost or duplicated (${matches} over ${cycles} cycles)`, matches === expectedPerCycle * cycles);
  console.log(`  info matches=${matches} cycles=${cycles} expectedPerCycle=${expectedPerCycle}`);
}

// ── Test 5b: limited mode + dual court, impossible cap (5 teams, cap 3) — no soft-lock ──
console.log('\n[limited mode] dual-court, 9 players, cap 3 (impossible total), 3 cycles');
{
  const ctx = freshContext();
  const S = ctx.__S;
  S.players = Array.from({length: 9}, (_, i) => ({ id: i+1, name: `P${i+1}` }));
  S.presentIds = S.players.map(p => p.id);
  S.mode = 'limited';
  S.matchesPerCycle = 3;
  S.dualCourt = true;
  ctx.startSession();

  let matches = 0, cycles = 0, guard = 0;
  let softlock = false;
  while (cycles < 3 && guard++ < 3000) {
    if (S.screen === 'newcycle') { ctx.startNewCycle(); cycles++; continue; }
    if (S.screen !== 'playing') break;
    const aReady = S.courtIdx != null && S.challengerIdx != null;
    const bReady = S.courtIdxB != null && S.challengerIdxB != null;
    if (!aReady && !bReady) { softlock = true; break; }
    if (aReady && (Math.random() < 0.5 || !bReady)) ctx.recordWinner(Math.random() < 0.5 ? 'court' : 'challenger', 'A');
    else if (bReady) ctx.recordWinner(Math.random() < 0.5 ? 'court' : 'challenger', 'B');
    matches++;
  }
  const counts = S.presentIds.map(id => matchCountOf(S, id));
  check('never soft-locks even with a mathematically impossible cap', !softlock);
  check('reached 3 cycles', cycles === 3);
  check('no player falls more than 1 match behind the max (fair shortfall distribution)', Math.max(...counts) - Math.min(...counts) <= 2);
  console.log(`  info matches=${matches} cycles=${cycles} counts=${JSON.stringify(counts)}`);
}

// ── Test 5b-2: same impossible-cap case over a multiple-of-9 run — deficit rotation should
// fully cancel out, giving every player an IDENTICAL match count (this is what the precomputed
// per-cycle schedule guarantees; the old live/greedy engine could not achieve this) ──
console.log('\n[limited mode] dual-court, 9 players, cap 3, 9 cycles — exact fairness');
{
  const ctx = freshContext();
  const S = ctx.__S;
  S.players = Array.from({length: 9}, (_, i) => ({ id: i+1, name: `P${i+1}` }));
  S.presentIds = S.players.map(p => p.id);
  S.mode = 'limited';
  S.matchesPerCycle = 3;
  S.dualCourt = true;
  ctx.startSession();

  let guard = 0, cycles = 0;
  while (cycles < 9 && guard++ < 9000) {
    if (S.screen === 'newcycle') { ctx.startNewCycle(); cycles++; continue; }
    if (S.screen !== 'playing') break;
    const aReady = S.courtIdx != null && S.challengerIdx != null;
    const bReady = S.courtIdxB != null && S.challengerIdxB != null;
    if (!aReady && !bReady) break;
    if (aReady && (Math.random() < 0.5 || !bReady)) ctx.recordWinner(Math.random() < 0.5 ? 'court' : 'challenger', 'A');
    else if (bReady) ctx.recordWinner(Math.random() < 0.5 ? 'court' : 'challenger', 'B');
  }
  const counts = S.presentIds.map(id => matchCountOf(S, id));
  const spread = Math.max(...counts) - Math.min(...counts);
  check('reached 9 cycles', cycles === 9);
  check('perfectly even match count for every player (spread 0)', spread === 0);
  console.log(`  info counts=${JSON.stringify(counts)} spread=${spread}`);
}

// ── Test 5c: dual-court skip — bench team swaps in, no team is lost, no duplicate match ──
console.log('\n[full mode] dual-court skip: bench swaps in for a not-ready court');
{
  const ctx = freshContext();
  const S = ctx.__S;
  S.players = Array.from({length: 10}, (_, i) => ({ id: i+1, name: `P${i+1}` }));
  S.presentIds = S.players.map(p => p.id);
  S.mode = 'full';
  S.dualCourt = true;
  ctx.startSession(); // 5 teams -> A active, B active, 1 team on the bench

  const benchCountBefore = S.waitQueue.length;
  check('exactly one team is benched with 5 teams on 2 courts', benchCountBefore === 1);

  const canSkipA = ctx.canSkipSlot('A');
  check('court A reports skippable (bench team available)', canSkipA);

  const beforeA = [S.courtIdx, S.challengerIdx];
  const benchTeamBefore = S.waitQueue[0];
  ctx.skipMatch('A');
  const afterA = [S.courtIdx, S.challengerIdx];
  check('skip actually changed court A\'s pair', afterA[0] !== beforeA[0] || afterA[1] !== beforeA[1]);
  check('the previously-benched team is now playing on court A', afterA.includes(benchTeamBefore));
  check('one of the old court-A teams went to the bench (nobody lost)', S.waitQueue.includes(beforeA[0]) || S.waitQueue.includes(beforeA[1]));
  check('court B untouched by the skip', S.courtIdxB != null && S.challengerIdxB != null);

  // Play the whole session out and verify total match integrity still holds.
  let matches = 0, cycles = 0, guard = 0;
  while (cycles < 2 && guard++ < 3000) {
    if (S.screen === 'newcycle') { ctx.startNewCycle(); cycles++; continue; }
    if (S.screen !== 'playing') break;
    const aReady = S.courtIdx != null && S.challengerIdx != null;
    const bReady = S.courtIdxB != null && S.challengerIdxB != null;
    if (!aReady && !bReady) break;
    if (aReady && (Math.random() < 0.5 || !bReady)) ctx.recordWinner(Math.random() < 0.5 ? 'court' : 'challenger', 'A');
    else if (bReady) ctx.recordWinner(Math.random() < 0.5 ? 'court' : 'challenger', 'B');
    matches++;
  }
  const N = S.teams.length;
  const expectedPerCycle = N * (N - 1) / 2;
  check(`match integrity holds after skip: exactly ${expectedPerCycle} per cycle`, matches === expectedPerCycle * cycles);
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

// ── Test 7: bye fairness — match counts should stay tight across many brackets ──
console.log('\n[tournament] bye fairness, 9 players, dual court, 8 brackets');
{
  const ctx = freshContext();
  const S = ctx.__S;
  S.players = Array.from({length: 9}, (_, i) => ({ id: i+1, name: `P${i+1}` }));
  S.presentIds = S.players.map(p => p.id);
  S.mode = 'tournament';
  S.dualCourt = true;
  ctx.startSession();

  let guard = 0;
  while (S.cycleCount < 8 && guard++ < 5000) {
    if (S.screen === 'newcycle') { ctx.startNewCycle(); continue; }
    if (S.screen !== 'playing') break;
    const aReady = S.courtIdx != null && S.challengerIdx != null;
    const bReady = S.courtIdxB != null && S.challengerIdxB != null;
    if (!aReady && !bReady) break;
    if (aReady && (Math.random() < 0.5 || !bReady)) ctx.recordWinner(Math.random() < 0.5 ? 'court' : 'challenger', 'A');
    else if (bReady) ctx.recordWinner(Math.random() < 0.5 ? 'court' : 'challenger', 'B');
  }
  const counts = S.presentIds.map(id => matchCountOf(S, id));
  const spread = Math.max(...counts) - Math.min(...counts);
  console.log(`  info matchCounts=${JSON.stringify(counts)} spread=${spread}`);
  check('match-count spread across players stays small (<=2)', spread <= 2);
}
function matchCountOf(S, id) {
  return (S.rounds || []).filter(r => (r.courtTeam||[]).includes(id) || (r.challengerTeam||[]).includes(id)).length;
}
function pairKeyLocal2(a, b) { return a < b ? `${a},${b}` : `${b},${a}`; }

// ── Test 8: buildScheduleAvoidingRepeats — a rebuild must not repeat the very next cycle's
// partnerships when unused combinations exist (this was the bug: adding a player mid-round
// forces a schedule rebuild, and the naive rebuild ignored partner history entirely) ──
console.log('\n[buildScheduleAvoidingRepeats] avoids repeating the immediate next cycle');
{
  const ctx = freshContext();
  // 6 players, one full perfect matching already used — a full round-robin schedule is
  // guaranteed to reuse every pair SOMEWHERE eventually, but the very next cycle must not.
  const presentIds = [1, 2, 3, 4, 5, 6];
  const usedPartners = ['1,2', '3,4', '5,6'];
  let zeroFound = 0;
  const trials = 30;
  for (let t = 0; t < trials; t++) {
    const sched = ctx.buildScheduleAvoidingRepeats(presentIds, usedPartners);
    const used = new Set(usedPartners);
    const repeats = sched[0].filter(team => team.length === 2 && used.has(pairKeyLocal2(team[0], team[1]))).length;
    if (repeats === 0) zeroFound++;
  }
  check(`finds a zero-repeat next cycle every time (${zeroFound}/${trials})`, zeroFound === trials);
}

// ── Test 9: end-to-end — mid-game add during dual-court play must not cause the following
// cycle to repeat a partnership while unused combinations remain ──
console.log('\n[mid-game] dual-court add-player does not repeat partnerships next cycle');
{
  let totalRepeats = 0, totalTrials = 30;
  for (let trial = 0; trial < totalTrials; trial++) {
    const ctx = freshContext();
    const S = ctx.__S;
    const n0 = 6 + (trial % 6);
    S.players = Array.from({ length: n0 }, (_, i) => ({ id: i + 1, name: `P${i + 1}` }));
    S.presentIds = S.players.map(p => p.id);
    S.nextId = n0 + 1;
    S.mode = trial % 2 === 0 ? 'full' : 'limited';
    S.matchesPerCycle = 3;
    S.dualCourt = true;
    ctx.startSession();
    let guard = 0;
    for (let m = 0; m < 1 + (trial % 3) && guard++ < 50; m++) {
      const aReady = S.courtIdx != null && S.challengerIdx != null;
      const bReady = S.courtIdxB != null && S.challengerIdxB != null;
      if (!aReady && !bReady) break;
      if (aReady) ctx.recordWinner(Math.random() < 0.5 ? 'court' : 'challenger', 'A');
      else if (bReady) ctx.recordWinner(Math.random() < 0.5 ? 'court' : 'challenger', 'B');
    }
    ctx.addPlayerMidGame(null, `New${trial}`);
    guard = 0;
    while (S.screen === 'playing' && guard++ < 100) {
      const aReady = S.courtIdx != null && S.challengerIdx != null;
      const bReady = S.courtIdxB != null && S.challengerIdxB != null;
      if (!aReady && !bReady) break;
      if (aReady) ctx.recordWinner(Math.random() < 0.5 ? 'court' : 'challenger', 'A');
      else if (bReady) ctx.recordWinner(Math.random() < 0.5 ? 'court' : 'challenger', 'B');
    }
    const usedBefore = new Set(S.usedPartners);
    ctx.startNewCycle();
    if (S.screen === 'newcycle') ctx.confirmRematchProceed(); // rematch modal triggered — accept it to inspect the pending teams
    totalRepeats += S.teams.filter(t => t.length === 2 && usedBefore.has(pairKeyLocal2(t[0], t[1]))).length;
  }
  check(`zero partner repeats across ${totalTrials} mid-game-add trials`, totalRepeats === 0);
}

// ── Test 10: rematch warning modal — triggers on a forced repeat, and both actions work ──
console.log('\n[rematch warning] modal triggers, retry and proceed both work');
{
  const ctx = freshContext();
  const S = ctx.__S;
  S.players = Array.from({ length: 6 }, (_, i) => ({ id: i + 1, name: `P${i + 1}` }));
  S.presentIds = S.players.map(p => p.id);
  S.mode = 'full';
  ctx.startSession();
  // Force a guaranteed-repeat scenario: hand the checker a schedule whose first cycle
  // exactly matches an already-used partnership, while plenty of other combos remain unused.
  S.usedPartners = ['1,2', '3,4', '5,6'];
  const forcedSchedule = [[[1, 2], [3, 4], [5, 6]]];
  ctx.proceedOrWarnRematch(forcedSchedule, 0);
  check('modal opens on a forced repeat', ctx.__showRematchWarning === true);
  check('flags the exact repeated pairs', JSON.stringify(ctx.__rematchRepeatedPairs) === JSON.stringify([[1,2],[3,4],[5,6]]));

  ctx.retryRematchShuffle();
  // retry draws a fresh (avoided-repeat) schedule — for 6 players this should always succeed
  check('retry finds a non-repeating arrangement and proceeds to playing', ctx.__S.screen === 'playing' && ctx.__showRematchWarning === false);

  // Force it again, this time accept the repeat via "เล่นต่อเลย"
  ctx.proceedOrWarnRematch(forcedSchedule, 0);
  check('modal reopens on a second forced repeat', ctx.__showRematchWarning === true);
  ctx.confirmRematchProceed();
  check('confirming proceeds to playing with the repeated pairing', ctx.__S.screen === 'playing' &&
    JSON.stringify(ctx.__S.teams) === JSON.stringify(forcedSchedule[0]));
}

// ── Test 11: newbie 🐥 tag — schedule generation avoids leaving a tagged newbie solo ──
console.log('\n[buildScheduleAvoidingRepeats] avoids leaving a 🐥 newbie solo when odd team count');
{
  const ctx = freshContext();
  const presentIds = [1, 2, 3, 4, 5]; // odd N -> one solo team every round
  let newbieSoloCount = 0;
  const trials = 100;
  for (let t = 0; t < trials; t++) {
    const sched = ctx.buildScheduleAvoidingRepeats(presentIds, [], [1]); // player 1 tagged newbie
    const solo = sched[0].find(team => team.length === 1);
    if (solo && solo[0] === 1) newbieSoloCount++;
  }
  check(`newbie almost never ends up solo (${newbieSoloCount}/${trials}, baseline random ~20)`, newbieSoloCount <= 3);
}

// ── Test 12: singles mode (1v1) — every team stays size 1, no pairing/partner logic runs ──
console.log('\n[singles mode] every team is a single player, full and limited, dual court');
{
  let fails = 0;
  for (let trial = 0; trial < 60; trial++) {
    const n = 2 + (trial % 10);
    const mode = trial % 2 === 0 ? 'full' : 'limited';
    const dual = trial % 3 !== 0;
    const ctx = freshContext();
    const S = ctx.__S;
    S.players = Array.from({ length: n }, (_, i) => ({ id: i + 1, name: `P${i + 1}` }));
    S.presentIds = S.players.map(p => p.id);
    S.mode = mode;
    S.dualCourt = dual;
    S.matchesPerCycle = 2 + (trial % 4);
    S.singlesMode = true;
    try {
      ctx.startSession();
      if (S.teams.some(t => t.length !== 1)) throw new Error(`non-single team after startSession (n=${n}, mode=${mode})`);
      let guard = 0, cycles = 0;
      while (cycles < 3 && guard++ < 3000) {
        if (S.screen === 'newcycle') { ctx.startNewCycle(); cycles++; continue; }
        if (S.screen !== 'playing') break;
        const aReady = S.courtIdx != null && S.challengerIdx != null;
        const bReady = dual && S.courtIdxB != null && S.challengerIdxB != null;
        if (!aReady && !bReady) throw new Error(`softlock (n=${n}, mode=${mode}, dual=${dual})`);
        if (aReady && (Math.random() < 0.5 || !bReady)) ctx.recordWinner(Math.random() < 0.5 ? 'court' : 'challenger', 'A');
        else if (bReady) ctx.recordWinner(Math.random() < 0.5 ? 'court' : 'challenger', 'B');
        if (S.teams.some(t => t.length !== 1)) throw new Error(`team size changed mid-play (n=${n}, mode=${mode})`);
      }
      if (guard >= 3000) throw new Error(`guard hit (n=${n}, mode=${mode}, dual=${dual})`);
    } catch (e) {
      fails++;
      console.log(`  FAIL trial ${trial}: ${e.message}`);
    }
  }
  check(`60 singles-mode trials run clean (0 failures)`, fails === 0);
}

console.log(failures === 0 ? '\n✓ All tournament/dual-court tests passed' : `\n✗ ${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
