"use strict";

const express = require("express");
const { startSession, endSession, sessionStatus } = require("../controllers/authController");
const { authLimiter } = require("../middleware/rateLimiters");

const router = express.Router();

router.post("/auth", authLimiter, async (req, res, next) => {
  try {
    await startSession(req, res);
  } catch (error) {
    next(error);
  }
});

router.get("/auth/:code/status", async (req, res, next) => {
  try {
    await sessionStatus(req, res);
  } catch (error) {
    next(error);
  }
});

router.delete("/auth/:code", async (req, res, next) => {
  try {
    await endSession(req, res);
  } catch (error) {
    next(error);
  }
});

module.exports = router;
