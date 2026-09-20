#!/usr/bin/env node
/**
 * Trigger a pipeline step on the deployed app from anywhere (your laptop,
 * GitHub Actions, any cron host). Reads OUTREACH_BASE_URL and
 * OUTREACH_ADMIN_TOKEN from the environment.
 *
 *   node scripts/outreach-run.mjs discover
 *   node scripts/outreach-run.mjs send
 *   node scripts/outreach-run.mjs stats
 *   node scripts/outreach-run.mjs sectors outreach/sectors.json   # upsert sectors from a file
 */
import { readFile } from "node:fs/promises";

const [command = "stats", arg] = process.argv.slice(2);
const base = (process.env.OUTREACH_BASE_URL ?? "").replace(/\/$/, "");
const token = process.env.OUTREACH_ADMIN_TOKEN;

if (!base || !token) {
  console.error("Set OUTREACH_BASE_URL (e.g. https://your-app.example) and OUTREACH_ADMIN_TOKEN.");
  process.exit(2);
}

const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

async function call(method, path, body) {
  const res = await fetch(`${base}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  console.log(JSON.stringify(data, null, 2));
  if (!res.ok) process.exit(1);
}

switch (command) {
  case "discover":
  case "send":
  case "all":
    await call("POST", `/api/outreach/run?step=${command}`);
    break;
  case "stats":
    await call("GET", "/api/outreach/stats");
    break;
  case "leads":
    await call("GET", `/api/outreach/leads${arg ? `?${arg}` : ""}`);
    break;
  case "sectors": {
    if (!arg) {
      await call("GET", "/api/outreach/sectors");
    } else {
      const list = JSON.parse(await readFile(arg, "utf8"));
      await call("POST", "/api/outreach/sectors", list);
    }
    break;
  }
  case "opt-out":
    if (!arg) {
      console.error("Usage: opt-out <phone-or-email>");
      process.exit(2);
    }
    await call("POST", "/api/outreach/opt-out", { identifier: arg });
    break;
  default:
    console.error(`Unknown command "${command}". Use discover | send | all | stats | leads | sectors [file] | opt-out <id>.`);
    process.exit(2);
}
