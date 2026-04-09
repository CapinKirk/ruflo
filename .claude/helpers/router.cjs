#!/usr/bin/env node
/**
 * Claude Flow Agent Router
 * Routes tasks to optimal agents based on learned patterns.
 * Includes complexity detection for automatic swarm orchestration.
 */

const AGENT_CAPABILITIES = {
  coder: ['code-generation', 'refactoring', 'debugging', 'implementation'],
  tester: ['unit-testing', 'integration-testing', 'coverage', 'test-generation'],
  reviewer: ['code-review', 'security-audit', 'quality-check', 'best-practices'],
  researcher: ['web-search', 'documentation', 'analysis', 'summarization'],
  architect: ['system-design', 'architecture', 'patterns', 'scalability'],
  'backend-dev': ['api', 'database', 'server', 'authentication'],
  'frontend-dev': ['ui', 'react', 'css', 'components'],
  devops: ['ci-cd', 'docker', 'deployment', 'infrastructure'],
  'security-architect': ['threat-model', 'vulnerability', 'auth', 'encryption'],
  'performance-engineer': ['optimize', 'benchmark', 'profiling', 'latency'],
  'bq-query-analyst': ['bigquery', 'sql', 'schema', 'arr', 'acv', 'query'],
  'bq-pipeline-engineer': ['etl', 'scheduled-query', 'merge', 'sync', 'pipeline'],
  'bq-marketing-analyst': ['marketing', 'funnel', 'google-ads', 'cac', 'roas'],
  'sf-bq-sync-validator': ['sync-validation', 'data-integrity', 'reconciliation'],
  'revenue-analyst': ['arr', 'acv', 'churn', 'cohort', 'revenue', 'nrr'],
  'playwright-e2e-specialist': ['playwright', 'e2e', 'browser-testing', 'visual-regression'],
  'vercel-deploy-specialist': ['vercel', 'preview', 'edge-functions', 'deployment'],
};

// IMPORTANT: Order matters — specific patterns BEFORE generic ones.
// JS objects iterate in insertion order; first match wins.
const TASK_PATTERNS = {
  // Specialized agents (match first to avoid generic pattern capture)
  // Most-specific patterns first within each tier
  'playwright|e2e\\s*test|browser\\s*test|visual\\s*regression': 'playwright-e2e-specialist',
  'vercel|preview\\s*deploy|edge\\s*function|preview\\s*url': 'vercel-deploy-specialist',
  'sync\\s*valid|data\\s*integrity|reconcil|sync\\s*lag': 'sf-bq-sync-validator',
  'etl|data\\s*pipeline|merge\\s*statement|scheduled\\s*query|sfdc.*(to|into).*bq|bq.*(from|sync).*sfdc': 'bq-pipeline-engineer',
  'marketing\\s*funnel|google\\s*ads|\\bcac\\b|\\broas\\b|ad\\s*spend|campaign\\s*performance': 'bq-marketing-analyst',
  'revenue\\s+(retention|churn|cohort|model|forecast)|\\barr\\b.*cohort|\\bacv\\b.*calculat|net\\s*revenue|churn\\s*rate|nrr|proration': 'revenue-analyst',
  'bigquery|\\bbq\\b|big\\s*query|dataset|\\barr\\b.*bigquery|\\bacv\\b.*bigquery': 'bq-query-analyst',
  'threat|vulnerability|cve|injection|auth\\s*z': 'security-architect',
  'performance|optimize|benchmark|latency|throughput': 'performance-engineer',
  // Semi-specific agents (domain keywords that should win over generic verbs)
  'api|endpoint|server|backend|database|migrate|migration': 'backend-dev',
  'ui|frontend|component|react|css|style': 'frontend-dev',
  // Generic agents (catch-all verbs, match last)
  'implement|create|build|add|write code': 'coder',
  'test|spec|coverage|unit test|integration': 'tester',
  'review|audit|check|validate|security': 'reviewer',
  'research|find|search|documentation|explore': 'researcher',
  'design|architect|structure|plan': 'architect',
  'deploy|docker|ci|cd|pipeline|infrastructure': 'devops',
};

// Signals that indicate a task needs multiple agents (swarm-worthy)
const SWARM_INDICATORS = {
  // Multi-concern tasks — require TWO distinct action verbs separated by a conjunction.
  multiDomain: /\b(implement|test|review|deploy|fix|refactor|build|create|add|update|migrate|analyze|investigate|audit|optimize|revise|verify|configure|setup|set\s*up|assess|improve|scan|validate|overhaul|debug|diagnose|find|write|check|document|design|replace|remove|rewrite|upgrade|integrate|monitor|research|explore)\b.*\b(and|also|plus|then|additionally)\b.*\b(implement|test|review|deploy|fix|refactor|build|create|add|update|migrate|analyze|investigate|audit|optimize|revise|verify|configure|setup|set\s*up|assess|improve|scan|validate|overhaul|debug|diagnose|find|write|check|document|design|replace|remove|rewrite|upgrade|integrate|monitor|research|explore)\b/i,
  // Explicit multi-file or cross-cutting scope
  broadScope: /\b(across|all|every|entire|whole|multiple|several|codebase|project-wide|end.to.end|full.stack)\b/i,
  // Feature work (typically needs coder + tester + reviewer)
  featureWork: /\b(feature|new\s+feature|user\s+story|epic|milestone)\b/i,
  // Refactoring at scale — require scale qualifier, not just the verb alone
  refactorScale: /\b(refactor|restructure|rewrite|overhaul|modernize)\b.*\b(across|all|every|entire|whole|multiple|several|codebase|system|project|module|service)\b/i,
  // Bug investigation (needs researcher + coder + tester)
  bugInvestigation: /\b(root\s*cause|rca|investigate|dig\s+into|why\s+(is|are|does|do|isn't|aren't|not|no|won't|can't|didn't|hasn't|haven't|wasn't|weren't|this|these|certain|some|the|it)|identify\s+why|figure\s+out|understand\s+why|what.{0,20}(going\s+on|wrong|broken|happening)|debug|diagnose|troubleshoot)\b/i,
  // Security work (needs security-architect + coder + tester)
  securityWork: /\b(security\s+(audit|review|fix|overhaul)|vulnerability|penetration|hardening)\b/i,
  // Performance work (needs performance-engineer + coder + tester)
  perfWork: /\b(performance\s+(audit|review|fix|optimization)|benchmark|profiling|bottleneck)\b/i,
  // Architecture changes
  archChanges: /\b(architecture|system\s+design|bounded\s+context|domain\s+model|data\s+model)\b/i,
  // Release / deployment coordination — "release" only in deployment context
  releaseWork: /\b(cut\s+a?\s*release|ship\s+it|deploy\s+to\s+prod|go\s+live|launch\s+to|prepare\s+(the\s+)?release|release\s+(branch|candidate|v?\d))\b/i,
};

// Map swarm indicators to recommended agent compositions
const SWARM_COMPOSITIONS = {
  featureWork:      { agents: ['coder', 'tester', 'reviewer'], strategy: 'specialized', topology: 'hierarchical' },
  refactorScale:    { agents: ['coder', 'tester', 'reviewer', 'architect'], strategy: 'specialized', topology: 'hierarchical' },
  bugInvestigation: { agents: ['researcher', 'coder', 'tester'], strategy: 'specialized', topology: 'hierarchical' },
  securityWork:     { agents: ['security-architect', 'coder', 'tester', 'reviewer'], strategy: 'specialized', topology: 'hierarchical' },
  perfWork:         { agents: ['performance-engineer', 'coder', 'tester'], strategy: 'specialized', topology: 'hierarchical' },
  archChanges:      { agents: ['architect', 'coder', 'reviewer'], strategy: 'specialized', topology: 'hierarchical' },
  releaseWork:      { agents: ['devops', 'tester', 'reviewer'], strategy: 'specialized', topology: 'hierarchical' },
  multiDomain:      { agents: ['coder', 'tester', 'reviewer'], strategy: 'specialized', topology: 'hierarchical' },
  broadScope:       { agents: ['coder', 'tester', 'reviewer', 'architect'], strategy: 'specialized', topology: 'hierarchical' },
};

/**
 * Assess task complexity. Returns a score 0-1 and the matching indicators.
 */
function assessComplexity(task) {
  const matches = [];
  for (const [name, regex] of Object.entries(SWARM_INDICATORS)) {
    if (regex.test(task)) {
      matches.push(name);
    }
  }
  // Score: each indicator adds 0.25, capped at 1.0
  const score = Math.min(1.0, matches.length * 0.25);
  return { score, matches };
}

/**
 * Determine the swarm composition based on matched indicators.
 */
function getSwarmComposition(matches) {
  // Priority order: security > perf > arch > refactor > feature > bug > release > broad > multi
  const priority = ['securityWork', 'perfWork', 'archChanges', 'refactorScale',
    'featureWork', 'bugInvestigation', 'releaseWork', 'broadScope', 'multiDomain'];
  for (const key of priority) {
    if (matches.includes(key)) {
      return { trigger: key, ...SWARM_COMPOSITIONS[key] };
    }
  }
  return SWARM_COMPOSITIONS.multiDomain;
}

// Pre-compile regexes at module load (not per-call) for hook performance
const COMPILED_PATTERNS = Object.entries(TASK_PATTERNS).map(([pattern, agent]) => ({
  regex: new RegExp(pattern, 'i'),
  pattern,
  agent,
}));

function routeTask(task) {
  const taskLower = (task || '').toLowerCase();
  const complexity = assessComplexity(taskLower);

  // Find primary agent using pre-compiled regexes
  let primaryAgent = 'coder';
  let confidence = 0.5;
  let reason = 'Default routing - no specific pattern matched';

  for (const { regex, pattern, agent } of COMPILED_PATTERNS) {
    if (regex.test(taskLower)) {
      primaryAgent = agent;
      confidence = 0.8;
      reason = `Matched pattern: ${pattern}`;
      break;
    }
  }

  // Determine if swarm is needed (threshold: score >= 0.25, i.e. at least 1 strong indicator)
  const needsSwarm = complexity.score >= 0.25;
  const swarm = needsSwarm ? getSwarmComposition(complexity.matches) : null;

  return {
    agent: primaryAgent,
    confidence,
    reason,
    complexity: complexity.score,
    complexityIndicators: complexity.matches,
    needsSwarm,
    swarm,
  };
}

module.exports = { routeTask, assessComplexity, AGENT_CAPABILITIES, TASK_PATTERNS, SWARM_INDICATORS };

// CLI - only run when executed directly
if (require.main === module) {
  const task = process.argv.slice(2).join(' ');
  if (task) {
    const result = routeTask(task);
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log('Usage: router.js <task description>');
    console.log('\nAvailable agents:', Object.keys(AGENT_CAPABILITIES).join(', '));
  }
}
