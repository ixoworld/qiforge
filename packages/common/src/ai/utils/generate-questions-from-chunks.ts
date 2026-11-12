import { type Document } from 'langchain';
import { getOpenAiClient } from '../models/openai.js';

export const generateQuestionsFromChunks = async (
  content: string,
  chunks: Document[],
): Promise<QuestionGeneratorOutput['json_output']> => {
  const openai = getOpenAiClient();
  const response = await openai.chat.completions.parse({
    model: 'gpt-4o-mini',
    messages: [
      {
        role: 'system',
        content: [
          {
            type: 'text',
            text: '# SYSTEM — “Question Generator with Visible Chain-of-Thought”\n\nYou are an expert dataset-builder.  \nYour mission: turn raw knowledge into high-quality Q-A pairs for semantic search **while showing your reasoning**.\n\n---\n## INPUTS\n- **chunks** – array → `{ "id": string, "text": string }`  \n- **fullText** – the complete source document.\n\n---\n## TASK\nFor **each** chunk:\n\n1. **THINK (visible)**  \n   • Analyse the chunk’s content.  \n   • Note key facts, entities, dates, numbers, causal links, etc.  \n   • Decide which facts yield **Direct** vs **Derived** questions.  \n   • *Keep thoughts ≤ 120 words.*\n\n2. **GENERATE**  \n   • **Direct Q-A** – 1-3 questions whose full answer text appears **verbatim (or nearly so)** in the *same chunk*.  \n   • **Derived Q-A** – 1-2 questions that require light inference or synthesis; answers may use the chunk **or** *fullText*.  \n   • Ensure **at least two distinct sections** of the chunk are represented among the questions.\n\n---\n## OUTPUT FORMAT  \nReturn **one valid JSON object** that matches the schema below.  \nOutput **nothing** else.\n\n```json\n{\n  "thoughts": "<your chain-of-thought here>",\n  "json_output": [\n    {\n      "chunkId": "...",\n      "qas": [\n        { "type": "direct",  "question": "...?", "answer": "..." },\n        { "type": "derived", "question": "...?", "answer": "..." }\n        // …\n      ]\n    }\n    // …more chunks\n  ]\n}\n',
          },
        ],
      },
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: `## CHUNKS
          ${chunks
            .map((chunk) => {
              return `### CHUNK ${chunk.id}
            ${chunk.pageContent}`;
            })
            .join('\n')}
          ## FULL TEXT
          ${content}`,
          },
        ],
      },
    ],
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: 'question_generator_output',
        strict: true,
        schema: {
          type: 'object',
          properties: {
            thoughts: {
              type: 'string',
              description: 'Visible chain-of-thought reasoning.',
            },
            json_output: {
              type: 'array',
              description: 'Array of chunks with their generated Q&A pairs.',
              items: {
                type: 'object',
                properties: {
                  chunkId: {
                    type: 'string',
                    description: 'Identifier of the chunk.',
                  },
                  qas: {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: {
                        type: {
                          type: 'string',
                          enum: ['direct', 'derived'],
                          description:
                            'Question type: direct (verbatim) or derived (inference).',
                        },
                        question: {
                          type: 'string',
                          description: 'The question text.',
                        },
                        answer: {
                          type: 'string',
                          description: 'The answer text.',
                        },
                      },
                      required: ['type', 'question', 'answer'],
                      additionalProperties: false,
                    },
                  },
                },
                required: ['chunkId', 'qas'],
                additionalProperties: false,
              },
            },
          },
          required: ['thoughts', 'json_output'],
          additionalProperties: false,
        },
      },
    },
    temperature: 0,
    max_completion_tokens: 9957,
    top_p: 0.28,
    frequency_penalty: 0,
    presence_penalty: 0,
    store: false,
  });
  const json = response.choices[0]?.message.parsed as QuestionGeneratorOutput;
  return json.json_output;
};

type QuestionGeneratorOutput = {
  thoughts: string;
  json_output: {
    chunkId: string;
    qas: { type: string; question: string; answer: string }[];
  }[];
};
