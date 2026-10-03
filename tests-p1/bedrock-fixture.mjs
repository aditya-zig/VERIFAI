import { Model } from '@strands-agents/sdk';

// Controlled model boundary only. The real Strands agent, prompts and finding
// normalization run. This is never live AWS or application verification proof.
export function bedrockFixture(text, inspect = () => {}) {
  return options => new class extends Model {
    getConfig() { return { ...options, contextWindow: 200000 }; }
    updateConfig() {}
    async *stream(messages, streamOptions) {
      inspect(options, messages, streamOptions);
      yield { type: 'modelMessageStartEvent', role: 'assistant' };
      yield { type: 'modelContentBlockStartEvent' };
      yield { type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text } };
      yield { type: 'modelContentBlockStopEvent' };
      yield { type: 'modelMessageStopEvent', stopReason: 'endTurn' };
      yield { type: 'modelMetadataEvent', usage: { inputTokens: 20, outputTokens: 10, totalTokens: 30 } };
    }
  }();
}
