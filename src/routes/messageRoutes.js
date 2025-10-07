"use strict";

const express = require("express");
const {
  handleBulkSend,
  createSchedule,
  listScheduled,
  cancelSchedule,
} = require("../controllers/messageController");

const router = express.Router();

router.post("/messages/:code/bulk", async (req, res, next) => {
  try {
    await handleBulkSend(req, res);
  } catch (error) {
    next(error);
  }
});

router.get("/messages/:code/schedule", async (req, res, next) => {
  try {
    await listScheduled(req, res);
  } catch (error) {
    next(error);
  }
});

router.post("/messages/:code/schedule", async (req, res, next) => {
  try {
    await createSchedule(req, res);
  } catch (error) {
    next(error);
  }
});

router.delete("/messages/:code/schedule/:jobId", async (req, res, next) => {
  try {
    await cancelSchedule(req, res);
  } catch (error) {
    next(error);
  }
});

module.exports = router;
