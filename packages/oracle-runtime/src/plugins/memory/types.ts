// ─── Shared primitives ────────────────────────────────────────────────────────

export type ComparisonOperator =
  | '='
  | '<>'
  | '>'
  | '<'
  | '>='
  | '<='
  | 'IS NULL'
  | 'IS NOT NULL';

/** A single date filter condition. `date` can be omitted for IS NULL / IS NOT NULL. */
export interface DateFilter {
  date?: string; // ISO-8601 datetime string, e.g. "2025-01-01T00:00:00Z"
  comparison_operator: ComparisonOperator;
}

/**
 * Date filters are passed as groups of OR-conditions combined with AND between groups:
 *   [[a, b], [c]]  →  (a OR b) AND (c)
 */
export type DateFilterGroups = DateFilter[][];

export type SearchStrategy =
  | 'balanced'
  | 'diverse'
  | 'precise'
  | 'contextual'
  | 'recent_memory'
  | 'facts_only'
  | 'entities_only'
  | 'topics_only';

export type KnowledgeLevel = 'user' | 'oracle' | 'both';

export type EntityType =
  // Personal Identity
  | 'Person'
  | 'Trait'
  | 'Value'
  | 'Identity'
  | 'Attribute'
  // Mental & Emotional
  | 'Emotion'
  | 'Stress'
  | 'CopingStrategy'
  // Professional & Work
  | 'Job'
  | 'Project'
  | 'Skill'
  | 'Tool'
  | 'Organization'
  // Goals & Growth
  | 'Goal'
  | 'Milestone'
  // Behaviors & Patterns
  | 'Habit'
  | 'Routine'
  | 'Pattern'
  // Interests & Entertainment
  | 'Interest'
  | 'Hobby'
  | 'Content'
  // Preferences
  | 'Preference'
  | 'Product'
  // Knowledge & Learning
  | 'Expertise'
  | 'LearningGoal'
  | 'Resource'
  // Places & Experiences
  | 'Location'
  | 'Experience'
  | 'Event'
  // Social & Groups
  | 'Group'
  | 'Pet'
  // Communication
  | 'CommunicationStyle'
  | 'Language'
  // Tasks & Beliefs
  | 'Task'
  | 'Belief'
  | 'Cause'
  // Instructions
  | 'Procedure'
  // IXO/Qi Ontology
  | 'Agent'
  | 'SmartAccount'
  | 'OutcomeUnit'
  | 'Claim'
  | 'Evaluation'
  | 'ServiceEvent'
  | 'Payment'
  | 'VerifiableCredential';

export type EdgeType =
  // Personal Memory
  | 'Knows'
  | 'WorksWith'
  | 'Causes'
  | 'Enables'
  | 'Blocks'
  | 'PartOf'
  | 'BelongsTo'
  | 'Practices'
  | 'Uses'
  | 'Pursuing'
  | 'Requires'
  | 'Achieved'
  | 'EmployedAt'
  | 'WorksOn'
  | 'Manages'
  | 'LivesAt'
  | 'VisitedLocation'
  | 'LocatedIn'
  | 'Prefers'
  | 'Likes'
  | 'Dislikes'
  | 'InterestedIn'
  | 'ExpertiseIn'
  | 'Studying'
  | 'LearnedFrom'
  | 'Triggers'
  | 'Motivates'
  | 'ManagesVia'
  | 'Influences'
  | 'Supports'
  | 'MemberOf'
  | 'Owns'
  | 'CurrentlyIs'
  | 'WasPreviously'
  | 'AlignedWith'
  | 'ConflictsWith'
  | 'RelatesTo'
  // IXO/Qi Ontology
  | 'OWNS'
  | 'CONTROLS'
  | 'SUBMITS_CLAIM'
  | 'HAS_EVALUATION'
  | 'RESULTS_IN_OUTCOME'
  | 'TRIGGERS_PAYMENT'
  | 'PAYS_FOR_SERVICE'
  | 'HAS_IDENTITY';

// ─── Tool input types ─────────────────────────────────────────────────────────

/** memory-engine__search_memory_engine */
export interface SearchMemoryInput {
  query: string;
  strategy: SearchStrategy;
  /** @default 'both' */
  knowledge_level?: KnowledgeLevel;
  /** UUID of a node to use as the graph traversal center */
  center_node_uuid?: string;
  node_labels?: EntityType[];
  edge_types?: EdgeType[];
  /** Filter on the edge/node valid_at timestamp */
  valid_at?: DateFilterGroups;
  /** Filter on the edge/node invalid_at timestamp */
  invalid_at?: DateFilterGroups;
  /** Filter on the edge/node created_at timestamp */
  created_at?: DateFilterGroups;
  /** Filter on the edge/node expired_at timestamp */
  expired_at?: DateFilterGroups;
}

/** memory-engine__add_memory */
export interface AddMemoryInput {
  /** Short label / title for the memory */
  name: string;
  /** The actual content/text to store */
  content: string;
  /** @default 'text' */
  source?: string;
  /** @default '' */
  source_description?: string;
}

/** memory-engine__add_oracle_knowledge */
export interface AddOracleKnowledgeInput {
  name: string;
  content: string;
  /** Must be true — agent must get explicit user confirmation before calling */
  confirmed_insertion_from_user: boolean;
  knowledge_space_type: 'public' | 'private';
  /** @default 'text' */
  source?: string;
  /** @default '' */
  source_description?: string;
}

/** memory-engine__delete_episode */
export interface DeleteEpisodeInput {
  episode_uuid: string;
  /** Must be true — agent must get explicit user confirmation before calling */
  confirmed_deletion_from_user: boolean;
}

/** memory-engine__delete_edge */
export interface DeleteEdgeInput {
  edge_uuid: string;
  /** Must be true — agent must get explicit user confirmation before calling */
  confirmed_deletion_from_user: boolean;
}

/** memory-engine__clear */
export interface ClearMemorySpaceInput {
  /** Must be true — agent must get explicit user confirmation before calling */
  confirmed_deletion_from_user: boolean;
}
