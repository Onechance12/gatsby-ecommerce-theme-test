// Fresh-process, read-only release attestation. No client reads or writes.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ['./mcp/server.mjs'],
  cwd: fileURLToPath(new URL('../', import.meta.url)),
  stderr: 'pipe',
});
const client = new Client({ name: 'operator-readonly-release-verifier', version: '1.0.0' });
try {
  await client.connect(transport);
  for (const name of ['bridge_restart_verify', 'management_report_status']) {
    const result = await client.callTool({ name, arguments: {} });
    if (result.isError) throw new Error(`${name} failed; no operational action was attempted.`);
    const value = JSON.parse(result.content.find(item => item.type === 'text').text);
    console.log(JSON.stringify({ tool: name, ready: value.ready,
      operatorBoundaryAttested: value.operatorBoundaryAttested,
      recoveryBoundaryAttested: value.recoveryBoundaryAttested,
      recoveryAllowed: value.recoveryAllowed,
      build: value.build ?? value.localPlugin?.pinnedBridgeBuild,
      unresolvedCount: value.unresolvedReceiptBoundary?.count,
      hardBlockedCount: value.unresolvedReceiptBoundary?.hardBlockedCount,
      readOnly: value.readOnly,
      externalWrites: value.externalWrites,
    }));
    if (value.ready !== true) throw new Error(`${name} was not ready; no operational action was attempted.`);
  }
} finally {
  await client.close();
}
