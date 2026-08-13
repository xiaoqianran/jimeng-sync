const express = require("express");
const path = require("path");

function create(config) {
  const router = express.Router();
  router.use(express.static(path.join(config.root, "public")));
  return router;
}

module.exports = { create };
