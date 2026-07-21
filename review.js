#!/usr/bin/env node
// review.js — entry point. Creates the server assembled in server.js and
// listens on the fixed port 7777 (the user's bookmark depends on it staying
// put, so unlike a dev server this never auto-picks a different port).

import { createServer } from './server.js';

const PORT = 7777;
const HOST = 'localhost';

const server = createServer();

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(
      `Port ${PORT} is already in use. Stop whatever is using it (or wait for it to ` +
        `exit) and try again -- AI CodeReview Helper always runs on ${PORT} so bookmarks stay valid.`,
    );
    process.exit(1);
  }
  console.error(err);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  console.log(`AI CodeReview Helper running at http://${HOST}:${PORT}`);
});
