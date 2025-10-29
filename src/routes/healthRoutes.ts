import express, { Router, Request, Response } from "express";
import { getHealth } from "../controllers/healthController";
import env from "../config/env";
import fs from "fs";
import path from "path";

const router: Router = express.Router();

router.get("/health", getHealth);

router.get("/debug/static", (req: Request, res: Response) => {
  const staticDir = env.staticDir;
  const indexPath = path.join(staticDir, "index.html");
  const scriptPath = path.join(staticDir, "script.js");
  
  res.json({
    staticDir,
    staticDirExists: fs.existsSync(staticDir),
    indexHtmlExists: fs.existsSync(indexPath),
    scriptJsExists: fs.existsSync(scriptPath),
    indexPath,
    scriptPath,
    cwd: process.cwd(),
  });
});

export default router;
