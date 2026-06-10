#!/usr/bin/env node
import { runLauncher } from './nullbuilder-launcher.js';

process.exit(runLauncher({ moduleUrl: import.meta.url }));
