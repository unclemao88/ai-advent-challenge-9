import { DeepSeekClient } from './DeepSeekClient.js';

/**
 * The agent depends on this shape only:
 *
 *   {
 *     provider: string, model: string, configured: boolean,
 *     complete(messages, { json }) → Promise<{ content, model, finishReason,
 *                                              usage: { promptTokens, completionTokens, totalTokens } }>
 *   }
 *
 * and on errors that carry a user-safe `message`, an HTTP `status` and a
 * `code`. Another provider is added by implementing the same shape and
 * adding a case here.
 */
export function createLlmClient({ provider = 'deepseek', ...options }) {
  switch (provider) {
    case 'deepseek':
      return new DeepSeekClient(options);
    default:
      throw new Error(`Unknown LLM provider: ${provider}`);
  }
}

export { DeepSeekClient, DeepSeekError } from './DeepSeekClient.js';
