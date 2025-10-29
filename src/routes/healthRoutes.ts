import express, { Router } from "express";
import { getHealth } from "../controllers/healthController";

const router: Router = express.Router();

router.get("/health", getHealth);

export default router;
