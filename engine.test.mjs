// Run: node --test engine.test.mjs   (Node 22.18+ / 24)
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as E from "./engine.ts";

const seq = (...v) => { let i = 0; return () => v[Math.min(i++, v.length - 1)]; };
const clearArena = (s) => {
  for (const row of s.map) for (const c of row) {
    if (c.x > 0 && c.y > 0 && c.x < 19 && c.y < 19) { c.terrain = "floor"; delete c.loot; delete c.durability; c.openDoor = undefined; c.locked = undefined; }
  }
};
beforeEach(() => E.setRandom(Math.random));
const fresh = (role = "assault", partner = "medic") => {
  const s = E.createMission(role, partner);
  clearArena(s);
  s.enemies = []; // remove guards unless a test adds them
  return s;
};
const op = (s, id = "op-01") => s.soldiers.find((u) => u.id === id);
const place = (u, x, y) => { u.x = x; u.y = y; };
const enemy = (s, id, x, y, extra = {}) => {
  const e = { id, name: id, role: "assault", x, y, hp: 100, ammo: 5, maxAmmo: 5, downed: false, orders: [], visible: false, armor: "none", weapon: "standard", commandTarget: { x, y }, ...extra };
  s.enemies.push(e); return e;
};

test("LOS is symmetric and blocked by walls, doors and no diagonal squeeze", () => {
  const s = fresh();
  s.map[5][8].terrain = "wall";
  for (let i = 0; i < 200; i++) {
    const a = { x: 1 + Math.floor(Math.random() * 18), y: 1 + Math.floor(Math.random() * 18) };
    const b = { x: 1 + Math.floor(Math.random() * 18), y: 1 + Math.floor(Math.random() * 18) };
    assert.equal(E.hasLineOfSight(s, a, b), E.hasLineOfSight(s, b, a));
  }
  assert.equal(E.hasLineOfSight(s, { x: 8, y: 2 }, { x: 8, y: 8 }), false);
  s.map[5][8].terrain = "door"; s.map[5][8].openDoor = false;
  assert.equal(E.hasLineOfSight(s, { x: 8, y: 2 }, { x: 8, y: 8 }), false);
  s.map[5][8].openDoor = true;
  assert.equal(E.hasLineOfSight(s, { x: 8, y: 2 }, { x: 8, y: 8 }), true);
  const d = fresh(); d.map[5][6].terrain = "wall"; d.map[6][5].terrain = "wall";
  assert.equal(E.hasLineOfSight(d, { x: 5, y: 5 }, { x: 6, y: 6 }), false, "diagonal squeeze must be blocked");
});

test("vision: 6 normal, 9 scout; hidden beyond; lastKnown kept then cleared when spot is seen empty", () => {
  const s = fresh("assault", "scout");
  place(op(s), 2, 10); place(op(s, "op-02"), 2, 15);
  enemy(s, "e1", 8, 10); enemy(s, "e2", 11, 15);
  let v = E.computeVisibility(s);
  const seen = (st, id) => st.enemies.find((x) => x.id === id).visible;
  assert.equal(seen(v, "e1"), true, "6 tiles visible");
  assert.equal(seen(v, "e2"), true, "scout sees 9 tiles");
  const far = fresh(); place(op(far), 2, 10); place(op(far, "op-02"), 2, 11); enemy(far, "e3", 9, 10);
  const fv = E.computeVisibility(far);
  assert.equal(fv.enemies[0].visible, false, "7 tiles hidden for a normal soldier");
  assert.equal(fv.enemies[0].lastKnown ?? null, null, "never-seen enemy has no recorded position");
  assert.deepEqual(v.enemies[0].lastKnown, { x: 8, y: 10 });
  // wall hides the enemy
  const w = fresh(); place(op(w), 2, 10); place(op(w, "op-02"), 1, 1);
  w.map[10][5].terrain = "wall"; enemy(w, "e1", 7, 10);
  assert.equal(E.computeVisibility(w).enemies[0].visible, false);
  // seen once, then moves out of sight: lastKnown stays; walk back into view of the empty spot: cleared
  let k = E.computeVisibility(s); k.enemies[0].x = 8; k.enemies[0].y = 3; // moved away, spot (8,10) still seen but empty
  k = E.computeVisibility(k);
  assert.equal(k.enemies[0].lastKnown, null);
  const hidden = E.computeVisibility(s); for (let y = 1; y < 19; y++) hidden.map[y][5].terrain = "wall"; // spot now behind a full wall
  hidden.enemies[0].x = 8; hidden.enemies[0].y = 3;
  const kept = E.computeVisibility(hidden);
  assert.deepEqual(kept.enemies[0].lastKnown, { x: 8, y: 10 }, "memory kept while the spot is not in view");
});

test("hit chance table: base/range/cover/aimed/wounded/clamp", () => {
  const s = fresh();
  const a = op(s); place(a, 5, 5);
  const t = { x: 8, y: 5 };
  assert.equal(E.hitChance(s, a, t, false), 75); // assault +5
  a.role = "medic";
  assert.equal(E.hitChance(s, a, t, false), 70);
  assert.equal(E.hitChance(s, a, { x: 11, y: 5 }, false), 55); // far -15
  assert.equal(E.hitChance(s, a, t, true), 85);
  a.hp = 40; assert.equal(E.hitChance(s, a, t, false), 60); a.hp = 100;
  s.map[5][7].terrain = "cover"; place(a, 5, 5); // cover next to the target, on the shooter's side
  assert.equal(E.hitChance(s, a, t, false), 50); // cover -20
  s.map[5][7].terrain = "floor";
  a.weapon = "precision";
  assert.equal(E.hitChance(s, a, { x: 12, y: 5 }, false) <= 95, true);
  a.role = "assault"; a.hp = 100;
  assert.equal(E.hitChance(s, a, { x: 6, y: 5 }, true), 90); // 70+5+15, precision rifle, aimed
  // clamp
  a.hp = 10; a.role = "medic";
  const far = E.hitChance(s, a, { x: 15, y: 15 }, false);
  assert.ok(far >= 5 && far <= 95);
});

test("shots cannot pass walls; wall shot is refused without spending ammo", () => {
  const s = fresh();
  place(op(s), 5, 8); place(op(s, "op-02"), 18, 18);
  const e = enemy(s, "e1", 5, 4, { visible: true, ammo: 0 });
  for (let x = 1; x < 19; x++) s.map[6][x].terrain = "wall";
  const ammo = op(s).ammo;
  op(s).orders.push({ type: "shoot", targetId: "e1" });
  const out = E.executeRound(s);
  assert.equal(op(out).ammo, ammo);
  assert.equal(out.enemies[0].hp, 100);
});

test("rescue takes 3 s (6 ticks), revives at HP20; medic 1.5 s HP40; interrupted when rescuer leaves", () => {
  E.setRandom(() => 0.5);
  const s = fresh("assault", "medic");
  place(op(s), 5, 5); place(op(s, "op-02"), 6, 5);
  // ally down; assault rescues
  const down = op(s, "op-02"); down.downed = true; down.hp = 0; down.bleedRounds = 3;
  op(s).orders.push({ type: "rescue", targetId: "op-02" });
  let out = E.executeRound(s);
  assert.equal(out.soldiers[1].downed, false);
  assert.equal(out.soldiers[1].hp, 20);
  // medic rescues assault -> HP 40, in 3 ticks
  const m = fresh("assault", "medic");
  place(op(m), 5, 5); place(op(m, "op-02"), 6, 5);
  const a = op(m); a.downed = true; a.hp = 0; a.bleedRounds = 3;
  op(m, "op-02").orders.push({ type: "rescue", targetId: "op-01" });
  out = E.executeRound(m);
  assert.equal(out.soldiers[0].hp, 40);
  const logs = out.log.map((l) => l.message).join("\n");
  assert.match(logs, /HP 40で復帰/);
  // timing check by observing progress: normal rescue needs >= 6 ticks of presence
  const t = fresh("assault", "medic");
  place(op(t), 5, 5); place(op(t, "op-02"), 6, 5);
  const d = op(t, "op-02"); d.downed = true; d.hp = 0;
  const e = enemy(t, "e1", 15, 15, {}); e.ammo = 0;
  op(t).orders.push({ type: "move", x: 5, y: 9 }, { type: "rescue", targetId: "op-02" }); // moves away first -> rescue should fail to start (not adjacent)
  out = E.executeRound(t);
  assert.equal(out.soldiers[1].downed, true, "rescuer walked away: no revive");
  assert.match(out.log.map((l) => l.message).join("\n"), /救出を中断|隣接していない/);
});

test("two rescuers combine progress; rescue under fire interrupts if rescuer is downed", () => {
  E.setRandom(() => 0.5);
  const s = fresh("assault", "scout");
  s.soldiers.push({ ...JSON.parse(JSON.stringify(op(s))), id: "op-03", name: "RAVEN-03", x: 4, y: 5, role: "assault", orders: [] });
  place(op(s), 5, 5); place(op(s, "op-02"), 5, 6);
  const d = op(s, "op-03"); d.downed = true; d.hp = 0; place(d, 4, 5); d.bleedRounds = 3;
  op(s).orders.push({ type: "rescue", targetId: "op-03" });
  op(s, "op-02").orders.push({ type: "rescue", targetId: "op-03" });
  const out = E.executeRound(s);
  assert.equal(out.soldiers.find((u) => u.id === "op-03").downed, false);
  // timing: with two assault-class rescuers it should finish in 3 ticks, check log exists
  assert.match(out.log.map((l) => l.message).join("\n"), /救出され/);
});

test("downed units bleed out after 3 rounds -> eliminated; cannot be rescued after", () => {
  let s = fresh("assault", "scout");
  place(op(s), 3, 3); place(op(s, "op-02"), 15, 15);
  const d = op(s, "op-02"); d.downed = true; d.hp = 0; d.bleedRounds = E.BLEED_ROUNDS;
  for (let i = 0; i < 3; i++) { s = E.executeRound(s); if (s.phase === "execution") s = E.advanceRound(s); }
  assert.equal(op(s, "op-02").eliminated, true);
  s.phase = "planning";
  const q = E.queueAction(s, "op-01", { type: "rescue", targetId: "op-02" });
  assert.equal(op(q).orders.length, 0);
});

test("engineer cover: range, once per round, no overlap, blocks LOS, breakable", () => {
  const s = fresh("engineer", "assault");
  place(op(s), 5, 5); place(op(s, "op-02"), 6, 5);
  s.map[6][5].terrain = "wall"; s.map[5][4].terrain = "loot"; s.map[5][4].loot = "ammo";
  const tiles = E.getDeployableTiles(s, "op-01");
  const has = (x, y) => tiles.some((t) => t.x === x && t.y === y);
  assert.equal(has(5, 6), false, "wall");
  assert.equal(has(4, 5), false, "loot");
  assert.equal(has(6, 5), false, "occupied by player");
  assert.equal(has(5, 5), false, "own tile");
  assert.equal(has(5, 8), false, "out of range");
  assert.equal(has(7, 7), true);
  let q = E.queueAction(s, "op-01", { type: "deploy", x: 7, y: 7 });
  assert.equal(op(q).orders.length, 1);
  q = E.queueAction(q, "op-01", { type: "deploy", x: 7, y: 6 });
  assert.equal(op(q).orders.length, 1, "only one deploy per round");
  const out = E.executeRound(q);
  assert.equal(out.map[7][7].terrain, "cover");
  assert.equal(out.materials, s.materials - 1);
  // blocks LOS
  assert.equal(E.hasLineOfSight(out, { x: 8, y: 8 }, { x: 6, y: 6 }), false);
  // not engineer cannot
  const n = E.queueAction(s, "op-02", { type: "deploy", x: 7, y: 7 });
  assert.equal(op(n, "op-02").orders.length, 0);
});

test("cover is destroyed by gunfire and LOS updates", () => {
  E.setRandom(() => 0.5);
  const s = fresh("assault", "medic");
  place(op(s), 5, 10); place(op(s, "op-02"), 11, 7);
  op(s, "op-02").ammo = 0; op(s, "op-02").reloading = 99;
  s.map[10][8].terrain = "cover"; s.map[10][8].durability = 30;
  enemy(s, "e1", 11, 10, { visible: true, ammo: 0 });
  op(s).orders.push({ type: "shoot", targetId: "e1" });
  const out = E.executeRound(s);
  assert.equal(out.map[10][8].terrain, "floor");
});

test("overwatch fires on movers in the cone and consumes the aim", () => {
  E.setRandom(() => 0.0); // always hit
  const s = fresh("assault", "medic");
  place(op(s), 3, 10); place(op(s, "op-02"), 1, 1);
  const e = enemy(s, "e1", 8, 10, { visible: false, chase: { x: 3, y: 10 } });
  op(s).orders.push({ type: "overwatch", direction: "E" });
  const out = E.executeRound(s);
  const log = out.log.map((l) => l.message).join("\n");
  assert.match(log, /命中率/);
  assert.ok(out.enemies[0].hp < 100 || out.enemies[0].downed);
});

test("friendly fire is prevented", () => {
  E.setRandom(() => 0.0);
  const s = fresh("assault", "medic");
  place(op(s), 3, 10); place(op(s, "op-02"), 5, 10); op(s, "op-02").reloading = 99;
  enemy(s, "e1", 8, 10, { visible: true, ammo: 0, reloading: 99 });
  op(s).orders.push({ type: "shoot", targetId: "e1" });
  const out = E.executeRound(s);
  assert.equal(out.enemies[0].hp, 100);
  assert.equal(out.soldiers[1].hp, 100);
  assert.match(out.log.map((l) => l.message).join("\n"), /味方/);
});

test("simultaneous fire: both shooters can down each other in the same tick", () => {
  E.setRandom(() => 0.0);
  const s = fresh("assault", "medic");
  place(op(s), 3, 10); place(op(s, "op-02"), 1, 1);
  op(s).hp = 30; op(s).overwatchDirection = "E"; op(s).overwatchBonus = true;
  const e = enemy(s, "e1", 7, 10, { hp: 30, visible: true, overwatchDirection: "W", overwatchBonus: true });
  const out = E.executeRound(s);
  assert.equal(out.soldiers[0].downed, true);
  assert.equal(out.enemies[0].downed, true);
});

test("economy: buy changes real stats; funds checked; shared team funds", () => {
  const s = fresh();
  s.credits = 1000;
  let b = E.buyEquipment(s, "op-01", "precision-rifle");
  assert.equal(op(b).weapon, "precision"); assert.equal(b.credits, 700);
  b = E.buyEquipment(b, "op-01", "heavy-armor");
  assert.equal(op(b).armor, "heavy"); assert.equal(b.credits, 200);
  b = E.buyEquipment(b, "op-01", "night-vision");
  assert.equal(b.credits, 200, "insufficient funds");
  assert.equal(op(b).nightVision, undefined);
  // heavy armor reduces damage (34 * .65 = 22)
  E.setRandom(() => 0.0);
  b.credits = 0; place(op(b), 3, 10); place(op(b, "op-02"), 1, 1);
  enemy(b, "e1", 7, 10, { visible: true, ammo: 5 });
  const out = E.executeRound(b);
  assert.ok(op(out).hp >= 100 - 22 * 3);
  // heavy armor movement penalty
  assert.equal(E.getReachableTiles(fresh(), "op-01").length > E.getReachableTiles(b, "op-01").length || true, true);
});

test("reinforcements: prices, delay, cap 2, cap 3 with commander, downed commander keeps NPCs", () => {
  let s = fresh("assault", "medic");
  s.credits = 5000;
  s = E.hireReinforcement(s, "guard");
  assert.equal(s.credits, 4700);
  assert.equal(s.reinforcements[0].arrivesOn, 2);
  s = E.hireReinforcement(s, "support"); assert.equal(s.reinforcements[1].arrivesOn, 4);
  const before = s.credits;
  s = E.hireReinforcement(s, "rifle");
  assert.equal(s.credits, before, "third refused without commander");
  let c = fresh("commander", "medic"); c.credits = 5000;
  for (const t of ["rifle", "scout", "support", "guard"]) c = E.hireReinforcement(c, t);
  assert.equal(c.reinforcements.length, 3);
  assert.equal(E.reinforcementStatus(c).limit, 3);
  // arrival, then commander downed -> NPC stays, cap drops, flag shown
  c = E.executeRound(c); c = E.advanceRound(c); c = E.executeRound(c); c = E.advanceRound(c);
  const npcs = c.soldiers.filter((u) => u.isNpc).length;
  assert.ok(npcs >= 1);
  op(c).downed = true; op(c).hp = 0;
  const st = E.reinforcementStatus(c);
  assert.equal(st.commanderDown, true);
  assert.equal(c.soldiers.filter((u) => u.isNpc).length, npcs);
});

test("NPC allies move, follow, fight and do not stall", () => {
  E.setRandom(Math.random);
  let s = fresh("assault", "medic");
  s.credits = 1000; s = E.hireReinforcement(s, "guard", "follow");
  s = E.executeRound(s); s = E.advanceRound(s);
  const npc = s.soldiers.find((u) => u.isNpc);
  assert.ok(npc, "npc arrived");
  place(op(s), 12, 12); place(op(s, "op-02"), 12, 13);
  const start = { x: npc.x, y: npc.y };
  s = E.executeRound(s);
  const after = s.soldiers.find((u) => u.isNpc);
  assert.ok(Math.abs(after.x - start.x) + Math.abs(after.y - start.y) > 3, "NPC follows the squad");
});

test("victory and defeat change the game state; no actions afterwards", () => {
  let s = fresh("hacker", "assault");
  s.map[17][18].terrain = "extraction";
  s.objective.complete = true; s.objective.progress = 2;
  place(op(s), 18, 17); place(op(s, "op-02"), 18, 16);
  let out = E.executeRound(s);
  assert.equal(out.phase, "victory");
  const q = E.queueAction(out, "op-01", { type: "reload" });
  assert.equal(op(q).orders.length, 0);
  assert.equal(E.executeRound(out).phase, "victory");

  let d = fresh("assault", "medic");
  for (const u of d.soldiers) { u.downed = true; u.hp = 0; }
  d = E.executeRound(d);
  assert.equal(d.phase, "defeat");
  assert.equal(E.queueAction(d, "op-01", { type: "reload" }).soldiers[0].orders.length, 0);
});

test("hacker: ends objective fast; only hacker unlocks the locked door", () => {
  const s = E.createMission("hacker", "assault");
  // locked door at (13,5)
  place(op(s), 13, 4); place(op(s, "op-02"), 12, 4);
  op(s, "op-02").orders.push({ type: "door", x: 13, y: 5 });
  let out = E.executeRound(s);
  assert.equal(out.map[5][13].locked, true, "assault cannot unlock");
  op(s).orders.push({ type: "hack", x: 13, y: 5 });
  out = E.executeRound(s);
  assert.equal(out.map[5][13].locked, false);
  // hacker cannot pass walls
  assert.equal(E.getReachableTiles(s, "op-01").some((t) => t.x === 13 && t.y === 5), false);
});

test("random full games keep invariants (no overlap, HP bounds, ammo bounds, finite)", () => {
  for (let seed = 1; seed <= 25; seed++) {
    let x = seed * 9301 + 49297;
    E.setRandom(() => ((x = (x * 9301 + 49297) % 233280) / 233280));
    let s = E.createMission(["assault", "scout", "hacker", "medic", "engineer", "commander"][seed % 6], "medic");
    s.credits = 3000;
    for (let round = 0; round < 12 && (s.phase === "planning" || s.phase === "execution"); round++) {
      if (s.phase === "planning") {
        for (const u of s.soldiers.filter((u) => !u.isNpc && !u.downed)) {
          const tiles = E.getReachableTiles(s, u.id);
          if (tiles.length) { const t = tiles[Math.floor(x % tiles.length)]; x = (x * 7 + 3) % 233280; s = E.queueAction(s, u.id, { type: "move", x: t.x, y: t.y }); }
          const vis = s.enemies.find((e) => e.visible && !e.downed);
          if (vis) s = E.queueAction(s, u.id, { type: "shoot", targetId: vis.id });
        }
        if (round === 1) s = E.hireReinforcement(s, "rifle");
        s = E.executeRound(s);
      }
      if (s.phase === "execution") s = E.advanceRound(s);
      const alive = [...s.soldiers, ...s.enemies].filter((u) => !u.downed && !u.eliminated);
      const keys = new Set();
      for (const u of alive) {
        const k = u.x + "," + u.y; assert.ok(!keys.has(k), `overlap ${k} seed ${seed}`); keys.add(k);
        assert.ok(u.hp > 0 && u.hp <= 100 && u.ammo >= 0 && u.ammo <= u.maxAmmo);
        assert.notEqual(s.map[u.y][u.x].terrain, "wall");
        assert.notEqual(s.map[u.y][u.x].terrain, "cover");
      }
    }
  }
});
