#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import fs from "fs/promises";
import path from "path";

// 1. SAFE LOGGING (Must write to stderr)
function logInfo(msg: string) { console.error(`[INFO] ${new Date().toISOString()} - ${msg}`); }
function logError(msg: string) { console.error(`[ERROR] ${new Date().toISOString()} - ${msg}`); }

// 2. DYNAMIC CONFIGURATION
const WORKSPACE_DIR = path.resolve(process.env["3SC_WORKSPACE_PATH"] || "./3sc-workspace-output");

// 3. SMART CACHING
interface CacheEntry {
    mtimeMs: number;
    data: any;
}
const artifactCache = new Map<string, CacheEntry>();

async function getArtifact(toolName: string, fileName: string): Promise<any> {
    const filePath = path.join(WORKSPACE_DIR, toolName, fileName);

    try {
        const stats = await fs.stat(filePath);
        const cached = artifactCache.get(filePath);

        // Cache HIT: File hasn't been modified since we last read it
        if (cached && cached.mtimeMs === stats.mtimeMs) {
            return cached.data;
        }

        // Cache MISS: File changed or first load
        logInfo(`Cache miss: Loading artifact from disk -> ${filePath}`);
        const rawData = await fs.readFile(filePath, "utf-8");
        const data = JSON.parse(rawData);

        // Save to cache
        artifactCache.set(filePath, { mtimeMs: stats.mtimeMs, data });
        return data;

    } catch (error: any) {
        if (error.code === 'ENOENT') {
            logError(`Artifact not found: ${filePath}`);
            return { error: `Artifact ${fileName} not found in ${toolName} workspace.` };
        }
        logError(`Failed to read/parse ${filePath}: ${error.message}`);
        return { error: `Failed to read artifact: ${error.message}` };
    }
}

// Initialize the MCP Server
const server = new Server(
    { name: "3SC-Platform", version: "1.0.0" },
    { capabilities: { tools: {} } }
);

// ==============================================================================
// TOOLS REGISTRATION
// ==============================================================================
server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
        {
            name: "get_architecture_violations",
            description: "Retrieves all active architectural policy violations that are failing the build (Protega).",
            inputSchema: { type: "object", properties: {} }
        },
        {
            name: "get_highest_risk_hotspots",
            description: "Returns the most risky modules in the codebase based on churn, bus-factor, and coupling (Vestigo).",
            inputSchema: { type: "object", properties: { limit: { type: "number", default: 5 } } }
        },
        {
            name: "get_cloud_waste_report",
            description: "Retrieves the top underutilized cloud resources to identify cost-saving opportunities (Atlas).",
            inputSchema: { type: "object", properties: {} }
        },
        {
            name: "get_schema_migration_risk",
            description: "Analyzes the proposed SQL schema migration for data loss or performance risks (Voda).",
            inputSchema: { type: "object", properties: {} }
        },
        {
            name: "get_data_governance_violations",
            description: "Checks the live database for data security violations like PII exposure (Vatra).",
            inputSchema: { type: "object", properties: {} }
        },
        {
            name: "get_pipeline_gate_status",
            description: "Checks if the CI/CD pipeline is paused waiting for an external system like Jira/ServiceNow (Custos).",
            inputSchema: { type: "object", properties: {} }
        },
        {
            name: "get_version_bump_justification",
            description: "Retrieves the semantic breaking changes that justified the application's version number (Insipio).",
            inputSchema: { type: "object", properties: {} }
        }
    ],
}));

// ==============================================================================
// TOOLS EXECUTION
// ==============================================================================
server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
        switch (request.params.name) {

            case "get_architecture_violations": {
                const data = await getArtifact("protega", "protega-report.json");
                if (data.error) return { content: [{ type: "text", text: JSON.stringify(data) }] };

                const violations = (data.newViolations || []).map((v: any) => ({
                    rule: v.policyName, file: v.violatingFilePath, error: v.errorMessage
                }));
                return { content: [{ type: "text", text: JSON.stringify({ status: data.summary?.finalResult, violations }, null, 2) }] };
            }

            case "get_highest_risk_hotspots": {
                const data = await getArtifact("vestigo", "vestigo-analysis.json");
                if (data.error) return { content: [{ type: "text", text: JSON.stringify(data) }] };

                const limit = (request.params.arguments?.limit as number) || 5;
                const areas = data.currentState?.trackedAreas || [];
                areas.sort((a: any, b: any) => (b.riskScore || 0) - (a.riskScore || 0));

                const top = areas.slice(0, limit).map((a: any) => ({
                    path: a.path, score: a.riskScore, owner: a.ownership?.topContributor
                }));
                return { content: [{ type: "text", text: JSON.stringify(top, null, 2) }] };
            }

            case "get_schema_migration_risk": {
                const data = await getArtifact("voda", "voda-report.json");
                if (data.error) return { content: [{ type: "text", text: JSON.stringify(data) }] };

                return {
                    content: [{
                        type: "text", text: JSON.stringify({
                            risk: data.overallRiskLevel,
                            requiresDualApproval: data.requiresDualApproval,
                            factors: (data.riskFactors || []).map((r: any) => ({ name: r.name, objects: r.affectedObjects }))
                        }, null, 2)
                    }]
                };
            }

            case "get_pipeline_gate_status": {
                const data = await getArtifact("custos", "custos-decision-report.json");
                if (data.error) return { content: [{ type: "text", text: JSON.stringify(data) }] };

                return {
                    content: [{
                        type: "text", text: JSON.stringify({
                            action: data.data?.proposedAction,
                            condition: data.data?.initialEvaluation?.condition,
                            passed: data.data?.initialEvaluation?.passed,
                            steps: data.data?.initialEvaluation?.steps
                        }, null, 2)
                    }]
                };
            }

            // Add remaining cases (Atlas, Vatra, Insipio) calling getArtifact() and formatting...

            default:
                throw new Error(`Tool not found: ${request.params.name}`);
        }
    } catch (error: any) {
        logError(`Tool execution failed: ${error.message}`);
        return { content: [{ type: "text", text: `{"error": "Execution failed: ${error.message}"}` }] };
    }
});

// Start the server
const transport = new StdioServerTransport();
server.connect(transport).then(() => {
    logInfo(`3SC MCP Server running. Watching workspace: ${WORKSPACE_DIR}`);
});
