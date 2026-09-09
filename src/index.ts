#!/usr/bin/env node
import { config as loadDotenv } from "dotenv";
import { envFile } from "./config/paths.js";

// Load ~/.sidequest/.env before anything reads process.env, then the local .env
// so a checkout can override the global config during development.
loadDotenv({ path: envFile() });
loadDotenv();

const { runCli } = await import("./cli.js");

await runCli(process.argv);
