
<p align="center">
  <img
    width="256"
    height="256"
    alt="image"
    src="https://github.com/user-attachments/assets/f2093374-71cd-495f-9b58-0c3a39da5292"
  />
</p>

<h1 align="center">TABLEGRID</h1>


<div align="center">

![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-blue.svg)
![Contributor Covenant](https://img.shields.io/badge/Contributor%20Covenant-2.1-4baaaa.svg)
![Tauri](https://img.shields.io/badge/Tauri-v2-FFC131?logo=tauri&logoColor=black)
![Rust](https://img.shields.io/badge/Rust-2024_Edition-DEA584?logo=rust&logoColor=black)
![React](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=black)
![TypeScript](https://img.shields.io/badge/TypeScript-6.x-3178C6?logo=typescript&logoColor=white)

**A modern, blazingly fast, and elegant database management client & SQL editor for PostgreSQL, MySQL, MariaDB, SQLite, and Redis with built-in MCP Server & AI Copilot.**

<img width="2879" height="1799" alt="image" src="https://github.com/user-attachments/assets/2590e228-fd6a-4a85-8aec-9b8464dcb37c" />
</div>

---

**TABLEGRID** is a fast, cross-platform database workspace built with **Tauri v2 + Rust** and **React 19 + TypeScript**.

It combines database management, Redis tooling, SQL editing, AI assistance, migrations, monitoring, and security in one modern desktop app.

---

## ✨ Key Features

### 🗄️ Multi-Database & Redis

* PostgreSQL, MySQL, MariaDB, SQLite, and Redis.
* Redis key browser, CLI console, Streams, SlowLog, metrics, TTL editing, and DB switching.

### 🤖 Built-In MCP Server

* Expose database schema and safe read queries to AI clients such as Claude Desktop, Cursor, Windsurf, and Antigravity.
* Secure Bearer Token authentication and Origin/Host validation.

### 🧠 AI SQL Copilot

* Supports **Ollama, Gemini, OpenAI, Claude, and OpenRouter**.
* Schema-aware SQL generation with streaming responses and one-click execution.

### 📝 Monaco SQL Editor

* Schema-aware autocomplete.
* Query parameter detection.
* Split editor views.
* SQL Beautify & Minify.

### 📊 Visual EXPLAIN

* Interactive query plan flowcharts.
* Cost highlighting, Tree View, Raw View, and `EXPLAIN ANALYZE`.

### ⚡ Data Tools

* Virtualized data grid with inline editing, filtering, sorting, and pagination.
* Mock data generator.
* Database Compare & Sync.
* Schema migrations.
* Backup & Restore with `.sql.gz`.

### 🔒 Security & Transactions

* Read-Only Safe Mode.
* Transaction isolation controls.
* OS Keyring credential storage.
* SSH tunneling with pure-Rust `russh`.

### 🎨 Modern UI

* Liquid Glass-inspired Dark & Light themes.
* English & Vietnamese.
* Multi-connection DbRail with environment color tags.

---

**Database Client · Redis Browser · SQL IDE · AI Copilot · MCP Server · Query Analyzer · Migration Tool**

All in one fast, native desktop app.



---

## 🛠️ Tech Stack

| Layer | Technologies |
| :--- | :--- |
| **Desktop Shell** | [Tauri v2](https://v2.tauri.app/) (Rust) |
| **Backend Runtime** | [Tokio](https://tokio.rs/) · [SQLx](https://github.com/launchbadge/sqlx) · [Rusqlite](https://github.com/rusqlite/rusqlite) · [Redis-rs](https://github.com/redis-rs/redis-rs) |
| **Protocols & Security** | [rmcp (MCP SDK)](https://github.com/modelcontextprotocol) · [Axum](https://github.com/tokio-rs/axum) · [Russh](https://github.com/warp-tech/russh) · [Keyring-rs](https://github.com/hwchen/keyring-rs) |
| **Frontend Framework** | [React 19](https://react.dev/) · [TypeScript](https://www.typescriptlang.org/) · [Vite 8](https://vitejs.dev/) |
| **Editor & Terminal** | [Monaco Editor](https://microsoft.github.io/monaco-editor/) · [@xterm/xterm](https://xtermjs.org/) |
| **Styling & Icons** | Vanilla CSS (Liquid Glass Design Tokens) · [Lucide Icons](https://lucide.dev/) |
| **Testing & Linting** | [Vitest](https://vitest.dev/) · [Oxlint](https://oxc.rs/) |

---

## 🚀 Getting Started

### Prerequisites
- **Node.js**: `>= 18.x`
- **Rust**: `>= 1.75` (Rust 2024 Edition)
- **Package Manager**: `npm`, `pnpm`, or `yarn`

### Installation & Development

1. **Clone the repository**:
   ```bash
   git clone https://github.com/Phamthang1997/tablegrid.git
   cd tablegrid
   ```

2. **Install frontend dependencies**:
   ```bash
   npm install
   ```

3. **Start in Development Mode**:
   ```bash
   npm run dev
   ```

4. **Run Unit Tests & Linting**:
   ```bash
   npm test          # Run Vitest test suites
   npx oxlint src    # Run Oxlint code analysis
   ```

5. **Build Desktop App for Production**:
   ```bash
   npm run build     # Compile frontend bundle & build native desktop executable
   ```

### ⚠️ macOS Gatekeeper Troubleshooting ("App is damaged and can't be opened")
If you download a `.dmg` release built from GitHub Actions, macOS Gatekeeper may block unsigned binaries downloaded via web browsers. To resolve this:
1. Drag `TableGrid.app` into your `/Applications` folder.
2. Open Terminal and run:
   ```bash
   sudo xattr -rd com.apple.quarantine /Applications/TableGrid.app
   ```

---

## 📁 Project Structure

```text
table/
├── src/                          # Frontend Source Code (React 19 + TypeScript)
│   ├── components/               # UI Components
│   │   ├── ai/                   # AI Assistant & Chatbot Panels
│   │   ├── redis/                # Redis Key Browser, Stream, Console & SlowLog
│   │   ├── ConnectionManager.tsx # Database Connections & Credential Dialogs
│   │   ├── DataGrid.tsx          # Virtualized Data Grid Table & In-cell Editor
│   │   ├── SqlEditor.tsx         # Monaco Editor SQL Workspace & Split Panes
│   │   ├── ExplainViewer.tsx     # Visual EXPLAIN Flowchart & Plan Analyzer
│   │   ├── DbRail.tsx            # Multi-Connection Sidebar Switcher Rail
│   │   ├── TxControl.tsx         # Transaction Isolation & Safety Toolbar
│   │   └── TerminalPanel.tsx     # Embedded Local & Remote SSH Terminal
│   ├── sql/                      # Monaco SQL Language Service & Result Formatters
│   ├── utils/                    # Tauri IPC Bridge & Helper Utilities
│   ├── i18n/                     # Internationalization (EN / VI Locales)
│   ├── App.tsx                   # Main Workspace Container Component
│   └── index.css                 # Liquid Glass Design System Tokens
├── src-tauri/                    # Backend Source Code (Rust + Tauri v2)
│   ├── src/
│   │   ├── app/                  # Tauri Handlers Registration & Run Entry
│   │   ├── database/             # PostgreSQL / MySQL / SQLite Drivers & Catalog
│   │   ├── redis_db/             # Redis Connection Session & Command Engine
│   │   ├── mcp/                  # Built-in Streamable HTTP MCP Server & Security
│   │   ├── state/                # Connection Pool Registry & App State
│   │   ├── ssh/                  # Russh Secure Port Forwarding Tunnel
│   │   ├── terminal/             # Local PTY & SSH Remote Shell Streamer
│   │   ├── credentials/          # OS Keyring Secure Storage
│   │   ├── datagen/              # Schema-Aware Mock Data Generator
│   │   ├── compare/              # Database Schema & Data Comparison
│   │   ├── stats/                # Database Server Performance Statistics
│   │   └── tx/                   # Transaction Isolation & Safe Mode Handlers
│   ├── Cargo.toml                # Rust Dependencies Manifest
│   └── tauri.conf.json           # Tauri Desktop Configuration
├── package.json
└── README.md
```

---

## 📄 License & Code of Conduct

- **Author & Creator**: **Pham Thang**
  - 📧 **Email**: [pthang888@gmail.com](mailto:pthang888@gmail.com)
  - 💼 **LinkedIn**: [thangpx](https://www.linkedin.com/in/thangpx/)
- **Copyright**: © 2026 Pham Thang and TableGrid Contributors
- **License**: Released under the [GNU Affero General Public License v3.0 (AGPL-3.0)](LICENSE).
- **Code of Conduct**: Please follow our [Contributor Covenant Code of Conduct](CODE_OF_CONDUCT.md).
