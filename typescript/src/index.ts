#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { 
  ListToolsRequestSchema, 
  CallToolRequestSchema, 
  ListPromptsRequestSchema, 
  GetPromptRequestSchema 
} from "@modelcontextprotocol/sdk/types.js";
import fs from "fs/promises";
import path from "path";

// ==============================================================================
// 1. SAFE LOGGING (Must write to stderr to not corrupt MCP protocol)
// ==============================================================================
function logInfo(msg: string) { console.error(`[INFO] ${new Date().toISOString()} - ${msg}`); }
function logError(msg: string) { console.error(`[ERROR] ${new Date().toISOString()} - ${msg}`); }

// ==============================================================================
// 2. DYNAMIC CONFIGURATION
// ==============================================================================
const WORKSPACE_DIR = path.resolve(process.env["3SC_WORKSPACE_PATH"] || "./3sc-workspace-output");

// ==============================================================================
// 3. SMART CACHING (Protects CPU/Memory on large enterprise files)
// ==============================================================================
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
  { capabilities: { tools: {}, prompts: {} } }
);

// ==============================================================================
// 4. PROMPTS (Prebaked UI Buttons in Claude/Cursor)
// ==============================================================================
server.setRequestHandler(ListPromptsRequestSchema, async () => ({
  prompts: [
    { 
      name: "review_pr_risk", 
      description: "Generate a comprehensive PR Risk & Architecture Review using 3SC tools." 
    },
    { 
      name: "draft_release_notes", 
      description: "Draft Automated Release Notes using Signet and Insipio." 
    },
    { 
      name: "summarize_finops", 
      description: "Generate a FinOps Cloud Waste Report using Atlas." 
    }
  ]
}));

server.setRequestHandler(GetPromptRequestSchema, async (request) => {
  const prompts: Record<string, string> = {
    review_pr_risk: "You are an expert Principal Engineer. Please review the latest CI run artifacts to assess the risk of this Pull Request.\n1. Check `get_schema_migration_risk` (Voda)\n2. Check `get_highest_risk_hotspots` (Vestigo)\n3. Check `get_architecture_violations` (Protega)\n4. Check `get_data_governance_violations` (Vatra)\n\nSynthesize this into a professional Markdown summary. Highlight risks with emojis (🚨, ⚠️, ✅).",
    draft_release_notes: "Draft a professional release notes document for our stakeholders.\n1. Use `get_release_manifest` (Signet) to get the version and Work Items.\n2. Use `get_version_bump_justification` (Insipio) to explain *why* the version bumped.\nFormat as a beautiful Markdown changelog.",
    summarize_finops: "Use `get_cloud_waste_report` (Atlas) to identify our most underutilized and expensive cloud resources. Write a brief executive summary recommending where we can cut costs immediately."
  };
  
  const content = prompts[request.params.name];
  if (!content) throw new Error("Prompt not found");
  
  return { 
    description: "3SC Automation Prompt", 
    messages: [{ role: "user", content: { type: "text", text: content } }] 
  };
});

// ==============================================================================
// 5. TOOLS REGISTRATION
// ==============================================================================
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    { name: "get_architecture_diagram", description: "Generates a Mermaid.js visual dependency diagram for a specific component using Scrutari.", inputSchema: { type: "object", properties: { component_id: { type: "string" } }, required: ["component_id"] } },
    { name: "get_module_health_card", description: "Cross-references Vestigo and Protega to give a health check on a single module.", inputSchema: { type: "object", properties: { module_name: { type: "string" } }, required: ["module_name"] } },
    { name: "get_architecture_violations", description: "Retrieves active architectural policy violations (Protega).", inputSchema: { type: "object", properties: {} } },
    { name: "get_highest_risk_hotspots", description: "Returns the most risky modules in the codebase (Vestigo).", inputSchema: { type: "object", properties: { limit: { type: "number", default: 5 } } } },
    { name: "get_cloud_waste_report", description: "Retrieves underutilized cloud resources (Atlas).", inputSchema: { type: "object", properties: {} } },
    { name: "get_schema_migration_risk", description: "Analyzes proposed SQL migration risks (Voda).", inputSchema: { type: "object", properties: {} } },
    { name: "get_data_governance_violations", description: "Checks DB for security/PII violations (Vatra).", inputSchema: { type: "object", properties: {} } },
    { name: "get_pipeline_gate_status", description: "Checks if CI/CD is waiting on an external ticket (Custos).", inputSchema: { type: "object", properties: {} } },
    { name: "get_version_bump_justification", description: "Gets semantic code changes that caused the version bump (Insipio).", inputSchema: { type: "object", properties: {} } },
    { name: "get_release_manifest", description: "Gets associated Jira/ADO tickets for the release (Signet).", inputSchema: { type: "object", properties: {} } }
  ]
}));

// ==============================================================================
// 6. TOOLS EXECUTION
// ==============================================================================
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  try {
    switch (request.params.name) {
      
      // --- ADVANCED / MACRO TOOLS ---
      case "get_architecture_diagram": {
        const compId = request.params.arguments?.component_id as string;
        const data = await getArtifact("scrutari", "scrutari-data.json");
        if (data.error) return { content: [{ type: "text", text: JSON.stringify(data) }] };

        const target = data.components?.[compId];
        if (!target || !target.references?.length) return { content: [{ type: "text", text: "No dependencies found." }] };

        const clean = (s: string) => s.replace(/[^a-zA-Z0-9]/g, '_');
        const rootNode = clean(compId);
        let mermaid = `\`\`\`mermaid\ngraph TD\n    ${rootNode}["${target.name} (Target)"]:::targetNode\n`;

        for (const ref of target.references) {
          const refComp = data.components[ref] || { name: ref };
          const refNode = clean(ref);
          mermaid += `    ${refNode}["${refComp.name}"]\n    ${rootNode} --> ${refNode}\n`;
        }
        mermaid += `    classDef targetNode fill:#0288d1,stroke:#01579b,stroke-width:2px,color:#fff;\n\`\`\``;
        return { content: [{ type: "text", text: mermaid }] };
      }

      case "get_module_health_card": {
        const modName = (request.params.arguments?.module_name as string).toLowerCase();
        const vestigo = await getArtifact("vestigo", "vestigo-analysis.json");
        const protega = await getArtifact("protega", "protega-report.json");

        let score = "N/A", owner = "N/A";
        const areas = vestigo.currentState?.trackedAreas || [];
        const match = areas.find((a: any) => a.path?.toLowerCase().includes(modName));
        if (match) { score = match.riskScore; owner = match.ownership?.topContributor; }

        const violations = (protega.newViolations || []).filter((v: any) => 
          v.violatingFilePath?.toLowerCase().includes(modName)
        ).length;

        return { content: [{ type: "text", text: JSON.stringify({ module: modName, owner, riskScore: score, archViolations: violations }, null, 2) }] };
      }

      // --- STANDARD 3SC TOOLS ---
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

      case "get_cloud_waste_report": {
        const data = await getArtifact("atlas", "atlas-results.json");
        if (data.error) return { content: [{ type: "text", text: JSON.stringify(data) }] };

        return { content: [{ type: "text", text: JSON.stringify({ 
          lowUtilization: data.top10ByUtilization,
          highCapacity: data.top10ByProvisionedCapacity
        }, null, 2) }] };
      }

      case "get_schema_migration_risk": {
        const data = await getArtifact("voda", "voda-report.json");
        if (data.error) return { content: [{ type: "text", text: JSON.stringify(data) }] };
        
        return { content: [{ type: "text", text: JSON.stringify({ 
          risk: data.overallRiskLevel, 
          requiresDualApproval: data.requiresDualApproval,
          factors: (data.riskFactors || []).map((r:any) => ({name: r.name, description: r.description, objects: r.affectedObjects}))
        }, null, 2) }] };
      }

      case "get_data_governance_violations": {
        const data = await getArtifact("vatra", "vatra-report.json");
        if (data.error) return { content: [{ type: "text", text: JSON.stringify(data) }] };
        
        return { content: [{ type: "text", text: JSON.stringify({ 
          status: data.summary?.result, 
          highestSeverity: data.summary?.highestActiveSeverity,
          activeViolations: data.activeViolations 
        }, null, 2) }] };
      }

      case "get_pipeline_gate_status": {
        const data = await getArtifact("custos", "custos-decision-report.json");
        if (data.error) return { content: [{ type: "text", text: JSON.stringify(data) }] };
        
        return { content: [{ type: "text", text: JSON.stringify({ 
          action: data.data?.proposedAction, 
          condition: data.data?.initialEvaluation?.condition,
          passed: data.data?.initialEvaluation?.passed,
          steps: data.data?.initialEvaluation?.steps 
        }, null, 2) }] };
      }

      case "get_version_bump_justification": {
        const data = await getArtifact("insipio", "insipio-report.json");
        if (data.error) return { content: [{ type: "text", text: JSON.stringify(data) }] };
        
        return { content: [{ type: "text", text: JSON.stringify(data.versionCalculation || {}, null, 2) }] };
      }

      case "get_release_manifest": {
        // Signet might output as signet-report.json or release-artifact.json depending on your specific CI setup
        const data = await getArtifact("signet", "release-artifact.json");
        if (data.error) return { content: [{ type: "text", text: JSON.stringify(data) }] };
        
        return { content: [{ type: "text", text: JSON.stringify({ 
          version: data.releaseVersion, 
          workItems: data.workItems 
        }, null, 2) }] };
      }

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
