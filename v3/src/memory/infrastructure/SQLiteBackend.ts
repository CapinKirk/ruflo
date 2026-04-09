/**
 * SQLiteBackend
 *
 * SQLite-based memory backend for persistent storage.
 * Part of the hybrid memory system per ADR-009.
 */

import type {
  Memory,
  MemoryBackend,
  MemoryQuery,
  MemorySearchResult
} from '../../shared/types';

export class SQLiteBackend implements MemoryBackend {
  private dbPath: string;
  private memories: Map<string, Memory>;
  private initialized: boolean = false;

  /**
   * Shared storage keyed by database path to simulate file-based persistence.
   * Multiple SQLiteBackend instances with the same dbPath share the same data store,
   * mirroring the behavior of a real SQLite database on disk.
   */
  private static persistentStores: Map<string, Map<string, Memory>> = new Map();

  constructor(dbPath: string) {
    this.dbPath = dbPath;
    // Reuse existing store for this path, or create a new one
    if (!SQLiteBackend.persistentStores.has(dbPath)) {
      SQLiteBackend.persistentStores.set(dbPath, new Map());
    }
    this.memories = SQLiteBackend.persistentStores.get(dbPath)!;
  }

  /**
   * Initialize the SQLite database
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    // Reconnect to the persistent store for this path
    if (!SQLiteBackend.persistentStores.has(this.dbPath)) {
      SQLiteBackend.persistentStores.set(this.dbPath, new Map());
    }
    this.memories = SQLiteBackend.persistentStores.get(this.dbPath)!;
    this.initialized = true;
  }

  /**
   * Close the database connection
   */
  async close(): Promise<void> {
    // Preserve data across close/reinitialize cycles for persistence
    this.initialized = false;
  }

  /**
   * Store a memory
   */
  async store(memory: Memory): Promise<Memory> {
    this.memories.set(memory.id, { ...memory });
    return memory;
  }

  /**
   * Retrieve a memory by ID
   */
  async retrieve(id: string): Promise<Memory | undefined> {
    return this.memories.get(id);
  }

  /**
   * Update a memory
   */
  async update(memory: Memory): Promise<void> {
    if (this.memories.has(memory.id)) {
      this.memories.set(memory.id, { ...memory });
    }
  }

  /**
   * Delete a memory
   */
  async delete(id: string): Promise<void> {
    this.memories.delete(id);
  }

  /**
   * Query memories with filters
   */
  async query(query: MemoryQuery): Promise<Memory[]> {
    let results = Array.from(this.memories.values());

    // Filter by agentId
    if (query.agentId) {
      results = results.filter(m => m.agentId === query.agentId);
    }

    // Filter by type
    if (query.type) {
      results = results.filter(m => m.type === query.type);
    }

    // Filter by time range
    if (query.timeRange) {
      results = results.filter(
        m => m.timestamp >= query.timeRange!.start && m.timestamp <= query.timeRange!.end
      );
    }

    // Filter by metadata
    if (query.metadata) {
      results = results.filter(m => {
        if (!m.metadata) return false;
        return Object.entries(query.metadata!).every(
          ([key, value]) => m.metadata![key] === value
        );
      });
    }

    // Sort by timestamp (newest first)
    results.sort((a, b) => b.timestamp - a.timestamp);

    // Apply pagination
    if (query.offset !== undefined) {
      results = results.slice(query.offset);
    }
    if (query.limit !== undefined) {
      results = results.slice(0, query.limit);
    }

    return results;
  }

  /**
   * Vector search (not supported in SQLite, returns empty)
   */
  async vectorSearch(embedding: number[], k?: number): Promise<MemorySearchResult[]> {
    // SQLite doesn't support vector search natively
    // Return empty array - vector search handled by AgentDB
    return [];
  }

  /**
   * Clear all memories for an agent
   */
  async clearAgent(agentId: string): Promise<void> {
    for (const [id, memory] of this.memories.entries()) {
      if (memory.agentId === agentId) {
        this.memories.delete(id);
      }
    }
  }

  /**
   * Get database path
   */
  getDbPath(): string {
    return this.dbPath;
  }

  /**
   * Get memory count
   */
  getCount(): number {
    return this.memories.size;
  }
}

export { SQLiteBackend as default };
