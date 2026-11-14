/**
 * ═══════════════════════════════════════════════════════════════
 *  OSIRIS — Gemini Provider
 *  Adapts @google/generative-ai to the harness Provider seam.
 * ═══════════════════════════════════════════════════════════════
 */

import {
  GoogleGenerativeAI,
  SchemaType,
  type Content,
  type FunctionDeclaration,
  type GenerateContentResult,
  type Part,
  type Schema,
} from '@google/generative-ai';
import { ProviderError } from '../errors';
import type {
  FinishReason,
  LlmMessage,
  Provider,
  ProviderRequest,
  ProviderResponse,
  SchemaNode,
  ToolCall,
  Usage,
} from '../types';

export interface GeminiProviderOptions {
  apiKey: string;
  model?: string;
}

export class GeminiProvider implements Provider {
  readonly name = 'gemini';
  readonly model: string;
  private readonly client: GoogleGenerativeAI;

  constructor(options: GeminiProviderOptions) {
    if (!options.apiKey) throw new ProviderError('Gemini API key is required.', { retryable: false });
    this.client = new GoogleGenerativeAI(options.apiKey);
    this.model = options.model ?? 'gemini-2.0-flash';
  }

  async generate(request: ProviderRequest, signal: AbortSignal): Promise<ProviderResponse> {
    const model = this.client.getGenerativeModel({
      model: this.model,
      systemInstruction: request.system,
      tools:
        request.tools && request.tools.length > 0
          ? [{ functionDeclarations: request.tools.map(toFunctionDeclaration) }]
          : undefined,
      generationConfig: {
        temperature: request.temperature,
        maxOutputTokens: request.maxOutputTokens,
      },
    });

    let result: GenerateContentResult;
    try {
      result = await model.generateContent(
        { contents: request.messages.map(toContent) },
        { signal },
      );
    } catch (error) {
      throw toProviderError(error);
    }

    const response = result.response;
    const candidate = response.candidates?.[0];
    const parts: Part[] = candidate?.content?.parts ?? [];

    const toolCalls: ToolCall[] = [];
    let text = '';
    parts.forEach((part, index) => {
      if (typeof part.text === 'string') text += part.text;
      if (part.functionCall) {
        toolCalls.push({
          // Gemini does not mint call ids; the harness needs one to correlate results.
          id: `gemini_${index}_${part.functionCall.name}`,
          name: part.functionCall.name,
          arguments: (part.functionCall.args ?? {}) as Record<string, unknown>,
        });
      }
    });

    const usage: Usage = {
      inputTokens: response.usageMetadata?.promptTokenCount ?? 0,
      outputTokens: response.usageMetadata?.candidatesTokenCount ?? 0,
    };

    return {
      text,
      toolCalls,
      usage,
      finishReason: toFinishReason(candidate?.finishReason, toolCalls.length > 0),
    };
  }
}

/* ─────────────────────────────────────────────────────────────
   Translation
   ───────────────────────────────────────────────────────────── */

function toContent(message: LlmMessage): Content {
  if (message.role === 'tool') {
    return {
      role: 'user',
      parts: [
        {
          functionResponse: {
            name: message.toolName,
            response: { content: message.content, isError: message.isError },
          },
        },
      ],
    };
  }
  return {
    role: message.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: message.content }],
  };
}

function toFunctionDeclaration(tool: {
  name: string;
  description: string;
  parameters: SchemaNode;
}): FunctionDeclaration {
  return {
    name: tool.name,
    description: tool.description,
    parameters: toGeminiSchema(tool.parameters) as FunctionDeclaration['parameters'],
  };
}

function toGeminiSchema(node: SchemaNode): Schema {
  switch (node.type) {
    case 'string':
      return {
        type: SchemaType.STRING,
        description: node.description,
        format: node.enum ? 'enum' : undefined,
        enum: node.enum ? [...node.enum] : undefined,
      } as Schema;
    case 'number':
      return {
        type: node.integer ? SchemaType.INTEGER : SchemaType.NUMBER,
        description: node.description,
      } as Schema;
    case 'boolean':
      return { type: SchemaType.BOOLEAN, description: node.description } as Schema;
    case 'array':
      return {
        type: SchemaType.ARRAY,
        description: node.description,
        items: toGeminiSchema(node.items),
      } as Schema;
    case 'object':
      return {
        type: SchemaType.OBJECT,
        description: node.description,
        properties: Object.fromEntries(
          Object.entries(node.properties).map(([key, child]) => [key, toGeminiSchema(child)]),
        ),
        required: node.required ? [...node.required] : undefined,
      } as Schema;
  }
}

function toFinishReason(reason: string | undefined, hasToolCalls: boolean): FinishReason {
  if (hasToolCalls) return 'tool_calls';
  switch (reason) {
    case 'MAX_TOKENS':
      return 'length';
    case 'SAFETY':
    case 'RECITATION':
    case 'BLOCKLIST':
    case 'PROHIBITED_CONTENT':
      return 'filtered';
    default:
      return 'stop';
  }
}

/** Recovers the HTTP status the SDK folds into its message so retry policy can see it. */
function toProviderError(error: unknown): ProviderError {
  if (error instanceof ProviderError) return error;
  const message = error instanceof Error ? error.message : String(error);
  const status = /\[(\d{3})\s/.exec(message)?.[1] ?? /status[":\s]+(\d{3})/i.exec(message)?.[1];
  return new ProviderError(message, {
    status: status ? Number(status) : undefined,
    cause: error,
  });
}
