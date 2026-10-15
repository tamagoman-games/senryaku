import { randomBytes, randomUUID } from "node:crypto";
import { Router, type IRouter } from "express";
import {
  CreateGameRoomBody,
  GetGameRoomParams,
  JoinGameRoomBody,
  JoinGameRoomParams,
  SendGameRoomMessageBody,
  SendGameRoomMessageParams,
  UpdateGameRoomStateBody,
  UpdateGameRoomStateParams,
} from "./api-zod";

type Player = {
  id: string;
  name: string;
  role: "assault" | "scout" | "hacker" | "medic" | "engineer" | "commander";
  joinedAt: string;
};

type Message = {
  id: string;
  senderId: string;
  senderName: string;
  body: string;
  sentAt: string;
};

type Room = {
  code: string;
  mode: "coop";
  players: Player[];
  status: "waiting" | "active";
  version: number;
  snapshot: string | null;
  updatedAt: string;
  messages: Message[];
};

const rooms = new Map<string, Room>();
const router: IRouter = Router();
const codeAlphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function createCode(): string {
  let code = "";
  do {
    code = Array.from(
      randomBytes(6),
      (byte) => codeAlphabet[byte % codeAlphabet.length],
    ).join("");
  } while (rooms.has(code));
  return code;
}

function getRoom(code: string): Room | undefined {
  return rooms.get(code.trim().toUpperCase());
}

function envelope(room: Room, playerId: string) {
  return {
    room: {
      code: room.code,
      mode: room.mode,
      players: room.players,
      status: room.status,
      version: room.version,
      snapshot: room.snapshot,
      updatedAt: room.updatedAt,
    },
    playerId,
    messages: room.messages,
  };
}

function member(room: Room, playerId: string): Player | undefined {
  return room.players.find((player) => player.id === playerId);
}

router.post("/games/rooms", (req, res) => {
  const parsed = CreateGameRoomBody.safeParse(req.body);
  const name = parsed.success ? parsed.data.name.trim() : "";
  if (!parsed.success || !name) {
    res.status(400).json({ error: "Enter a player name." });
    return;
  }

  const now = new Date().toISOString();
  const player: Player = { id: randomUUID(), name, role: parsed.data.role, joinedAt: now };
  const room: Room = {
    code: createCode(),
    mode: "coop",
    players: [player],
    status: "waiting",
    version: 0,
    snapshot: null,
    updatedAt: now,
    messages: [],
  };
  rooms.set(room.code, room);
  res.status(201).json(envelope(room, player.id));
});

router.post("/games/rooms/:code/join", (req, res) => {
  const route = JoinGameRoomParams.safeParse(req.params);
  const parsed = JoinGameRoomBody.safeParse(req.body);
  const name = parsed.success ? parsed.data.name.trim() : "";
  if (!route.success || !parsed.success || !name) {
    res.status(400).json({ error: "Enter a valid room code and player name." });
    return;
  }

  const room = getRoom(route.data.code);
  if (!room) {
    res.status(404).json({ error: "Room not found. Check the code and try again." });
    return;
  }
  if (room.status !== "waiting" || room.players.length >= 2) {
    res.status(409).json({ error: "This co-op room already has two players." });
    return;
  }

  const now = new Date().toISOString();
  const player: Player = { id: randomUUID(), name, role: parsed.data.role, joinedAt: now };
  room.players.push(player);
  room.status = "active";
  room.updatedAt = now;
  res.json(envelope(room, player.id));
});

router.get("/games/rooms/:code", (req, res) => {
  const route = GetGameRoomParams.safeParse(req.params);
  if (!route.success) {
    res.status(400).json({ error: "Invalid room code." });
    return;
  }

  const room = getRoom(route.data.code);
  if (!room) {
    res.status(404).json({ error: "Room not found." });
    return;
  }

  // Room codes are shareable bearer codes. A room is one co-op team, so its
  // messages are only shared with participants who have the code.
  res.json(envelope(room, ""));
});

router.put("/games/rooms/:code/state", (req, res) => {
  const route = UpdateGameRoomStateParams.safeParse(req.params);
  const parsed = UpdateGameRoomStateBody.safeParse(req.body);
  if (!route.success || !parsed.success) {
    res.status(400).json({ error: "Invalid game state update." });
    return;
  }

  const room = getRoom(route.data.code);
  if (!room) {
    res.status(404).json({ error: "Room not found." });
    return;
  }

  const input = parsed.data;
  if (!member(room, input.playerId)) {
    res.status(403).json({ error: "Only room participants can update game state." });
    return;
  }
  if (room.status !== "active") {
    res.status(409).json({ error: "Wait for the second player to join." });
    return;
  }
  if (room.version !== input.expectedVersion) {
    res.status(409).json({ error: "The room changed. Refresh and retry." });
    return;
  }
  try {
    JSON.parse(input.snapshot);
  } catch {
    res.status(400).json({ error: "Snapshot must contain valid JSON." });
    return;
  }

  room.snapshot = input.snapshot;
  room.version += 1;
  room.updatedAt = new Date().toISOString();
  res.json(envelope(room, input.playerId));
});

router.post("/games/rooms/:code/messages", (req, res) => {
  const route = SendGameRoomMessageParams.safeParse(req.params);
  const parsed = SendGameRoomMessageBody.safeParse(req.body);
  const body = parsed.success ? parsed.data.body.trim() : "";
  if (!route.success || !parsed.success || !body) {
    res.status(400).json({ error: "Message cannot be empty." });
    return;
  }

  const room = getRoom(route.data.code);
  if (!room) {
    res.status(404).json({ error: "Room not found." });
    return;
  }
  const player = member(room, parsed.data.playerId);
  if (!player) {
    res.status(403).json({ error: "Only room participants can send messages." });
    return;
  }
  if (room.status !== "active") {
    res.status(409).json({ error: "Team communication opens when both players join." });
    return;
  }

  room.messages.push({
    id: randomUUID(),
    senderId: player.id,
    senderName: player.name,
    body,
    sentAt: new Date().toISOString(),
  });
  if (room.messages.length > 200) room.messages.splice(0, room.messages.length - 200);
  room.updatedAt = new Date().toISOString();
  res.status(201).json(envelope(room, player.id));
});

export default router;
