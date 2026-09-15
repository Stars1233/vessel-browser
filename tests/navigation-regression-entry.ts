import { app } from "electron";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { main } from "./navigation-regression";

const resultPath = process.env.VESSEL_NAVIGATION_RESULT_PATH;
if (!resultPath) throw new Error("Missing navigation result path");
const userData = path.join(path.dirname(resultPath), "user-data");
mkdirSync(userData, { recursive: true });
app.setPath("userData", userData);
app.setPath("sessionData", userData);
// Each scenario destroys its last window before the next scenario opens one.
app.on("window-all-closed", () => {});

main().then(
  (scenarios) => {
    writeFileSync(resultPath, JSON.stringify({ passed: true, scenarios }));
    app.exit(0);
  },
  (error) => {
    console.error("Navigation regression suite failed.", error);
    app.exit(1);
  },
);
