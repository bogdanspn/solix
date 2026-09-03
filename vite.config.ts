import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { config as loadEnv } from "dotenv";

loadEnv();

/*
 * Where the dev frontend gets its data.
 *
 * By default, a server running alongside on this machine. Set SOLIX_API in
 * .env to a deployed instance instead, and frontend work runs against live
 * data without opening a second Modbus connection to the battery.
 *
 * That matters: the Solarbank tolerates about two concurrent Modbus
 * consumers, and a deployed dashboard plus the phone app already account for
 * both. A dev server polling as a third is what previously left the battery
 * refusing connections to everything, including the app.
 */
const apiTarget = process.env.SOLIX_API ?? "http://localhost:8787";

export default defineConfig({
  root: "web",
  build: {
    outDir: "../dist",
    emptyOutDir: true,
  },
  server: {
    port: 5273,
    // Listen on the LAN so the dashboard is reachable from a phone in dev too.
    host: true,
    proxy: {
      "/api": {
        target: apiTarget,
        changeOrigin: true,
        configure: () => console.log("  api -> " + apiTarget),
      },
    },
  },
});
