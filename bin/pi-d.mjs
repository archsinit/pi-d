#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
import { existsSync } from "node:fs";
// A checkout follows source edits; the installable tarball contains JavaScript only.
await import(existsSync(new URL("../src/cli.ts", import.meta.url)) ? "../src/cli.ts" : "../dist/cli.js");
