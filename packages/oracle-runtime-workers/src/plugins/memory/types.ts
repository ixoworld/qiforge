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
