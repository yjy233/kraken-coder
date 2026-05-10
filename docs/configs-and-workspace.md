# Configs And Workspace

Kraken Coder 只面向 VS Code。配置文件使用 TOML，分全局配置和当前 VS Code workspace 配置两层。

## Paths

- Global root: `~/kraken-coder`
- Global config: `~/kraken-coder/config/config.toml`
- Global skills: `~/kraken-coder/skill`
- Workspace root: `<workspace>/kraken-coder`
- Workspace config: `<workspace>/kraken-coder/config/config.toml`
- Workspace skills: `<workspace>/kraken-coder/skill`

`<workspace>` 是 VS Code 当前打开的第一个 workspace folder。

## Precedence

配置读取顺序：

1. `~/kraken-coder/config/config.toml`
2. `<workspace>/kraken-coder/config/config.toml`
3. VS Code settings
4. 环境变量和内置默认值

Workspace TOML 会覆盖全局 TOML。TOML 中已经设置的字段不会再被 VS Code settings 覆盖。

Skill 扫描目录：

1. `<workspace>/kraken-coder/skill`
2. `[skills].dir` 配置项，或 `KRAKEN_SKILLS_DIR`
3. `~/kraken-coder/skill`

同名 skill 以 workspace 目录为准。

## TOML Example

```toml
[model]
baseUrl = "https://api.openai.com/v1"
name = "gpt-4.1"

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
browserAllowedDomains = ["example.com", "docs.example.com"]

[skills]
dir = "~/kraken-coder/skill"
```

字段也支持 snake_case，例如 `base_url`、`max_chars`、`auto_apply`。

## Notes

- `Kraken: Configure Model` 会写入全局 `~/kraken-coder/config/config.toml`。
- API key 仍然保存在 VS Code SecretStorage，不写入 TOML。
- 目前不考虑额外沙箱；tools 按 VS Code workspace root 执行。
