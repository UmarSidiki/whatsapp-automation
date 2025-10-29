import express, { Router, Request, Response, NextFunction } from "express";
import { configureAi, getAiConfig, updateCustomReplies } from "../controllers/aiController";

const router: Router = express.Router();

router.get("/ai/:code", async (req: Request, res: Response, next: NextFunction) => {
  try {
    await getAiConfig(req, res);
  } catch (error) {
    next(error);
  }
});

router.post("/ai/:code", async (req: Request, res: Response, next: NextFunction) => {
  try {
    await configureAi(req, res);
  } catch (error) {
    next(error);
  }
});

router.post("/ai/:code/replies", async (req: Request, res: Response, next: NextFunction) => {
  try {
    await updateCustomReplies(req, res);
  } catch (error) {
    next(error);
  }
});

export default router;
