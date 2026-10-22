// Fresh-process, read-only release attestation. No client reads or writes.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
if (args.some(arg => arg !== '--retell') || args.length > 1) {
  throw new Error('Use no arguments or --retell for read-only claim-agent verification.');
}
const retell = args.includes('--retell');
const configurationCheckNames = new Set(`mode agent_configured from_number_configured
  callback_webhook_available callback_packet_restoration guarded_end_credential_configured
  guarded_end_credential_isolated inbound_webhook_credential_configured inbound_webhook_credential_isolated
  inbound_webhook_authentication inbound_fallback_agent_unset phone_number_matches inbound_webhook_url_matches
  inbound_agent_routing_matches expected_phone_config_digest live_phone_config_digest guarded_end_authorization_matches
  dtmf_press_digit_available guarded_end_call_available prompt_matches tools_match analysis_schema_matches timezone_matches
  agent_published llm_published agent_version llm_version agent_config_digest expected_config_digest live_config_digest
  approval_model writeback_requires_separate_approval automatic_jobnimbus_writeback_disabled`.split(/\s+/));
const configurationGroupNames = new Set(`llm_settings transfer_llm agent_settings voice_configuration
  retained_agent_configuration retained_llm_configuration agent_identity llm_identity publication_receipt`.split(/\s+/));
const retainedValueNames = new Set(`model_ultrafast_false model_ultrafast_requires_review
  model_config_standard_no_backup_omitted model_config_standard_no_backup_null
  model_config_standard_backup_30150 model_config_requires_review`.split(/\s+/));

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ['./mcp/server.mjs'],
  cwd: fileURLToPath(new URL('../', import.meta.url)),
  stderr: 'pipe',
});
const client = new Client({ name: 'operator-readonly-release-verifier', version: '1.0.0' });
try {
  await client.connect(transport);
  for (const name of ['bridge_restart_verify', retell ? 'retell_claim_configuration_verify' : 'management_report_status']) {
    const result = await client.callTool({ name, arguments: {} });
    if (result.isError) {
      // Only the new fixed diagnostic vocabulary may leave the MCP error path.
      const message = result.content?.find(item => item.type === 'text')?.text || '';
      const candidate = message.match(/configuration failed required safety attestations: ([a-z_]+(?:, [a-z_]+)*)\./)?.[1];
      const checks = candidate?.split(', ').every(name => configurationCheckNames.has(name)) ? candidate : '';
      const groupCandidate = message.match(/Failed configuration groups: ([a-z_]+(?:, [a-z_]+)*)\./)?.[1];
      const groups = groupCandidate?.split(', ').every(name => configurationGroupNames.has(name)) ? groupCandidate : '';
      const retainedCandidate = message.match(/Known retained LLM values: ([a-z_0-9]+(?:, [a-z_0-9]+)*)\./)?.[1];
      const retained = retainedCandidate?.split(', ').every(name => retainedValueNames.has(name)) ? retainedCandidate : '';
      throw new Error(`${name} failed${checks ? ` (checks: ${checks})` : ''}${groups ? ` (groups: ${groups})` : ''}${retained ? ` (retained: ${retained})` : ''}; no operational action was attempted.`);
    }
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
      ...(name === 'retell_claim_configuration_verify' ? {
        mode: value.mode,
        agentVersion: value.agentVersion,
        llmVersion: value.llmVersion,
        publicationReceiptMatches: value.publicationReceiptMatches,
        llmSettingsMatch: value.llmSettingsMatch,
        agentSettingsMatch: value.agentSettingsMatch,
        voiceConfigurationMatches: value.voiceConfigurationMatches,
        retainedAgentConfigurationMatches: value.retainedAgentConfigurationMatches,
        retainedLlmConfigurationMatches: value.retainedLlmConfigurationMatches,
      } : {}),
    }));
    if (value.ready !== true) throw new Error(`${name} was not ready; no operational action was attempted.`);
  }
} finally {
  await client.close();
}
