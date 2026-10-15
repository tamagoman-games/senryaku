import { Router, type IRouter, type Request, type Response } from "express";
import {
  RoomError,
  authenticate,
  createRegistry,
  createRoom,
  getRoom,
  joinRoom,
  sendChat,
  setLobby,
  setPlanningReady,
  startMatch,
  submitOrders,
  teamAction,
  tickAll,
  viewForPlayer,
  type LobbyPlayer,
  type Room,
  type TeamAction,
} from "./rooms";

/**
 * Server-authoritative multiplayer API (co-op, solo, team battle).
 * Rooms live in this process's memory: run ONE instance of the API server.
 * Credentials are sent in headers (x-player-id / x-player-token), never in the URL.
 */
const router: IRouter = Router();
const registry = createRegistry();

const ticker = setInterval(() => tickAll(registry, Date.now()), 500);
ticker.unref();

function handle(fn: (req: Request, res: Response) => void) {
  return (req: Request, res: Response) => {
    try {
      fn(req, res);
    } catch (error) {
      if (error instanceof RoomError) {
        res.status(error.status).json({ error: error.message });
        return;
      }
      req.log.error({ err: error }, "match route failed");
      res.status(500).json({ error: "サーバーエラーが発生しました。" });
    }
  };
}

function authed(req: Request): { room: Room; player: LobbyPlayer } {
  const room = getRoom(registry, req.params["code"]);
  const player = authenticate(room, req.header("x-player-id"), req.header("x-player-token"));
  return { room, player };
}

const body = (req: Request): Record<string, unknown> =>
  req.body && typeof req.body === "object" ? (req.body as Record<string, unknown>) : {};

router.post(
  "/matches",
  handle((req, res) => {
    const { room, player } = createRoom(registry, body(req), Date.now());
    res.status(201).json({ code: room.code, playerId: player.id, token: player.token });
  }),
);

router.post(
  "/matches/:code/join",
  handle((req, res) => {
    const { room, player } = joinRoom(registry, req.params["code"], body(req), Date.now());
    res.status(201).json({ code: room.code, playerId: player.id, token: player.token });
  }),
);

router.get(
  "/matches/:code",
  handle((req, res) => {
    const { room, player } = authed(req);
    res.json(viewForPlayer(room, player, Date.now()));
  }),
);

router.post(
  "/matches/:code/lobby",
  handle((req, res) => {
    const { room, player } = authed(req);
    setLobby(room, player, body(req), Date.now());
    res.json(viewForPlayer(room, player, Date.now()));
  }),
);

router.post(
  "/matches/:code/start",
  handle((req, res) => {
    const { room, player } = authed(req);
    startMatch(room, player, Date.now());
    res.json(viewForPlayer(room, player, Date.now()));
  }),
);

router.post(
  "/matches/:code/orders",
  handle((req, res) => {
    const { room, player } = authed(req);
    const result = submitOrders(room, player, body(req), Date.now());
    res.json({ ...result, state: viewForPlayer(room, player, Date.now()) });
  }),
);

router.post(
  "/matches/:code/action",
  handle((req, res) => {
    const { room, player } = authed(req);
    teamAction(room, player, body(req) as TeamAction, Date.now());
    res.json(viewForPlayer(room, player, Date.now()));
  }),
);

router.post(
  "/matches/:code/ready",
  handle((req, res) => {
    const { room, player } = authed(req);
    setPlanningReady(room, player, body(req)["ready"] !== false, Date.now());
    res.json(viewForPlayer(room, player, Date.now()));
  }),
);

router.post(
  "/matches/:code/chat",
  handle((req, res) => {
    const { room, player } = authed(req);
    sendChat(room, player, body(req)["body"], Date.now());
    res.json(viewForPlayer(room, player, Date.now()));
  }),
);

export default router;
