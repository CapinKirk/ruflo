declare module 'agentic-flow/core' {
  export function createAgent(config: any): any;
  export function createWorkflow(config: any): any;
  export function createFastAgentDB(config?: any): any;
  export function computeEmbedding(text: string, options?: any): Promise<Float32Array>;
  export class AgentRuntime {
    constructor(config?: any);
    start(): Promise<void>;
    stop(): Promise<void>;
  }
}
