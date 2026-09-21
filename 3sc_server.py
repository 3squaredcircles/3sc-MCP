import os
import json
import logging
import sys
from pathlib import Path
from functools import lru_cache
from typing import Dict, Any
from mcp.server.fastmcp import FastMCP

# 1. SAFE LOGGING (Must write to stderr so it doesn't break MCP stdout communication)
logger = logging.getLogger("3sc-mcp")
logger.setLevel(logging.INFO)
handler = logging.StreamHandler(sys.stderr)
handler.setFormatter(logging.Formatter('%(asctime)s - %(levelname)s - %(message)s'))
logger.addHandler(handler)

# 2. DYNAMIC CONFIGURATION
WORKSPACE_DIR = Path(os.getenv("3SC_WORKSPACE_PATH", "./3sc-workspace-output")).resolve()

# Initialize the MCP Server
mcp = FastMCP("3SC-Platform-Server")

# 3. SMART CACHING (Only reload JSON from disk if the file has been modified)
@lru_cache(maxsize=20)
def _load_json_from_disk(file_path: str, modified_time: float) -> Dict[str, Any]:
    """Cached loader. The modified_time argument forces a cache miss if the file changes."""
    logger.info(f"Cache miss: Loading artifact from disk -> {file_path}")
    try:
        with open(file_path, 'r', encoding='utf-8') as f:
            return json.load(f)
    except Exception as e:
        logger.error(f"Failed to parse JSON at {file_path}: {str(e)}")
        return {"error": f"Failed to parse artifact: {str(e)}"}

def get_artifact(tool_name: str, file_name: str) -> Dict[str, Any]:
    """Safely retrieves a 3SC artifact, utilizing the cache when possible."""
    file_path = WORKSPACE_DIR / tool_name / file_name
    
    if not file_path.exists():
        logger.warning(f"Artifact not found: {file_path}")
        return {"error": f"Artifact {file_name} not found in {tool_name} workspace."}
    
    try:
        # Get the last modified timestamp to use as our cache key
        mtime = file_path.stat().st_mtime
        return _load_json_from_disk(str(file_path), mtime)
    except Exception as e:
        logger.error(f"IO Error accessing {file_path}: {str(e)}")
        return {"error": "IO Error accessing artifact."}

# ==============================================================================
# TOOLS
# ==============================================================================

@mcp.tool()
def get_architecture_violations() -> str:
    """Retrieves all active architectural policy violations that are failing the build."""
    data = get_artifact("protega", "protega-report.json")
    if "error" in data: return json.dumps(data)
    
    violations = [
        {
            "rule": v.get("policyName"), 
            "file": v.get("violatingFilePath"), 
            "error": v.get("errorMessage")
        } 
        for v in data.get("newViolations", [])
    ]
    return json.dumps({"status": data.get("summary", {}).get("finalResult"), "violations": violations}, indent=2)

@mcp.tool()
def get_highest_risk_hotspots(limit: int = 5) -> str:
    """Returns the most risky modules in the codebase based on churn, bus-factor, and coupling."""
    data = get_artifact("vestigo", "vestigo-analysis.json")
    if "error" in data: return json.dumps(data)

    areas = data.get("currentState", {}).get("trackedAreas", [])
    
    # Safe sorting handling potential missing keys
    try:
        areas.sort(key=lambda x: float(x.get("riskScore", 0)), reverse=True)
    except ValueError:
        logger.error("Vestigo payload contained invalid risk scores.")
        
    hotspots = [
        {
            "path": a.get("path"), 
            "score": a.get("riskScore"), 
            "owner": a.get("ownership", {}).get("topContributor")
        } 
        for a in areas[:limit]
    ]
    return json.dumps(hotspots, indent=2)

@mcp.tool()
def get_schema_migration_risk() -> str:
    """Analyzes the proposed SQL schema migration for data loss or performance risks."""
    data = get_artifact("voda", "voda-report.json")
    if "error" in data: return json.dumps(data)
    
    return json.dumps({
        "overallRisk": data.get("overallRiskLevel"),
        "requiresDualApproval": data.get("requiresDualApproval"),
        "riskFactors": [
            {
                "name": r.get("name"), 
                "description": r.get("description"),
                "objects": r.get("affectedObjects")
            } 
            for r in data.get("riskFactors", [])
        ]
    }, indent=2)

@mcp.tool()
def get_pipeline_gate_status() -> str:
    """Checks if the CI/CD pipeline is paused waiting for an external system (e.g., Jira/ServiceNow)."""
    data = get_artifact("custos", "custos-decision-report.json")
    if "error" in data: return json.dumps(data)
    
    gate_data = data.get("data", {})
    evaluations = gate_data.get("initialEvaluation", {})
    
    return json.dumps({
        "proposedAction": gate_data.get("proposedAction"),
        "condition": evaluations.get("condition"),
        "passed": evaluations.get("passed"),
        "steps": evaluations.get("steps", [])
    }, indent=2)

if __name__ == "__main__":
    logger.info(f"Starting 3SC MCP Server. Watching workspace: {WORKSPACE_DIR}")
    # Run the server
    mcp.run()