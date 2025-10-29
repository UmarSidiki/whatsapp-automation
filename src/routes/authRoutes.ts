import express, { Request, Response, NextFunction, Router } from "express";
import { startSession, endSession, sessionStatus } from "../controllers/authController";
import { authLimiter } from "../middleware/rateLimiters";

const router: Router = express.Router();

router.post("/auth", authLimiter, async (req: Request, res: Response, next: NextFunction) => {
  try {
    await startSession(req, res);
  } catch (error) {
    next(error);
  }
});

router.get("/auth/:code/status", async (req: Request, res: Response, next: NextFunction) => {
  try {
    await sessionStatus(req, res);
  } catch (error) {
    next(error);
  }
});

router.delete("/auth/:code", async (req: Request, res: Response, next: NextFunction) => {
  try {
    await endSession(req, res);
  } catch (error) {
    next(error);
  }
});

export default router;
