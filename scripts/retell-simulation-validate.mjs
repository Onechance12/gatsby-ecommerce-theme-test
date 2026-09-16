#!/usr/bin/env node
import {
  buildOfflineRetellSimulationContract,
  validateOfflineRetellSimulationContract
} from "../src/retell-simulation/contracts.js";

const result = validateOfflineRetellSimulationContract(buildOfflineRetellSimulationContract());
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
if (!result.valid) process.exitCode = 1;
