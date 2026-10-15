import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as E from "./engine.ts";

beforeEach(() => E.setRandom(Math.random));
const P = (n, team, role = "assault") => ({ id: "pid" + n, name: "P" + n, role, team });
const unit = (s, id) => s.soldiers.find((u) => u.id === id);

test("team match: 4 players -> 2 teams of 2, shared funds per team, corner spawns on open floor", () => {
  const s = E.createMatch("team", [P(1, "ALPHA"), P(2, "ALPHA", "medic"), P(3, "BRAVO"), P(4, "BRAVO", "scout")]);
  assert.equal(s.soldiers.length, 4);
  assert.deepEqual(s.funds, { ALPHA: 350, BRAVO: 350 });
  for (const u of s.soldiers) {
    assert.ok(["floor"].includes(s.map[u.y][u.x].terrain));
    assert.ok(u.ownerId.startsWith("pid"));
  }
  assert.equal(new Set(s.soldiers.map((u) => u.x + "," + u.y)).size, 4);
});

test("funds: team shares one pool, solo players each have their own", () => {
  let t = E.createMatch("team", [P(1, "ALPHA"), P(2, "ALPHA"), P(3, "BRAVO"), P(4, "BRAVO")]);
  t = E.buyEquipment(t, "u1", "light-armor");
  assert.equal(t.funds.ALPHA, 150); assert.equal(t.funds.BRAVO, 350);
  assert.equal(unit(t, "u1").armor, "light");
  // teammate buying draws from the same pool
  t = E.buyEquipment(t, "u2", "light-armor");
  assert.equal(t.funds.ALPHA, 150, "insufficient (200 needed)");
  let s = E.createMatch("solo", [P(1, "ALPHA"), P(2, "BRAVO"), P(3, "CHARLIE")]);
  s = E.buyEquipment(s, "u2", "heavy-armor");
  assert.equal(s.funds.BRAVO, 350, "500 > 350: refused");
  s = E.buyEquipment(s, "u2", "precision-rifle");
  assert.deepEqual(s.funds, { ALPHA: 350, BRAVO: 50, CHARLIE: 350 });
  s = E.hireReinforcement(s, "guard", "follow", "ALPHA");
  assert.equal(s.funds.ALPHA, 50);
});

test("fog of war: an unseen enemy is absent from the view; nothing about it leaks", () => {
  const s = E.createMatch("solo", [P(1, "ALPHA"), P(2, "BRAVO")]);
  const a = unit(s, "u1"), b = unit(s, "u2");
  a.x = 3; a.y = 3; b.x = 17; b.y = 17;
  const s2 = E.computeVisibility(s);
  s2.viewTeam = "none";
  const v = E.viewFor(s2, "ALPHA");
  assert.equal(v.enemies.length, 0);
  const json = JSON.stringify(v);
  assert.ok(!json.includes('"u2"'), "enemy id leaked");
  assert.ok(!json.includes("PRIV"), "x");
  assert.equal(v.soldiers.length, 1);
  assert.equal(v.funds, undefined); assert.equal(v.memory, undefined); assert.equal(v.explored, undefined);
  assert.equal(v.credits, 350);
});

test("fog of war: seen enemy is shown with orders hidden; later hidden -> ghost with no real coordinates", () => {
  let s = E.createMatch("solo", [P(1, "ALPHA"), P(2, "BRAVO")]);
  const a = unit(s, "u1"), b = unit(s, "u2");
  for (const row of s.map) for (const c of row) if (c.x > 0 && c.y > 0 && c.x < 19 && c.y < 19) { c.terrain = "floor"; delete c.loot; }
  a.x = 3; a.y = 10; b.x = 8; b.y = 10; b.orders = [{ type: "move", x: 1, y: 1 }]; b.chase = { x: 99, y: 99 };
  s = E.computeVisibility(s);
  let v = E.viewFor(s, "ALPHA");
  assert.equal(v.enemies.length, 1);
  assert.equal(v.enemies[0].visible, true);
  assert.deepEqual(v.enemies[0].orders, []);
  assert.equal(v.enemies[0].chase, undefined);
  assert.equal(v.enemies[0].ownerId, undefined);
  // wall goes up; B moves away -> A only keeps the last confirmed position
  for (let y = 1; y < 19; y++) s.map[y][5].terrain = "wall";
  b.x = 15; b.y = 15;
  s = E.computeVisibility(s);
  v = E.viewFor(s, "ALPHA");
  assert.equal(v.enemies.length, 1);
  assert.equal(v.enemies[0].visible, false);
  assert.deepEqual(v.enemies[0].lastKnown, { x: 8, y: 10 });
  assert.equal(v.enemies[0].x, -1); assert.equal(v.enemies[0].y, -1);
  assert.ok(!JSON.stringify(v.enemies).includes("15"), "real position leaked");
  // B's view is symmetric but independent
  const vb = E.viewFor(s, "BRAVO");
  assert.equal(vb.soldiers[0].id, "u2");
});

test("unexplored loot is hidden; explored loot is shown", () => {
  const s = E.createMatch("team", [P(1, "ALPHA"), P(2, "ALPHA"), P(3, "BRAVO"), P(4, "BRAVO")]);
  const hasLoot = (v) => v.map.flat().filter((c) => c.terrain === "loot").length;
  const authoritative = hasLoot(s);
  const v = E.viewFor(s, "ALPHA");
  assert.ok(authoritative > 0 && hasLoot(v) < authoritative);
});

test("battle log is team-private: enemy actions you cannot see never appear", () => {
  E.setRandom(() => 0.0);
  let s = E.createMatch("solo", [P(1, "ALPHA"), P(2, "BRAVO"), P(3, "CHARLIE")]);
  for (const row of s.map) for (const c of row) if (c.x > 0 && c.y > 0 && c.x < 19 && c.y < 19) { c.terrain = "floor"; delete c.loot; }
  const [a, b, c] = ["u1", "u2", "u3"].map((id) => unit(s, id));
  a.x = 3; a.y = 3; b.x = 15; b.y = 15; c.x = 17; c.y = 15; // B and C fight, A is far away
  s = E.computeVisibility(s);
  b.orders = [{ type: "overwatch", direction: "E" }];
  s = E.executeRound(s);
  const logA = E.viewFor(s, "ALPHA").log.map((l) => l.message).join("\n");
  assert.ok(!/BRAVO-1|CHARLIE-1/.test(logA), "A must not read B vs C combat:\n" + logA);
  const logB = E.viewFor(s, "BRAVO").log.map((l) => l.message).join("\n");
  assert.match(logB, /BRAVO-1/);
});

test("solo: last team standing wins; losers see defeat; no actions afterwards", () => {
  E.setRandom(() => 0.0);
  let s = E.createMatch("solo", [P(1, "ALPHA"), P(2, "BRAVO"), P(3, "CHARLIE")]);
  for (const row of s.map) for (const c of row) if (c.x > 0 && c.y > 0 && c.x < 19 && c.y < 19) { c.terrain = "floor"; delete c.loot; }
  const [a, b, c] = ["u1", "u2", "u3"].map((id) => unit(s, id));
  a.x = 5; a.y = 10; b.x = 8; b.y = 10; c.x = 17; c.y = 17;
  b.eliminated = true; b.downed = true; b.hp = 0;
  c.downed = true; c.hp = 0; c.eliminated = true;
  s = E.executeRound(s);
  assert.equal(s.phase, "victory");
  assert.equal(s.winner, "ALPHA");
  assert.equal(E.viewFor(s, "ALPHA").phase, "victory");
  assert.equal(E.viewFor(s, "BRAVO").phase, "defeat");
  assert.equal(E.queueAction(s, "u1", { type: "reload" }).soldiers[0].orders.length, 0);
});

test("team battle: a team with one member down but a teammate up is still in; both down = out", () => {
  E.setRandom(() => 0.5);
  let s = E.createMatch("team", [P(1, "ALPHA"), P(2, "ALPHA"), P(3, "BRAVO"), P(4, "BRAVO")]);
  unit(s, "u1").downed = true; unit(s, "u1").hp = 0;
  assert.equal(E.isTeamOut(s, "ALPHA"), false);
  unit(s, "u2").downed = true; unit(s, "u2").hp = 0;
  assert.equal(E.isTeamOut(s, "ALPHA"), true);
  s = E.executeRound(s);
  assert.equal(s.phase, "victory"); assert.equal(s.winner, "BRAVO");
});

test("teammates can rescue; enemies cannot; NPC hired for a team joins that team only", () => {
  E.setRandom(() => 0.5);
  let s = E.createMatch("team", [P(1, "ALPHA"), P(2, "ALPHA", "medic"), P(3, "BRAVO"), P(4, "BRAVO")]);
  for (const row of s.map) for (const c of row) if (c.x > 0 && c.y > 0 && c.x < 19 && c.y < 19) { c.terrain = "floor"; delete c.loot; }
  const u1 = unit(s, "u1"), u2 = unit(s, "u2"), u3 = unit(s, "u3");
  u1.x = 10; u1.y = 10; u1.downed = true; u1.hp = 0; u1.bleedRounds = 3;
  u2.x = 10; u2.y = 11; u3.x = 17; u3.y = 12; u3.orders = [];
  s = E.computeVisibility(s);
  const bad = E.queueAction(s, "u3", { type: "rescue", targetId: "u1" });
  assert.equal(unit(bad, "u3").orders.length, 0, "enemy cannot rescue");
  const ok = E.queueAction(s, "u2", { type: "rescue", targetId: "u1" });
  assert.equal(unit(ok, "u2").orders.length, 1);
  let h = E.hireReinforcement(s, "guard", "follow", "BRAVO");
  assert.equal(h.funds.BRAVO, 50); assert.equal(h.funds.ALPHA, 350);
  h = E.executeRound(h); h = E.advanceRound(h);
  const npc = h.soldiers.find((u) => u.isNpc);
  assert.equal(npc.team, "BRAVO");
});

test("random 8-player solo and 8-player team games: no crashes, invariants hold, no view leaks", () => {
  for (let seed = 1; seed <= 12; seed++) {
    let x = seed * 7919 + 17;
    const rnd = () => ((x = (x * 9301 + 49297) % 233280) / 233280);
    E.setRandom(rnd);
    const roles = ["assault", "scout", "hacker", "medic", "engineer", "commander"];
    const mode = seed % 2 ? "solo" : "team";
    const players = Array.from({ length: 8 }, (_, i) => P(i + 1, mode === "solo" ? E.TEAM_IDS[i] : E.TEAM_IDS[Math.floor(i / 2)], roles[(i + seed) % 6]));
    let s = E.createMatch(mode, players);
    for (let round = 0; round < 14 && s.phase !== "victory"; round++) {
      for (const u of s.soldiers.filter((u) => !u.isNpc && !u.downed && !u.eliminated)) {
        const team = u.team;
        const view = E.viewFor(s, team);
        const me = view.soldiers.find((m) => m.id === u.id);
        const tiles = E.getReachableTiles(view, u.id);
        if (tiles.length) { const t = tiles[Math.floor(rnd() * tiles.length)]; s = E.queueAction(s, u.id, { type: "move", x: t.x, y: t.y }); }
        const foe = view.enemies.find((e) => e.visible && !e.downed);
        if (foe) s = E.queueAction(s, u.id, { type: "shoot", targetId: foe.id });
        assert.ok(me);
      }
      s = E.executeRound(s);
      if (s.phase === "execution") s = E.advanceRound(s);
      const alive = s.soldiers.filter((u) => !u.downed && !u.eliminated);
      assert.equal(new Set(alive.map((u) => u.x + "," + u.y)).size, alive.length, "overlap");
      for (const team of new Set(s.soldiers.map((u) => u.team))) {
        const v = E.viewFor(s, team);
        const seenIds = new Set(v.enemies.filter((e) => e.visible).map((e) => e.id));
        for (const e of v.enemies) {
          if (e.visible) {
            const real = s.soldiers.find((u) => u.id === e.id);
            assert.ok(real.seenBy.includes(team), "view shows an unseen unit");
          } else {
            assert.equal(e.x, -1); assert.deepEqual(e.orders, []);
          }
        }
        assert.ok(v.soldiers.every((m) => m.team === team));
      }
    }
  }
});
