// Run: node --experimental-strip-types --test artifacts/api-server/tests/rooms.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import * as R from "./rooms.ts";

const T0 = 1_000_000;
const mk = (mode, n, names = []) => {
  const reg = R.createRegistry();
  const { room, player: host } = R.createRoom(reg, { name: "Host", mode, role: "assault" }, T0);
  const players = [host];
  for (let i = 1; i < n; i++) players.push(R.joinRoom(reg, room.code, { name: names[i] ?? "P" + (i + 1), role: i % 2 ? "medic" : "scout" }, T0).player);
  return { reg, room, host, players };
};
const readyAll = (room, now = T0) => { for (const p of room.players) R.setLobby(room, p, { ready: true }, now); };
const code = (fn) => { try { fn(); return 0; } catch (e) { return e.status ?? -1; } };

test("create/join: codes, capacity, auto team assignment, no joining after start", () => {
  const { reg, room, players } = mk("team", 4);
  assert.match(room.code, /^[A-Z2-9]{6}$/);
  assert.deepEqual(players.map((p) => p.team), ["ALPHA", "ALPHA", "BRAVO", "BRAVO"]);
  const solo = mk("solo", 8);
  assert.equal(new Set(solo.players.map((p) => p.team)).size, 8);
  assert.equal(code(() => R.joinRoom(solo.reg, solo.room.code, {}, T0)), 409, "full room");
  assert.equal(code(() => R.joinRoom(reg, "NOPE00", {}, T0)), 404);
  const coop = mk("coop", 2);
  assert.equal(code(() => R.joinRoom(coop.reg, coop.room.code.toLowerCase(), {}, T0)), 409, "coop max 2 (case-insensitive code lookup)");
  assert.equal(code(() => R.createRoom(reg, { mode: "x" }, T0)), 400);
});

test("auth: wrong token / foreign player rejected", () => {
  const { room, players } = mk("solo", 2);
  assert.equal(R.authenticate(room, players[0].id, players[0].token).id, players[0].id);
  assert.equal(code(() => R.authenticate(room, players[0].id, players[1].token)), 403);
  assert.equal(code(() => R.authenticate(room, "nope", players[0].token)), 403);
  assert.equal(code(() => R.authenticate(room, players[0].id, undefined)), 403);
});

test("lobby: team changes limited to 2 per team, only in team mode; start validation", () => {
  const { room, host, players } = mk("team", 4);
  assert.equal(code(() => R.setLobby(room, players[2], { team: "ALPHA" }, T0)), 409);
  R.setLobby(room, players[1], { team: "CHARLIE" }, T0);
  assert.match(R.startBlocker(room), /2人/);
  R.setLobby(room, players[1], { team: "ALPHA" }, T0);
  assert.match(R.startBlocker(room), /準備/);
  assert.equal(code(() => R.startMatch(room, host, T0)), 409);
  readyAll(room);
  assert.equal(R.startBlocker(room), null);
  assert.equal(code(() => R.startMatch(room, players[1], T0)), 403, "only host");
  R.startMatch(room, host, T0);
  assert.equal(room.status, "playing");
  assert.equal(code(() => R.setLobby(room, host, { ready: false }, T0)), 409);
  const solo = mk("solo", 3);
  assert.equal(code(() => R.setLobby(solo.room, solo.players[1], { team: "ALPHA" }, T0)), 400);
  const five = mk("team", 6);
  five.room.players.pop(); five.room.players.pop(); five.room.players.pop(); // 3 players
  assert.match(R.startBlocker(five.room), /4・6・8/);
});

test("orders: only your own unit, validated by engine, stale round rejected, hidden target rejected", () => {
  const { room, host, players } = mk("solo", 2);
  readyAll(room); R.startMatch(room, host, T0);
  const [a, b] = players;
  const ua = room.match.soldiers.find((u) => u.ownerId === a.id);
  const ub = room.match.soldiers.find((u) => u.ownerId === b.id);
  assert.equal(code(() => R.submitOrders(room, a, { round: 1, unitId: ub.id, actions: [{ type: "reload" }] }, T0)), 403, "cannot command another player's unit");
  assert.equal(code(() => R.submitOrders(room, a, { round: 9, unitId: ua.id, actions: [] }, T0)), 409);
  const res = R.submitOrders(room, a, { round: 1, unitId: ua.id, actions: [{ type: "reload" }, { type: "shoot", targetId: ub.id }, { type: "move", x: 3, y: 5 }, { type: "bogus" }, { type: "reload" }] }, T0);
  assert.equal(res.accepted, 2); // reload + (shoot rejected: unseen) + move; max 2 orders
  assert.equal(room.match.soldiers.find((u) => u.id === ua.id).orders.length, 2);
  // resubmitting replaces rather than appends
  R.submitOrders(room, a, { round: 1, unitId: ua.id, actions: [{ type: "reload" }] }, T0);
  assert.equal(room.match.soldiers.find((u) => u.id === ua.id).orders.length, 1);
  assert.equal(code(() => R.submitOrders(room, a, { round: 1, unitId: ua.id, actions: "x" }, T0)), 400);
});

test("economy via server: team funds shared, equipment only on own unit, NPC commands only for own team", () => {
  const { room, host, players } = mk("team", 4);
  readyAll(room); R.startMatch(room, host, T0);
  const [a1, a2, b1] = players;
  const ua1 = room.match.soldiers.find((u) => u.ownerId === a1.id);
  const ua2 = room.match.soldiers.find((u) => u.ownerId === a2.id);
  R.teamAction(room, a1, { kind: "buy", unitId: ua1.id, item: "light-armor" }, T0);
  assert.equal(room.match.funds.ALPHA, 150);
  assert.equal(room.match.funds.BRAVO, 350);
  assert.equal(code(() => R.teamAction(room, a1, { kind: "buy", unitId: ua2.id, item: "ammo" }, T0)), 403);
  assert.equal(code(() => R.teamAction(room, a1, { kind: "buy", unitId: ua1.id, item: "gold" }, T0)), 400);
  R.teamAction(room, b1, { kind: "hire", type: "guard" }, T0);
  assert.equal(room.match.funds.BRAVO, 50);
  assert.equal(room.match.reinforcements[0].team, "BRAVO");
});

test("chat: team-only, never visible to other teams, sanitized, rate-limited", () => {
  const { room, host, players } = mk("team", 4);
  readyAll(room); R.startMatch(room, host, T0);
  const [a1, a2, b1, b2] = players;
  R.sendChat(room, a1, "  北の扉から行く\u0000<end> ", T0);
  const seenA2 = R.viewForPlayer(room, a2, T0 + 1).chat;
  assert.equal(seenA2.length, 1);
  assert.ok(!seenA2[0].body.includes("\u0000"));
  assert.equal(R.viewForPlayer(room, b1, T0 + 1).chat.length, 0);
  assert.ok(!JSON.stringify(R.viewForPlayer(room, b2, T0 + 1)).includes("北の扉"), "enemy view must not contain the message anywhere");
  for (let i = 0; i < 4; i++) R.sendChat(room, a1, "m" + i, T0 + 10);
  assert.equal(code(() => R.sendChat(room, a1, "spam", T0 + 11)), 429);
  assert.equal(code(() => R.sendChat(room, a1, "   ", T0 + 20_000)), 400);
  R.sendChat(room, a1, "ok again", T0 + 20_000);
});

test("views never contain tokens, other teams' units/funds/memory, or other teams' roster in a match", () => {
  const { room, host, players } = mk("team", 4);
  readyAll(room); R.startMatch(room, host, T0);
  const a1 = players[0];
  const v = R.viewForPlayer(room, a1, T0 + 5);
  const json = JSON.stringify(v);
  for (const p of players) assert.ok(!json.includes(p.token), "token leaked");
  assert.equal(v.players.length, 2);
  assert.ok(v.players.every((p) => p.team === "ALPHA"));
  assert.equal(v.match.credits, 350);
  assert.equal(v.match.funds, undefined);
  assert.equal(v.match.enemies.length, 0);
  assert.ok(!json.includes("BRAVO-"), "enemy unit names leaked");
});

test("timers: planning ends on time or when everyone is ready, execution replays then next round", () => {
  const { room, host, players } = mk("solo", 2);
  readyAll(room); R.startMatch(room, host, T0);
  assert.equal(R.tickRoom(room, T0 + 1000), false);
  R.setPlanningReady(room, players[0], true, T0 + 1000);
  assert.equal(R.tickRoom(room, T0 + 1000), false, "one player still planning");
  R.setPlanningReady(room, players[1], true, T0 + 2000);
  assert.equal(R.tickRoom(room, T0 + 2000), true);
  assert.equal(room.match.phase === "execution" || room.status === "finished", true);
  if (room.status === "playing") {
    assert.equal(R.tickRoom(room, T0 + 2000 + R.EXEC_MS - 1), false);
    assert.equal(R.tickRoom(room, T0 + 2000 + R.EXEC_MS), true);
    assert.equal(room.match.round, 2);
    assert.equal(room.match.phase, "planning");
    assert.equal(room.players.every((p) => !p.ready), true);
    // timeout path
    assert.equal(R.tickRoom(room, T0 + 2000 + R.EXEC_MS + R.PLAN_MS), true);
  }
});

test("a full solo game driven only through the server API finishes without errors", () => {
  for (const seed of [1, 2, 3]) {
    let x = seed * 31337;
    const rnd = () => ((x = (x * 9301 + 49297) % 233280) / 233280);
    const { room, host, players } = mk("solo", 4);
    readyAll(room); R.startMatch(room, host, T0);
    let now = T0;
    for (let i = 0; i < 400 && room.status === "playing"; i++) {
      now += 1000;
      if (room.match.phase === "planning") {
        for (const p of players) {
          const view = R.viewForPlayer(room, p, now);
          const me = view.match.soldiers[0];
          if (!me || me.downed || me.eliminated) continue;
          const dx = Math.floor(rnd() * 7) - 3, dy = Math.floor(rnd() * 7) - 3;
          const foe = view.match.enemies.find((e) => e.visible && !e.downed);
          const actions = [{ type: "move", x: Math.max(1, Math.min(18, me.x + dx)), y: Math.max(1, Math.min(18, me.y + dy)) }];
          if (foe) actions.push({ type: "shoot", targetId: foe.id });
          R.submitOrders(room, p, { round: view.match.round, unitId: me.id, actions }, now);
          R.setPlanningReady(room, p, true, now);
        }
      }
      R.tickRoom(room, now);
    }
    assert.ok(room.match.round >= 1);
  }
});

test("registry: idle rooms are pruned; room count capped", () => {
  const reg = R.createRegistry();
  R.createRoom(reg, { mode: "solo" }, T0);
  R.pruneRooms(reg, T0 + R.ROOM_TTL_MS + 1);
  assert.equal(reg.rooms.size, 0);
  for (let i = 0; i < R.MAX_ROOMS; i++) R.createRoom(reg, { mode: "solo" }, T0);
  assert.equal(code(() => R.createRoom(reg, { mode: "solo" }, T0)), 503);
});
