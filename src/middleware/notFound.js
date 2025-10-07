"use strict";

module.exports = function notFound(req, res, next) {
  if (req.method === "GET" && req.accepts("html")) {
    return next();
  }
  res.status(404).json({ error: "Not found" });
};
