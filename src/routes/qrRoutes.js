"use strict";

const express = require("express");
const { getQr } = require("../controllers/qrController");

const router = express.Router();

router.get("/qr/:code", async (req, res, next) => {
  try {
    await getQr(req, res);
  } catch (error) {
    next(error);
  }
});

module.exports = router;
