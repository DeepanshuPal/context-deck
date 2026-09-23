import {createApp} from "./server.js";

const port = Number(process.env.PORT ?? 4173);
const {server, dbPath, captureDir} = createApp();
server.listen(port, "127.0.0.1", () => {
  console.log(`Context Deck running at http://127.0.0.1:${port}`);
  console.log(`Database: ${dbPath}`);
  console.log(`Extension captures folder: ${captureDir}`);
});
