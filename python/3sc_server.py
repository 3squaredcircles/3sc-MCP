import os
import json
import logging
import sys
import re
from pathlib import Path
from functools import lru_cache
from typing import Dict, Any
from mcp.server.fastmcp import FastMCP

# 1. SAFE LOGGING
logger = logging.getLogger("3sc-mcp")
logger.setLevel(logging.INFO)
handler = logging.StreamHandler(sys.stderr)
handler.setFormatter(logging.Formatter('%(asctime)s - %(levelname)s - %(message)s'))
logger.addHandler(handler)

WORKSPACE_DIR = Path(os.getenv("3SC_WORKSPACE_PATH", "./3sc-workspace-output")).resolve()
mcp = FastMCP("3SC-Platform-Server")

# 2. SMART CACHING
@lru_cache(maxsize=20)
def _load_json_from_disk(file_path: str, modified_time: float) -> Dict[str, Any]:
    try:
        with open(file_path, 'r', encoding='utf-8') as f:
            return json.load(f)
    except Exception as e:
        logger.error(f"Failed to parse JSON at {file_path}: {str(e)}")
        return {"error": f"Failed to parse artifact: {str(e)}"}

def get_artifact(tool_name: str, file_name: str) -> Dict[str, Any]:
    file_path = WORKSPACE_DIR / tool_name / file_name
    if not file_path.exists():
        return {"error": f"Artifact {file_name} not found in {tool_name} workspace."}
    try:
        return _load_json_from_disk(str(file_path), file_path.stat().st_mtime)
    except Exception as e:
        return {"error": f"IO Error: {str(e)}"}

# ==============================================================================
# PROMPTS (Prebaked UI Buttons in Claude/Cursor)
# ==============================================================================

@mcp.prompt()
def review_pr_risk() -> str:
    """Button: Generate a comprehensive PR Risk & Architecture Review"""
    return """
    You are an expert Principal Engineer. Please review the latest CI run artifacts to assess the risk of this Pull Request.
    1. Check `get_schema_migration_risk` (Voda) for data loss warnings.
    2. Check `get_highest_risk_hotspots` (Vestigo) to see if we are touching fragile code.
    3. Check `get_architecture_violations` (Protega) to see if we broke any design rules.
    4. Check `get_data_governance_violations` (Vatra) for any PII/PHI exposure.
    
    Synthesize this into a professional Markdown summary. Use emojis (✅, ⚠️, 🚨) to highlight status.
    """

@mcp.prompt()
def draft_release_notes() -> str:
    """Button: Draft Automated Release Notes"""
    return """
    Draft a professional release notes document for our stakeholders.
    1. Use `get_release_manifest` (Signet) to get the app version and the list of Jira/ADO Work Items.
    2. Use `get_version_bump_justification` (Insipio) to explain *why* the version number changed (e.g., list the breaking AST changes if it was a Major bump).
    Format as a beautiful Markdown changelog.
    """

@mcp.prompt()
def summarize_finops() -> str:
    """Button: Generate FinOps Cloud Waste Report"""
    return """
    Use `get_cloud_waste_report` (Atlas) to identify our most underutilized and expensive cloud resources. 
    Write a brief executive summary recommending where we can cut costs immediately.
    """

# ==============================================================================
# ADVANCED TOOLS
# ==============================================================================

@mcp.tool()
def get_architecture_diagram(component_id: str) -> str:
    """Generates a Mermaid.js visual dependency diagram for a specific component using Scrutari."""
    data = get_artifact("scrutari", "scrutari-data.json")
    if "error" in data: return json.dumps(data)

    components = data.get("components", {})
    if component_id not in components:
        return "Component not found."

    target = components[component_id]
    references = target.get("references", [])
    
    if not references:
        return "No outgoing dependencies found for this component."

    # Build Mermaid syntax
    clean_id = lambda s: re.sub(r'[^a-zA-Z0-9]', '_', s)
    mermaid = ["```mermaid", "graph TD"]
    
    root_node = clean_id(component_id)
    root_name = target.get('name', 'Unknown')
    mermaid.append(f'    {root_node}["{root_name} (Target)"]:::targetNode')

    for ref in references:
        ref_comp = components.get(ref, {})
        ref_node = clean_id(ref)
        ref_name = ref_comp.get('name', ref)
        mermaid.append(f'    {ref_node}["{ref_name}"]')
        mermaid.append(f'    {root_node} --> {ref_node}')

    mermaid.append("    classDef targetNode fill:#0288d1,stroke:#01579b,stroke-width:2px,color:#fff;")
    mermaid.append("```")
    
    return "\n".join(mermaid)

@mcp.tool()
def get_module_health_card(module_name: str) -> str:
    """MACRO TOOL: Cross-references Vestigo, Protega, and Scrutari to give a 360-degree health check on a single module."""
    vestigo = get_artifact("vestigo", "vestigo-analysis.json")
    protega = get_artifact("protega", "protega-report.json")
    
    # 1. Get Risk (Vestigo)
    risk_data = {"score": "N/A", "owner": "N/A"}
    for area in vestigo.get("currentState", {}).get("trackedAreas", []):
        if module_name.lower() in area.get("path", "").lower():
            risk_data["score"] = area.get("riskScore", "N/A")
            risk_data["owner"] = area.get("ownership", {}).get("topContributor", "N/A")
            break

    # 2. Get Arch Violations (Protega)
    violations = 0
    for v in protega.get("newViolations", []):
        if module_name.lower() in v.get("violatingFilePath", "").lower():
            violations += 1

    return json.dumps({
        "module": module_name,
        "primaryOwner": risk_data["owner"],
        "vestigoRiskScore": risk_data["score"],
        "activeArchitectureViolations": violations
    }, indent=2)

# ==============================================================================
# STANDARD TOOLS
# ==============================================================================
@mcp.tool()
def get_architecture_violations() -> str:
    """Retrieves all active architectural policy violations that are failing the build."""
    data = get_artifact("protega", "protega-report.json")
    if "error" in data: return json.dumps(data)
    violations = [{"rule": v.get("policyName"), "file": v.get("violatingFilePath"), "error": v.get("errorMessage")} for v in data.get("newViolations", [])]
    return json.dumps({"status": data.get("summary", {}).get("finalResult"), "violations": violations}, indent=2)

@mcp.tool()
def get_highest_risk_hotspots(limit: int = 5) -> str:
    """Returns the most risky modules in the codebase based on churn, bus-factor, and coupling."""
    data = get_artifact("vestigo", "vestigo-analysis.json")
    if "error" in data: return json.dumps(data)
    areas = data.get("currentState", {}).get("trackedAreas", [])
    try: areas.sort(key=lambda x: float(x.get("riskScore", 0)), reverse=True)
    except ValueError: pass
    hotspots = [{"path": a.get("path"), "score": a.get("riskScore"), "owner": a.get("ownership", {}).get("topContributor")} for a in areas[:limit]]
    return json.dumps(hotspots, indent=2)

@mcp.tool()
def get_schema_migration_risk() -> str:
    """Analyzes the proposed SQL schema migration for data loss or performance risks."""
    data = get_artifact("voda", "voda-report.json")
    if "error" in data: return json.dumps(data)
    return json.dumps({
        "risk": data.get("overallRiskLevel"),
        "requiresDualApproval": data.get("requiresDualApproval"),
        "factors": [{"name": r.get("name"), "objects": r.get("affectedObjects")} for r in data.get("riskFactors", [])]
    }, indent=2)

@mcp.tool()
def get_pipeline_gate_status() -> str:
    """Checks if the CI/CD pipeline is paused waiting for an external system."""
    data = get_artifact("custos", "custos-decision-report.json")
    if "error" in data: return json.dumps(data)
    gate_data = data.get("data", {})
    return json.dumps({
        "action": gate_data.get("proposedAction"),
        "passed": gate_data.get("initialEvaluation", {}).get("passed"),
        "steps": gate_data.get("initialEvaluation", {}).get("steps", [])
    }, indent=2)

@mcp.tool()
def get_data_governance_violations() -> str:
    """Checks the live database for data security violations like PII exposure (Vatra)."""
    data = get_artifact("vatra", "vatra-report.json")
    if "error" in data: return json.dumps(data)
    return json.dumps({"status": data.get("summary", {}).get("result"), "active": data.get("activeViolations", [])}, indent=2)

@mcp.tool()
def get_version_bump_justification() -> str:
    """Retrieves the semantic breaking changes that justified the application's version number (Insipio)."""
    data = get_artifact("insipio", "insipio-report.json")
    if "error" in data: return json.dumps(data)
    return json.dumps(data.get("versionCalculation", {}), indent=2)

@mcp.tool()
def get_release_manifest() -> str:
    """Gets associated Jira/ADO tickets for the release (Signet)."""
    data = get_artifact("signet", "release-artifact.json")
    if "error" in data: return json.dumps(data)
    return json.dumps({"version": data.get("releaseVersion"), "workItems": data.get("workItems", [])}, indent=2)

@mcp.tool()
def get_cloud_waste_report() -> str:
    """Retrieves the top underutilized cloud resources to identify cost-saving opportunities (Atlas)."""
    data = get_artifact("atlas", "atlas-results.json")
    if "error" in data: return json.dumps(data)
    return json.dumps({"low_utilization": data.get("top10ByUtilization", {})}, indent=2)

if __name__ == "__main__":
    logger.info(f"Starting 3SC MCP Server. Watching workspace: {WORKSPACE_DIR}")
    mcp.run()
