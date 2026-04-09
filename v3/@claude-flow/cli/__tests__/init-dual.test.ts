import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommandContext } from '../src/types.js';

const executeInitMock = vi.fn();
const codexInitializeMock = vi.fn();

const minimalOptions = {
  targetDir: '/tmp/project',
  force: false,
  interactive: false,
  components: {
    settings: true,
    skills: true,
    commands: false,
    agents: false,
    helpers: false,
    statusline: false,
    mcp: true,
    runtime: true,
    claudeMd: true,
  },
  hooks: {
    preToolUse: true,
    postToolUse: true,
    userPromptSubmit: false,
    sessionStart: true,
    stop: false,
    preCompact: true,
    notification: false,
    teammateIdle: false,
    taskCompleted: false,
    timeout: 5000,
    continueOnError: true,
  },
  skills: {
    core: true,
    agentdb: false,
    github: false,
    flowNexus: false,
    browser: false,
    v3: false,
    dualMode: false,
    all: false,
  },
  commands: {
    core: true,
    analysis: false,
    automation: false,
    github: false,
    hooks: false,
    monitoring: false,
    optimization: false,
    sparc: false,
    all: false,
  },
  agents: {
    core: true,
    consensus: false,
    github: false,
    hiveMind: false,
    sparc: false,
    swarm: false,
    browser: false,
    v3: false,
    optimization: false,
    testing: false,
    dualMode: false,
    all: false,
  },
  statusline: {
    enabled: false,
    showProgress: false,
    showSecurity: false,
    showSwarm: false,
    showHooks: false,
    showPerformance: false,
    refreshInterval: 5000,
  },
  mcp: {
    claudeFlow: true,
    ruvSwarm: false,
    flowNexus: false,
    autoStart: false,
    port: 3000,
  },
  runtime: {
    topology: 'mesh' as const,
    maxAgents: 5,
    memoryBackend: 'memory' as const,
    enableHNSW: false,
    enableNeural: false,
    enableLearningBridge: false,
    enableMemoryGraph: false,
    enableAgentScopes: false,
  },
  embeddings: {
    enabled: false,
    model: 'Xenova/all-MiniLM-L6-v2',
    hyperbolic: false,
    curvature: -1,
    predownload: false,
    cacheSize: 128,
    neuralSubstrate: false,
  },
};

vi.mock('fs', () => ({
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(() => JSON.stringify({ name: '@claude-flow/cli' })),
}));

vi.mock('../src/output.js', () => ({
  output: {
    writeln: vi.fn(),
    printInfo: vi.fn(),
    printSuccess: vi.fn(),
    printError: vi.fn(),
    printWarning: vi.fn(),
    printList: vi.fn(),
    printBox: vi.fn(),
    highlight: (value: string) => value,
    bold: (value: string) => value,
    createSpinner: vi.fn(() => ({
      start: vi.fn(),
      succeed: vi.fn(),
      fail: vi.fn(),
    })),
  },
}));

vi.mock('../src/prompt.js', () => ({
  confirm: vi.fn(),
  select: vi.fn(),
  multiSelect: vi.fn(),
  input: vi.fn(),
}));

vi.mock('../src/init/index.js', () => ({
  executeInit: executeInitMock,
  executeUpgrade: vi.fn(),
  executeUpgradeWithMissing: vi.fn(),
  DEFAULT_INIT_OPTIONS: minimalOptions,
  MINIMAL_INIT_OPTIONS: minimalOptions,
  FULL_INIT_OPTIONS: {
    ...minimalOptions,
    skills: { ...minimalOptions.skills, dualMode: true, all: true },
    agents: { ...minimalOptions.agents, dualMode: true, all: true },
  },
}));

vi.mock('@claude-flow/codex', () => ({
  CodexInitializer: class {
    async initialize(options: Record<string, unknown>) {
      codexInitializeMock(options);
      return {
        success: true,
        filesCreated: ['AGENTS.md', '.agents/config.toml'],
        skillsGenerated: ['swarm-orchestration'],
        warnings: [],
      };
    }
  },
}));

describe('init --dual', () => {
  let ctx: CommandContext;

  beforeEach(() => {
    vi.clearAllMocks();
    executeInitMock.mockResolvedValue({
      success: true,
      platform: {
        os: 'linux',
        arch: 'x64',
        nodeVersion: 'v20.0.0',
        shell: 'bash',
        homeDir: '/tmp',
        configDir: '/tmp/.config',
      },
      created: {
        directories: ['.claude', '.claude-flow'],
        files: ['.claude/settings.json', '.mcp.json'],
      },
      skipped: [],
      errors: [],
      summary: {
        skillsCount: 1,
        commandsCount: 0,
        agentsCount: 0,
        hooksEnabled: 1,
      },
    });

    ctx = {
      args: [],
      flags: { dual: true, minimal: true, _: [] },
      cwd: '/test/project',
      interactive: false,
    };
  });

  it('creates both Codex and Claude assets when dual mode is requested', async () => {
    const { initCommand } = await import('../src/commands/init.js');

    const result = await initCommand.action!(ctx);

    expect(result.success).toBe(true);
    expect(codexInitializeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        projectPath: '/test/project',
        template: 'minimal',
        dual: true,
      })
    );
    expect(executeInitMock).toHaveBeenCalledWith(
      expect.objectContaining({
        targetDir: '/test/project',
        force: false,
        interactive: false,
        components: expect.objectContaining({
          claudeMd: false,
        }),
        skills: expect.objectContaining({
          dualMode: true,
        }),
        agents: expect.objectContaining({
          dualMode: true,
        }),
      })
    );
  });

  it('does not run Claude initialization in Codex-only mode', async () => {
    const { initCommand } = await import('../src/commands/init.js');
    ctx.flags = { codex: true, _: [] };

    const result = await initCommand.action!(ctx);

    expect(result.success).toBe(true);
    expect(codexInitializeMock).toHaveBeenCalled();
    expect(executeInitMock).not.toHaveBeenCalled();
  });
});
