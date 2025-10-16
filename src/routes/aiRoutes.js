"use strict";

const express = require("express");
const { configureAi, getAiConfig, updateCustomReplies, getPersonaMessages } = require("../controllers/aiController");

const router = express.Router();

router.get("/ai/:code", async (req, res, next) => {
  try {
    await getAiConfig(req, res);
  } catch (error) {
    next(error);
  }
});

router.post("/ai/:code", async (req, res, next) => {
  try {
    await configureAi(req, res);
  } catch (error) {
    next(error);
  }
});

router.post("/ai/:code/replies", async (req, res, next) => {
  try {
    await updateCustomReplies(req, res);
  } catch (error) {
    next(error);
  }
});

router.get("/ai/:code/persona", async (req, res, next) => {
  try {
    await getPersonaMessages(req, res);
  } catch (error) {
    next(error);
  }
});

module.exports = router;
