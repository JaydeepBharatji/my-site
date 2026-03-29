'use strict';

require('dotenv').config();

const express = require('express');
const path    = require('path');
const app     = express();

app.use(express.json());

// Serve static files (HTML, CSS, JS, SVG, images) from this directory
app.use(express.static(__dirname));

// Route /api/:fn  →  api/:fn.js handler
app.all('/api/:fn', (req, res) => {
  const fnPath = path.join(__dirname, 'api', `${req.params.fn}.js`);
  try {
    // Clear require cache in dev so edits to api files are picked up on next request
    delete require.cache[require.resolve(fnPath)];
    const handler = require(fnPath);
    handler(req, res);
  } catch (err) {
    if (err.code === 'MODULE_NOT_FOUND') {
      return res.status(404).json({ error: `API function '${req.params.fn}' not found` });
    }
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n  Devji Kuwait dev server`);
  console.log(`  http://localhost:${PORT}\n`);
});
