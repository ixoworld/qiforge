/* eslint-disable no-console */
/**
 * Survey Helper Functions
 *
 * Utilities for parsing, validating, and working with SurveyJS survey schemas
 * and answers in domainCreator blocks.
 */

export interface SurveySchema {
  title?: string;
  description?: string;
  pages: SurveyPage[];
  showPageTitles?: boolean;
  showQuestionNumbers?: string;
  showProgressBar?: boolean;
  progressBarLocation?: string;
}

export interface SurveyPage {
  name?: string;
  title?: string;
  description?: string;
  visibleIf?: string;
  elements: SurveyElement[];
}

export interface SurveyElement {
  type: string;
  name: string;
  title?: string;
  description?: string;
  isRequired?: boolean;
  visibleIf?: string;
  defaultValue?: unknown;
  defaultValueExpression?: string;
  inputType?: string;
  choices?: Array<{ value: string; text: string }>;
  choicesByUrl?: {
    url: string;
    valueName: string;
    titleName: string;
  };
  templateElements?: SurveyElement[];
  elements?: SurveyElement[];
}

export interface SurveyQuestion {
  name: string;
  title: string;
  description?: string;
  type: string;
  inputType?: string;
  isRequired: boolean;
  isVisible?: boolean;
  visibleIf?: string;
  defaultValue?: unknown;
  choices?: Array<{ value: string; text: string }>;
  choicesByUrl?: {
    url: string;
    valueName: string;
    titleName: string;
  };
  pageName?: string;
  pageTitle?: string;
}

export interface ValidationError {
  field: string;
  message: string;
  type: 'required' | 'type' | 'choice' | 'format';
}

export interface ValidationWarning {
  field: string;
  message: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
  warnings: ValidationWarning[];
}

/**
 * Parse a JSON string survey schema into a structured object
 */
export function parseSurveySchema(schemaString: string): SurveySchema | null {
  try {
    if (!schemaString || typeof schemaString !== 'string') {
      return null;
    }
    const parsed = JSON.parse(schemaString);
    return parsed as SurveySchema;
  } catch (error) {
    console.error('Error parsing survey schema:', error);
    return null;
  }
}

/**
 * Parse a JSON string of answers into a structured object
 */
export function parseSurveyAnswers(
  answersString: string,
): Record<string, unknown> {
  try {
    if (!answersString || typeof answersString !== 'string') {
      return {};
    }
    const parsed = JSON.parse(answersString);
    return parsed as Record<string, unknown>;
  } catch (error) {
    console.error('Error parsing survey answers:', error);
    return {};
  }
}

/**
 * Evaluate a visibility condition against current answers
 * Simple evaluation for common patterns like {field} = value or {field} = true
 */
export function evaluateVisibilityCondition(
  condition: string | undefined,
  answers: Record<string, unknown>,
): boolean {
  if (!condition) {
    return true;
  }

  try {
    // Handle simple patterns like {field} = value or {field} = true
    const match = condition.match(/\{([^}]+)\}\s*=\s*(.+)/);
    if (match && match[1] !== undefined && match[2] !== undefined) {
      const fieldName = match[1].trim();
      const expectedValue = match[2].trim();
      const actualValue = answers[fieldName];

      // Handle boolean strings
      if (expectedValue === 'true') {
        return actualValue === true || actualValue === 'true';
      }
      if (expectedValue === 'false') {
        return actualValue === false || actualValue === 'false';
      }

      // Handle quoted strings
      if (
        (expectedValue.startsWith('"') && expectedValue.endsWith('"')) ||
        (expectedValue.startsWith("'") && expectedValue.endsWith("'"))
      ) {
        const unquoted = expectedValue.slice(1, -1);
        return String(actualValue) === unquoted;
      }

      // Direct comparison
      return String(actualValue) === expectedValue;
    }

    // Default to visible if we can't parse
    return true;
  } catch (error) {
    console.error('Error evaluating visibility condition:', error);
    return true;
  }
}

/**
 * Fetch choices from a URL
 */
async function fetchChoicesFromUrl(choicesByUrl: {
  url: string;
  valueName: string;
  titleName: string;
}): Promise<Array<{ value: string; text: string }> | null> {
  try {
    const response = await fetch(choicesByUrl.url, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      console.warn(
        `Failed to fetch choices from ${choicesByUrl.url}: ${response.statusText}`,
      );
      return null;
    }

    const data = await response.json();

    // Handle array response
    if (Array.isArray(data)) {
      return data.map((item) => ({
        value: String(item[choicesByUrl.valueName] ?? item.value ?? ''),
        text: String(
          item[choicesByUrl.titleName] ?? item.text ?? item.title ?? '',
        ),
      }));
    }

    // Handle object response
    if (typeof data === 'object' && data !== null) {
      // If the response has a data property that's an array
      if (Array.isArray(data.data)) {
        return data.data.map((item: Record<string, unknown>) => ({
          value: String(item[choicesByUrl.valueName] ?? item.value ?? ''),
          text: String(
            item[choicesByUrl.titleName] ?? item.text ?? item.title ?? '',
          ),
        }));
      }

      // If the response itself is an object with valueName and titleName properties
      if (data[choicesByUrl.valueName] !== undefined) {
        return [
          {
            value: String(data[choicesByUrl.valueName]),
            text: String(
              data[choicesByUrl.titleName] ?? data[choicesByUrl.valueName],
            ),
          },
        ];
      }
    }

    console.warn(`Unexpected response format from ${choicesByUrl.url}`);
    return null;
  } catch (error) {
    console.error(`Error fetching choices from ${choicesByUrl.url}:`, error);
    return null;
  }
}

/**
 * Extract all questions from a survey schema with metadata
 * Fetches choices from choicesByUrl if present
 * If answers are provided, computes visibility inline
 */
export async function extractSurveyQuestions(
  schema: SurveySchema,
  answers?: Record<string, unknown>,
): Promise<SurveyQuestion[]> {
  const questions: SurveyQuestion[] = [];

  if (!schema.pages || !Array.isArray(schema.pages)) {
    return questions;
  }

  async function extractFromElements(
    elements: SurveyElement[],
    pageName?: string,
    pageTitle?: string,
  ): Promise<void> {
    for (const element of elements) {
      // Skip elements without a name (they're not answerable)
      if (!element.name) {
        continue;
      }

      let choices = element.choices;

      // Fetch choices from URL if choicesByUrl is present
      if (element.choicesByUrl && !choices) {
        const fetchedChoices = await fetchChoicesFromUrl(element.choicesByUrl);
        if (fetchedChoices) {
          choices = fetchedChoices;
        }
      }

      const question: SurveyQuestion = {
        name: element.name,
        title: element.title || element.name,
        description: element.description,
        type: element.type,
        inputType: element.inputType,
        isRequired: element.isRequired === true,
        isVisible: answers
          ? evaluateVisibilityCondition(element.visibleIf, answers)
          : true, // Default to visible if no answers provided
        visibleIf: element.visibleIf,
        defaultValue: element.defaultValue,
        choices,
        choicesByUrl: element.choicesByUrl,
        pageName,
        pageTitle,
      };

      questions.push(question);

      // Handle nested elements (panels, paneldynamic)
      if (element.elements && Array.isArray(element.elements)) {
        await extractFromElements(element.elements, pageName, pageTitle);
      }

      // Handle template elements (paneldynamic)
      if (element.templateElements && Array.isArray(element.templateElements)) {
        await extractFromElements(
          element.templateElements,
          pageName,
          pageTitle,
        );
      }
    }
  }

  for (const page of schema.pages) {
    if (page.elements && Array.isArray(page.elements)) {
      await extractFromElements(
        page.elements,
        page.name,
        page.title || page.name,
      );
    }
  }

  return questions;
}

/**
 * Get all visible questions based on current answers
 */
export async function getVisibleQuestions(
  answers: Record<string, unknown>,
  schema: SurveySchema,
): Promise<SurveyQuestion[]> {
  const allQuestions = await extractSurveyQuestions(schema, answers);
  return allQuestions.filter((q) => q.isVisible !== false);
}

/**
 * Get missing required fields from answers
 */
export async function getMissingRequiredFields(
  answers: Record<string, unknown>,
  schema: SurveySchema,
): Promise<string[]> {
  const visibleQuestions = await getVisibleQuestions(answers, schema);
  const missing: string[] = [];

  for (const question of visibleQuestions) {
    if (question.isRequired) {
      const value = answers[question.name];
      if (
        value === undefined ||
        value === null ||
        value === '' ||
        (Array.isArray(value) && value.length === 0)
      ) {
        missing.push(question.name);
      }
    }
  }

  return missing;
}

/**
 * Validate a single answer value against a question
 * Returns errors for visible questions, warnings for hidden questions
 */
function validateAnswerValue(
  question: SurveyQuestion,
  value: unknown,
  options: { checkRequired: boolean; returnAsWarnings: boolean } = {
    checkRequired: true,
    returnAsWarnings: false,
  },
): ValidationError[] | ValidationWarning[] {
  const issues: (ValidationError | ValidationWarning)[] = [];

  // Check required (only if checkRequired is true)
  if (options.checkRequired && question.isRequired) {
    if (
      value === undefined ||
      value === null ||
      value === '' ||
      (Array.isArray(value) && value.length === 0)
    ) {
      if (options.returnAsWarnings) {
        issues.push({
          field: question.name,
          message: `${question.title || question.name} is required`,
        } as ValidationWarning);
      } else {
        issues.push({
          field: question.name,
          message: `${question.title || question.name} is required`,
          type: 'required',
        } as ValidationError);
      }
      return issues; // Don't check other validations if required is missing
    }
  }

  // Check type and format
  if (value !== undefined && value !== null && value !== '') {
    const addIssue = (message: string, type?: 'type' | 'choice' | 'format') => {
      if (options.returnAsWarnings) {
        issues.push({ field: question.name, message } as ValidationWarning);
      } else {
        issues.push({
          field: question.name,
          message,
          type: type || 'type',
        } as ValidationError);
      }
    };

    switch (question.type) {
      case 'boolean':
        if (
          typeof value !== 'boolean' &&
          value !== 'true' &&
          value !== 'false'
        ) {
          addIssue(
            `${question.title || question.name} must be a boolean`,
            'type',
          );
        }
        break;
      case 'text':
        if (typeof value !== 'string') {
          addIssue(
            `${question.title || question.name} must be a string`,
            'type',
          );
        }
        break;
      case 'dropdown':
        if (typeof value !== 'string') {
          addIssue(
            `${question.title || question.name} must be a string`,
            'type',
          );
        }
        // Check choices if available
        if (question.choices && Array.isArray(question.choices)) {
          const validValues = question.choices.map((c) => c.value);
          if (!validValues.includes(String(value))) {
            addIssue(
              `${question.title || question.name} must be one of: ${validValues.join(', ')}`,
              'choice',
            );
          }
        }
        break;
      case 'paneldynamic':
        if (!Array.isArray(value)) {
          addIssue(
            `${question.title || question.name} must be an array`,
            'type',
          );
        }
        break;
    }

    // Check input type formats
    if (question.inputType === 'email' && typeof value === 'string') {
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(value)) {
        addIssue(
          `${question.title || question.name} must be a valid email address`,
          'format',
        );
      }
    }

    if (question.inputType === 'url' && typeof value === 'string') {
      try {
        new URL(value);
      } catch {
        addIssue(
          `${question.title || question.name} must be a valid URL`,
          'format',
        );
      }
    }
  }

  return issues;
}

/**
 * Validate answers against schema requirements
 */
export async function validateAnswersAgainstSchema(
  answers: Record<string, unknown>,
  schema: SurveySchema,
): Promise<ValidationResult> {
  const errors: ValidationError[] = [];
  const warnings: ValidationWarning[] = [];

  const visibleQuestions = await getVisibleQuestions(answers, schema);
  const allQuestions = await extractSurveyQuestions(schema, answers);

  // Validate visible questions - return errors
  for (const question of visibleQuestions) {
    const value = answers[question.name];
    const questionErrors = validateAnswerValue(question, value, {
      checkRequired: true,
      returnAsWarnings: false,
    }) as ValidationError[];
    errors.push(...questionErrors);
  }

  // Validate hidden questions that have answers - return warnings (skip required check)
  const visibleQuestionNames = new Set(visibleQuestions.map((q) => q.name));
  for (const question of allQuestions) {
    if (!visibleQuestionNames.has(question.name)) {
      // This is a hidden question
      const value = answers[question.name];
      if (value !== undefined && value !== null && value !== '') {
        // Only validate if agent provided a value for hidden field
        const questionWarnings = validateAnswerValue(question, value, {
          checkRequired: false,
          returnAsWarnings: true,
        }) as ValidationWarning[];
        warnings.push(...questionWarnings);
      }
    }
  }

  // Check for answers that don't correspond to ANY question (visible or hidden)
  const allQuestionNames = new Set(allQuestions.map((q) => q.name));
  for (const answerKey of Object.keys(answers)) {
    if (!allQuestionNames.has(answerKey)) {
      warnings.push({
        field: answerKey,
        message: `Answer for "${answerKey}" does not correspond to any question in the schema`,
      });
    }
  }

  const result = {
    valid: errors.length === 0,
    errors,
    warnings,
  };
  console.log('validateAnswersAgainstSchema result:', result);
  return result;
}
