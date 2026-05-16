# Configs And Workspace

Kraken Coder 只面向 VS Code。配置文件使用 TOML，分全局配置和当前 VS Code workspace 配置两层。

## Paths

- Global root: `~/kraken-coder`
- Global config: `~/kraken-coder/config/config.toml`
- Global skills: `~/kraken-coder/skills`
- Workspace root: `<workspace>/kraken-coder`
- Workspace config: `<workspace>/kraken-coder/config/config.toml`
- Workspace skills: `<workspace>/.kraken-coder/skills`
- Workspace sessions: `<workspace>/.kraken-coder/sessions`
- Built-in skills: `<extension>/resources/skills`

`<workspace>` 是 VS Code 当前打开的第一个 workspace folder。

## Precedence

配置读取顺序：

1. `~/kraken-coder/config/config.toml`
2. `<workspace>/kraken-coder/config/config.toml`
3. VS Code settings
4. 环境变量和内置默认值

Workspace TOML 会覆盖全局 TOML。TOML 中已经设置的字段不会再被 VS Code settings 覆盖。

Skill 扫描目录：

1. `<workspace>/.kraken-coder/skills`
2. `<workspace>/kraken-coder/skill` (legacy)
3. `[skills].dir` 配置项，或 `KRAKEN_SKILLS_DIR`
4. `~/kraken-coder/skills`
5. `~/kraken-coder/skill` (legacy)
6. `<extension>/resources/skills`

同名 skill 以 workspace 目录为准。

## TOML Example

```toml
[model]
baseUrl = "https://api.openai.com/v1"
proxy = ""
name = "gpt-4.1"
apiKey = "sk-..."

[context]
maxChars = 60000

[agent]
autoApply = false
allowTerminal = false
allowFileWriteTool = false
allowBrowserTool = false
browserBin = "agent-browser"
browserMaxOutput = 50000
browserDefaultTimeout = 25000
maxSteps = 8
browserAllowedDomains = ["example.com", "docs.example.com"]

[skills]
dir = "~/kraken-coder/skills"

[lsp]
enabled = true
adapter = "auto"
languages = ["typescript", "go", "python"]
maxResults = 50
hoverMaxChars = 4000
timeoutMs = 8000

[memory]
enabled = true
autoRead = true
maxChars = 8000
allowWrite = false

[episodes]
enabled = true
autoCapture = true
autoRecall = true
maxRecalled = 3
maxChars = 12000
storeTranscript = true

[sessions]
enabled = true
```

字段也支持 snake_case，例如 `base_url`、`max_chars`、`auto_apply`。

## Notes

- `Kraken: Configure Model` 会打开配置页面，保存后写入全局 `~/kraken-coder/config/config.toml`。
- API key 保存在全局 `~/kraken-coder/config/config.toml` 的 `[model].apiKey`。
- `model.proxy` 为空时不走代理。
- LSP tools 默认开启，VS Code 中 `adapter = "auto"` 会使用 VS Code language providers；未来 CLI 中会使用独立 language server process adapter。
- LSP 首期只支持 TypeScript、Go、Python，对应工具包括 `lsp_hover`、`lsp_definition`、`lsp_references`、`lsp_document_symbols`、`lsp_workspace_symbols`。
- 新 skill 目录使用复数 `skills`；单数 `skill` 目录仅作为 legacy 兼容扫描。
- 目前不考虑额外沙箱；tools 按 VS Code workspace root 执行。
