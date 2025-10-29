import express, { Router } from "express";
import messageController from "../controllers/messageController";

const router: Router = express.Router();

router.post("/messages/:code/bulk", async (req, res, next) => {
  try {
    await messageController.handleBulkSend(req, res);
  } catch (error) {
    next(error);
  }
});

router.get("/messages/:code/schedule", async (req, res, next) => {
  try {
    await messageController.listScheduled(req, res);
  } catch (error) {
    next(error);
  }
});

router.post("/messages/:code/schedule", async (req, res, next) => {
  try {
    await messageController.createSchedule(req, res);
  } catch (error) {
    next(error);
  }
});

router.delete("/messages/:code/schedule/:jobId", async (req, res, next) => {
  try {
    await messageController.cancelSchedule(req, res);
  } catch (error) {
    next(error);
  }
});
router.post("/messages/:code/voice", async (req, res, next) => {
  try {
    await messageController.handleVoiceMessage(req, res);
  } catch (error) {
    next(error);
  }
});

export default router;
