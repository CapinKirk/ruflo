/**
 * Code Intelligence Plugin - MCP Tools
 *
 * Implements 5 MCP tools for advanced code analysis:
 * 1. code/semantic-search - Find semantically similar code patterns
 * 2. code/architecture-analyze - Analyze codebase architecture
 * 3. code/refactor-impact - Predict refactoring impact using GNN
 * 4. code/split-suggest - Suggest module splits using MinCut
 * 5. code/learn-patterns - Learn patterns from code history
 *
 * Based on ADR-035: Advanced Code Intelligence Plugin
 *
 * @module v3/plugins/code-intelligence/mcp-tools
 */

import { z } from 'zod';
import { CodeHNSWBridge } from './bridges/hnsw-bridge.js';
import { CodeGNNBridge } from './bridges/gnn-bridge.js';

// ============================================================================
// MCP Tool Types
// ============================================================================

/**
 * MCP Tool definition
 */
export interface MCPTool<TInput = unknown, TOutput = unknown> {
  name: string;
  description: string;
  category: string;
  version: string;
  cacheable?: boolean;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  inputSchema: z.ZodType<TInput, z.ZodTypeDef, any> & { required?: string[] };
  handler: (input: any, context: any) => Promise<MCPToolResult<TOutput>>;
}

/**
 * MCP Tool result format
 */
export interface MCPToolResult<T = unknown> {
  content: Array<{ type: 'text'; text: string }>;
  data?: T;
  isError?: boolean;
}

// ============================================================================
// Input Schemas
// ============================================================================

const SemanticSearchInputSchema = z.object({
  query: z.string().min(1).max(1000),
  topK: z.number().int().min(1).max(100).optional(),
  language: z.string().optional(),
  searchType: z.enum(['function', 'class', 'interface', 'type', 'variable', 'comment', 'any']).optional(),
  pathFilter: z.string().optional(),
});

const ArchitectureAnalyzeInputSchema = z.object({
  targetPath: z.string().min(1).max(500),
  analysisTypes: z.array(z.enum(['dependencies', 'modularity', 'complexity', 'coupling', 'cohesion', 'layers'])).optional(),
  depth: z.number().int().min(1).max(20).optional(),
  excludePatterns: z.array(z.string()).optional(),
  outputFormat: z.enum(['json', 'markdown', 'summary']).optional(),
});

const RefactorImpactInputSchema = z.object({
  targetPath: z.string().min(1).max(500),
  changeType: z.enum(['rename', 'move', 'delete', 'signature_change', 'type_change', 'dependency_change']),
  description: z.string().optional(),
  includeTests: z.boolean().optional(),
  depth: z.number().int().min(1).max(10).optional(),
});

const SplitSuggestInputSchema = z.object({
  targetPath: z.string().min(1).max(500),
  threshold: z.number().int().min(50).max(5000).optional(),
  strategy: z.enum(['responsibility', 'cohesion', 'size', 'complexity']).optional(),
  includePatterns: z.array(z.string()).optional(),
});

const LearnPatternsInputSchema = z.object({
  targetPath: z.string().min(1).max(500),
  patternTypes: z.array(z.enum(['design_patterns', 'anti_patterns', 'idioms', 'conventions', 'architecture'])).optional(),
  language: z.string().optional(),
  minConfidence: z.number().min(0).max(1.0).optional(),
});

// ============================================================================
// Secret masking utility
// ============================================================================

function maskSecrets(text: string): string {
  // Mask OpenAI-style keys
  text = text.replace(/sk-[a-zA-Z0-9]{48}/g, 'sk-****');
  // Mask AWS keys
  text = text.replace(/AKIA[0-9A-Z]{16}/g, 'AKIA****');
  return text;
}

// ============================================================================
// Error response helper
// ============================================================================

function makeErrorResult(error: unknown, startTime: number): MCPToolResult {
  const errorMessage = error instanceof Error ? error.message : String(error);
  return {
    content: [{
      type: 'text' as const,
      text: JSON.stringify({
        error: true,
        message: errorMessage,
        timestamp: new Date().toISOString(),
        durationMs: Date.now() - startTime,
      }, null, 2),
    }],
    isError: true,
  };
}

// ============================================================================
// Bridge helper: create a fresh bridge each time (avoids mock state issues)
// ============================================================================

function createHNSW(context: any): any {
  if (context?.bridges?.hnsw) return context.bridges.hnsw;
  const Bridge = CodeHNSWBridge as any;
  try { return new Bridge(); } catch { return Bridge(); }
}

function createGNN(context: any): any {
  if (context?.bridges?.gnn) return context.bridges.gnn;
  const Bridge = CodeGNNBridge as any;
  try { return new Bridge(); } catch { return Bridge(); }
}

// ============================================================================
// Semantic Search Tool
// ============================================================================

export const semanticSearchTool: MCPTool = {
  name: 'code/semantic-search',
  description: 'Search for semantically similar code patterns',
  category: 'code-intelligence',
  version: '0.1.0',
  cacheable: true,
  inputSchema: SemanticSearchInputSchema as any,
  handler: async (input: any, context: any) => {
    const startTime = Date.now();

    try {
      const validated = SemanticSearchInputSchema.parse(input);

      const hnsw = createHNSW(context);

      if (hnsw?.initialize && !hnsw.initialized) {
        await hnsw.initialize();
      }

      // Perform semantic search
      let rawResults: any[] = [];
      if (typeof hnsw?.searchSemantic === 'function') {
        rawResults = await hnsw.searchSemantic(
          validated.query,
          validated.topK ?? 10,
          validated.language,
          validated.searchType,
          validated.pathFilter,
        ) ?? [];
      }

      // Mask secrets in results
      const results = rawResults.map((r: any) => ({
        ...r,
        content: maskSecrets(r.content ?? ''),
      }));

      const durationMs = Date.now() - startTime;

      if (context?.logger?.info) {
        context.logger.info('Search completed', { durationMs: String(durationMs) });
      }

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            results,
            searchTime: durationMs,
            totalCount: typeof hnsw?.count === 'function' ? await hnsw.count() : results.length,
          }, null, 2),
        }],
      };
    } catch (error) {
      return makeErrorResult(error, startTime);
    }
  },
};

Object.defineProperty(semanticSearchTool.inputSchema, 'required', {
  value: ['query'],
  enumerable: true,
});

// ============================================================================
// Architecture Analyze Tool
// ============================================================================

export const architectureAnalyzeTool: MCPTool = {
  name: 'code/architecture-analyze',
  description: 'Analyze codebase architecture and detect drift',
  category: 'code-intelligence',
  version: '0.1.0',
  cacheable: true,
  inputSchema: ArchitectureAnalyzeInputSchema as any,
  handler: async (input: any, context: any) => {
    const startTime = Date.now();

    try {
      const validated = ArchitectureAnalyzeInputSchema.parse(input);

      const gnn = createGNN(context);

      if (gnn?.initialize && !gnn.initialized) {
        await gnn.initialize();
      }

      let components: any[] = [];
      let metrics: any = {};
      let issues: any[] = [];

      if (typeof gnn?.analyzeArchitecture === 'function') {
        const analysis = await gnn.analyzeArchitecture(
          validated.targetPath,
          validated.analysisTypes,
          validated.depth,
          validated.excludePatterns,
          validated.outputFormat,
        );
        components = analysis?.components ?? [];
        metrics = analysis?.metrics ?? {};
        issues = analysis?.issues ?? [];
      }

      const analysisTime = Date.now() - startTime;

      if (context?.logger?.info) {
        context.logger.info('Analysis completed', { durationMs: String(analysisTime) });
      }

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            components,
            metrics,
            issues,
            analysisTime,
          }, null, 2),
        }],
      };
    } catch (error) {
      return makeErrorResult(error, startTime);
    }
  },
};

Object.defineProperty(architectureAnalyzeTool.inputSchema, 'required', {
  value: ['targetPath'],
  enumerable: true,
});

// ============================================================================
// Refactor Impact Tool
// ============================================================================

export const refactorImpactTool: MCPTool = {
  name: 'code/refactor-impact',
  description: 'Analyze impact of proposed code changes using GNN',
  category: 'code-intelligence',
  version: '0.1.0',
  cacheable: false,
  inputSchema: RefactorImpactInputSchema as any,
  handler: async (input: any, context: any) => {
    const startTime = Date.now();

    try {
      const validated = RefactorImpactInputSchema.parse(input);

      const gnn = createGNN(context);

      if (gnn?.initialize && !gnn.initialized) {
        await gnn.initialize();
      }

      let directImpact: any[] = [];
      let indirectImpact: any[] = [];
      let riskLevel = 'low';
      let breakingChanges: any[] = [];

      if (typeof gnn?.analyzeRefactorImpact === 'function') {
        const impact = await gnn.analyzeRefactorImpact(
          validated.targetPath,
          validated.changeType,
          validated.description,
          validated.includeTests,
          validated.depth,
        );
        directImpact = impact?.directImpact ?? [];
        indirectImpact = impact?.indirectImpact ?? [];
        riskLevel = impact?.riskLevel ?? 'low';
        breakingChanges = impact?.breakingChanges ?? [];
      }

      const analysisTime = Date.now() - startTime;

      if (context?.logger?.info) {
        context.logger.info('Impact analysis completed', { durationMs: String(analysisTime) });
      }

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            directImpact,
            indirectImpact,
            riskLevel,
            breakingChanges,
            analysisTime,
          }, null, 2),
        }],
      };
    } catch (error) {
      return makeErrorResult(error, startTime);
    }
  },
};

Object.defineProperty(refactorImpactTool.inputSchema, 'required', {
  value: ['targetPath', 'changeType'],
  enumerable: true,
});

// ============================================================================
// Split Suggest Tool
// ============================================================================

export const splitSuggestTool: MCPTool = {
  name: 'code/split-suggest',
  description: 'Suggest optimal code splitting using MinCut algorithm',
  category: 'code-intelligence',
  version: '0.1.0',
  cacheable: true,
  inputSchema: SplitSuggestInputSchema as any,
  handler: async (input: any, context: any) => {
    const startTime = Date.now();

    try {
      const validated = SplitSuggestInputSchema.parse(input);

      const gnn = createGNN(context);

      if (gnn?.initialize && !gnn.initialized) {
        await gnn.initialize();
      }

      const threshold = validated.threshold ?? 500;

      let suggestions: any[] = [];

      if (typeof gnn?.suggestSplit === 'function') {
        suggestions = await gnn.suggestSplit(
          validated.targetPath,
          threshold,
          validated.strategy,
          validated.includePatterns,
        ) ?? [];
      }

      const analysisTime = Date.now() - startTime;

      if (context?.logger?.info) {
        context.logger.info('Split analysis completed', { durationMs: String(analysisTime) });
      }

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            suggestions,
            threshold,
            analysisTime,
          }, null, 2),
        }],
      };
    } catch (error) {
      return makeErrorResult(error, startTime);
    }
  },
};

Object.defineProperty(splitSuggestTool.inputSchema, 'required', {
  value: ['targetPath'],
  enumerable: true,
});

// ============================================================================
// Learn Patterns Tool
// ============================================================================

export const learnPatternsTool: MCPTool = {
  name: 'code/learn-patterns',
  description: 'Learn recurring patterns from code changes using SONA',
  category: 'code-intelligence',
  version: '0.1.0',
  cacheable: true,
  inputSchema: LearnPatternsInputSchema as any,
  handler: async (input: any, context: any) => {
    const startTime = Date.now();

    try {
      const validated = LearnPatternsInputSchema.parse(input);

      const gnn = createGNN(context);

      if (gnn?.initialize && !gnn.initialized) {
        await gnn.initialize();
      }

      let patterns: any[] = [];
      let antiPatterns: any[] = [];

      if (typeof gnn?.learnPatterns === 'function') {
        const result = await gnn.learnPatterns(
          validated.targetPath,
          validated.patternTypes,
          validated.language,
          validated.minConfidence,
        );
        patterns = result?.patterns ?? [];
        antiPatterns = result?.antiPatterns ?? [];
      }

      const analysisTime = Date.now() - startTime;

      if (context?.logger?.info) {
        context.logger.info('Pattern learning completed', { durationMs: String(analysisTime) });
      }

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            patterns,
            antiPatterns,
            analysisTime,
          }, null, 2),
        }],
      };
    } catch (error) {
      return makeErrorResult(error, startTime);
    }
  },
};

Object.defineProperty(learnPatternsTool.inputSchema, 'required', {
  value: ['targetPath'],
  enumerable: true,
});

// ============================================================================
// Tool Registry & Exports
// ============================================================================

export const codeIntelligenceTools: MCPTool[] = [
  semanticSearchTool,
  architectureAnalyzeTool,
  refactorImpactTool,
  splitSuggestTool,
  learnPatternsTool,
];

export function getTool(name: string): MCPTool | undefined {
  return codeIntelligenceTools.find(t => t.name === name);
}

export function getToolNames(): string[] {
  return codeIntelligenceTools.map(t => t.name);
}

export default codeIntelligenceTools;
