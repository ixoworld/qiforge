# Reference: Skills Registry & Sandbox API

> **What this covers:** API endpoints for discovering skills and the sandbox tools your oracle uses to execute them.

---

## Skills Registry API

Base URL: `https://capsules.skills.ixo.earth`

The skills registry is a public catalog of all available skills. Your oracle uses it automatically when searching for skills, but you can also query it directly.

### List Skills

```
GET /capsules?limit=20&offset=0
```

| Parameter | Type   | Default | Description               |
| --------- | ------ | ------- | ------------------------- |
| `limit`   | number | 20      | Number of results (1–100) |
| `offset`  | number | 0       | Number of results to skip |

**Response:**

```json
{
  "capsules": [ ... ],
  "pagination": {
    "total": 42,
    "limit": 20,
    "offset": 0,
    "hasMore": true
  }
}
```

### Search Skills

```
GET /capsules/search?q=pptx&limit=10
```

| Parameter | Type   | Default | Description                  |
| --------- | ------ | ------- | ---------------------------- |
| `q`       | string | —       | Search query (required)      |
| `limit`   | number | 10      | Max results to return (1–50) |

**Response:**

```json
{
  "query": "pptx",
  "count": 3,
  "capsules": [ ... ]
}
```

### Capsule Object

Each skill (capsule) in the response has these fields:

| Field         | Type   | Description                           |
| ------------- | ------ | ------------------------------------- |
| `cid`         | string | Content ID — unique identifier (IPFS) |
| `name`        | string | Skill name (e.g., `pptx`, `invoice`)  |
| `description` | string | What the skill does                   |
| `license`     | string | License type (if set)                 |
| `archiveSize` | number | Download size in bytes                |
| `createdAt`   | string | ISO timestamp                         |

---

## Sandbox Tools

These are the tools your oracle uses behind the scenes to execute skills in a secure sandbox. You don't call these directly — your oracle handles it automatically. This reference is here so you understand what's happening when your oracle runs a skill.

### `load_skill(cid)`

Downloads a skill into the sandbox so it can be used.

- **Input:** `cid` — the Content ID from the skills registry
- **What it does:** Fetches the skill archive, extracts it to `/workspace/skills/<name>/`, and makes it read-only. After this, read or browse files with `sandbox_run` and plain shell (`cat`, `ls`, `grep`, `sed` against `/workspace/skills/<name>/...`).

### `sandbox_write(path, content)`

Writes a file to the sandbox workspace.

- **Input:** `path` (absolute, e.g., `/workspace/input.json`) + `content`
- **What it does:** Creates or overwrites the file at that path

### `exec(command)`

Runs a shell command in the sandbox.

- **Input:** `command` (e.g., `python3 /workspace/skills/pptx/scripts/create.py`)
- **What it does:** Executes the command and returns the output

### `artifact_get_presigned_url(path)`

Gets a temporary download URL for an output file.

- **Input:** `path` (must start with `/workspace/output/`, e.g., `/workspace/output/report.pdf`)
- **Returns:** `previewUrl`, `downloadUrl`, `path`, `expiresIn`

---

## Path Rules

| Path                  | Purpose                | Access     |
| --------------------- | ---------------------- | ---------- |
| `/workspace/uploads/` | User-uploaded files    | Read-only  |
| `/workspace/skills/`  | Downloaded skill files | Read-only  |
| `/workspace/`         | Working directory      | Read/Write |
| `/workspace/output/`  | Final deliverables     | Read/Write |

**Important:**

- Always use absolute paths (starting with `/`)
- Never write files inside `/workspace/skills/` — it's read-only
- Final output must go to `/workspace/output/` to be downloadable

---

## Environment Variables

| Variable          | Description                             |
| ----------------- | --------------------------------------- |
| `SANDBOX_MCP_URL` | URL of the sandbox MCP server           |
| `SANDBOX_API_KEY` | API key for authenticating with sandbox |

See [Environment Variables](./environment-variables.md) for the full list.
