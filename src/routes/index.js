"use strict";

const authRoutes = require("./authRoutes");
const aiRoutes = require("./aiRoutes");
const qrRoutes = require("./qrRoutes");
const healthRoutes = require("./healthRoutes");
const messageRoutes = require("./messageRoutes");

module.exports = function registerRoutes(app) {
  app.use(authRoutes);
  app.use(aiRoutes);
  app.use(messageRoutes);
  app.use(qrRoutes);
  app.use(healthRoutes);
};
