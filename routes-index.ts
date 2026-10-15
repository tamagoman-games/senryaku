import { Router, type IRouter } from "express";
import gamesRouter from "./routes-games";
import healthRouter from "./routes-health";
import matchesRouter from "./routes-matches";

const router: IRouter = Router();

router.use(healthRouter);
router.use(gamesRouter);
router.use(matchesRouter);

export default router;
