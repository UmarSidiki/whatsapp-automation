import express, { Request, Response, NextFunction, Router } from "express";
import { getQr } from "../controllers/qrController";

const router: Router = express.Router();

router.get("/qr/:code", async (req: Request, res: Response, next: NextFunction) => {
  try {
    await getQr(req, res);
  } catch (error) {
    next(error);
  }
});

export default router;
