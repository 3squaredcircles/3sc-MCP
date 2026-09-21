# 3SC MCP Server

**Turn your CI/CD outputs into an interactive AI Principal Engineer.**

The **3SC MCP Server** bridges the [3SC Automated Governance Platform](https://www.3squaredcircles.com) with AI assistants (like Claude, Cursor, and Zed) using the open-source **Model Context Protocol (MCP)**. 

Instead of digging through CI logs and JSON artifacts, or firing up the self-contained UIs to figure out why a pipeline failed, what a schema migration will do, or where your technical debt lives, you can simply ask your AI assistant.

This server is provided **completely free** to users of the 3SC toolchain.

## What it Does

When you run 3SC tools in your CI/CD pipeline (or locally), they generate rich, deterministic JSON artifacts detailing the health, security, and cost of your application. This MCP Server exposes those artifacts directly to your local LLM, turning it into an architectural expert on your specific codebase.

### Supported 3SC Tools

The server exposes specialized tools and context for the entire 3SC ecosystem:

*   **Scrutari & Protega:** Explore the universal code graph and diagnose architectural policy violations.
*   **Vestigo:** Analyze code churn, bus-factor, and the exact "blast radius" of refactoring efforts.
*   **Voda & Vatra:** Evaluate the risk of SQL schema migrations and check the live database for data governance (PII/PHI) exposures.
*   **Atlas:** Identify expensive, underutilized cloud resources and tie them to infrastructure costs.
*   **Custos:** Check the status of API-driven pipeline gates (e.g., "Is the pipeline paused waiting for a Jira approval?").
*   **Insipio & Signet:** Generate rich release notes and understand exactly *why* a semantic version was bumped based on AST changes.

---

## Quick Start

The 3SC MCP Server requires **zero configuration** other than pointing it to your workspace output directory. It uses smart caching to ensure minimal CPU/Memory usage, only re-parsing artifacts when your CI pipeline updates them.

### Prerequisites
*   You have run one or more 3SC tools, and they have generated their artifacts into an `output/` directory (e.g., `output/vestigo/vestigo-analysis.json`).
*   You have an MCP-compatible client installed (e.g., [Claude Desktop](https://claude.ai/download), [Cursor](https://cursor.com)).

### Configuration: Claude Desktop

Add the 3SC MCP Server to your Claude Desktop configuration file. 

*   **Mac:** `~/Library/Application Support/Claude/claude_desktop_config.json`
*   **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`

You can run the server using either Node.js (`npx`) or Python (`uvx`). Choose the one you have installed on your machine.

#### Option A: Using Node.js (`npx`)
```json
{
  "mcpServers": {
    "3SC-Platform": {
      "command": "npx",
      "args": ["-y", "@3sc/mcp-server"],
      "env": {
        "3SC_WORKSPACE_PATH": "/absolute/path/to/your/repo/output"
      }
    }
  }
}
```
#### Option B: Using Python (uvx)
Requires uv to be installed.
```json
{
  "mcpServers": {
    "3SC-Platform": {
      "command": "uvx",
      "args": ["3sc-mcp-server"],
      "env": {
        "3SC_WORKSPACE_PATH": "/absolute/path/to/your/repo/output"
      }
    }
  }
}
```
**Note:** Replace /absolute/path/to/your/repo/output with the actual path on your machine where 3SC tools save their JSON artifacts.
Restart Claude Desktop, and you will see the 🛠️ icon indicating the 3SC tools are loaded!

#### Example Prompts
Once connected, try asking your AI assistant these questions:

**Architecture & Tech Debt**
- "I'm about to refactor the OrderService. Use Vestigo to tell me the blast radius of this module."
- "Did Protega catch any architecture violations in the latest build? If so, what file caused them?"
- "Use Scrutari to find the cyclomatic complexity of the UsersController."
  
**Data & Risk**
- "Look at the proposed Voda SQL migration. Is it flagged as risky? Does it drop any tables?"
- "Are there any active Vatra governance violations on our production database right now?"
  
**FinOps & Release**
- "Draft a short executive summary of our cloud waste using Atlas."
- "Why did Insipio bump our version to 2.0.0? Show me the breaking code changes."
- "Why is the deployment pipeline paused? Check Custos."
  
## How it Works (Under the Hood)
The server acts as a bridge. It does not send your source code to an LLM. Instead, it exposes localized Tools (functions) and Resources (read-only files) that the LLM can invoke.

When an LLM decides it needs to answer a question about architecture, it calls the MCP tool get_architecture_violations(). The local MCP server reads your local protega-report.json file, extracts the relevant data, and hands it back to the LLM to format into a human-readable response.

To ensure optimal performance, the server utilizes File-Modification Caching (st_mtime). If the LLM makes 10 requests for risk data, the 50MB JSON file is only read from your hard drive once, unless a new CI run has updated the file.
## Contributing
We welcome contributions! If you want to add new specific tools or prompts to the MCP server to better query the 3SC artifacts, please open a Pull Request.
1. Fork the repository
2. Create your feature branch (git checkout -b feature/AmazingTool)
3. Commit your changes (git commit -m 'Add some AmazingTool')
4. Push to the branch (git push origin feature/AmazingTool)
5. Open a Pull Request
## License
Distributed under the MIT License. See LICENSE for more information.
